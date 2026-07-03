// test-decay.mjs — unit tests for the retrieval-time memory-decay signal (decay.mjs).
// Pure Node, no framework, no network, no embedding model. Run: node test-decay.mjs
// Covers: neutrality (missing/empty/blank ⇒ factor 1.0 & ranking unchanged), recency/access boost,
// long-unused dampen toward floor, clamp bounds [0.3,1.5], access-update increment+persist,
// and corrupt-file safety. Exits non-zero on any failure.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DECAY, clamp, decayFactor, loadDecayScores, recordAccess } from "./decay.mjs";

// --- tiny inline runner -------------------------------------------------------
let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  deepEqual: (x, y, m) => { assertCount++; assert.deepEqual(x, y, m); },
};
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
}

const DAY = DECAY.DAY_MS;
const NOW = 1_770_000_000_000; // fixed "now" so age-based tests are deterministic
const approx = (x, y, eps = 1e-9) => Math.abs(x - y) <= eps;

// --- shared temp dir ----------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "decay-test-"));
const missingPath = path.join(tmpDir, "does-not-exist.json");
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// ===================== 1. neutrality (backward-compat) ========================

test("missing entry / null / non-object ⇒ factor EXACTLY 1.0", () => {
  a.equal(decayFactor(undefined, NOW), 1.0);
  a.equal(decayFactor(null, NOW), 1.0);
  a.equal(decayFactor("nope", NOW), 1.0);
});

test("blank/neutral entry ⇒ factor EXACTLY 1.0", () => {
  a.equal(decayFactor({}, NOW), 1.0);
  a.equal(decayFactor({ access: 0, lastAccessMs: 0, importance: DECAY.IMPORTANCE_DEFAULT }, NOW), 1.0);
});

test("loadDecayScores: absent / empty / corrupt ⇒ safe { version:1, entries:{} }", () => {
  a.deepEqual(loadDecayScores(missingPath), { version: 1, entries: {} });
  const emptyFile = path.join(tmpDir, "empty.json"); fs.writeFileSync(emptyFile, "   ");
  a.deepEqual(loadDecayScores(emptyFile), { version: 1, entries: {} });
  const braces = path.join(tmpDir, "braces.json"); fs.writeFileSync(braces, "{}");
  a.deepEqual(loadDecayScores(braces), { version: 1, entries: {} });
});

test("empty scores ⇒ every factor 1.0 AND fused ranking is byte-identical", () => {
  // mirrors the exact re-rank hybrid.mjs/deep.mjs perform (run unconditionally here to prove neutrality)
  const items = [
    { rel: "a.md", rrf: 0.0300 }, { rel: "b.md", rrf: 0.0300 }, // tie: order must be preserved
    { rel: "c.md", rrf: 0.0250 }, { rel: "d.md", rrf: 0.0100 },
  ];
  const before = items.slice().sort((x, y) => y.rrf - x.rrf);
  const entries = loadDecayScores(missingPath).entries; // {}
  const after = before.map((r) => ({ ...r })); // clone rrf-ordered list
  for (const r of after) { r.factor = decayFactor(entries[r.rel], NOW); r.score = r.rrf * r.factor; }
  after.sort((x, y) => (y.score ?? y.rrf) - (x.score ?? x.rrf));
  a.ok(after.every((r) => r.factor === 1.0), "all factors 1.0");
  a.ok(after.every((r) => r.score === r.rrf), "score === rrf (x*1.0 is exact)");
  a.deepEqual(after.map((r) => r.rel), before.map((r) => r.rel), "order unchanged, ties preserved");
});

// ===================== 2. recency + frequency boost ===========================

test("recent + frequent ⇒ factor > 1", () => {
  a.ok(decayFactor({ access: 8, lastAccessMs: NOW, importance: 0.5 }, NOW) > 1);
});

test("mild recency (uncapped) lands strictly in (1, 1.5)", () => {
  const f = decayFactor({ access: 0, lastAccessMs: NOW - 45 * DAY, importance: 0.5 }, NOW);
  a.ok(f > 1 && f < DECAY.FACTOR_MAX, `expected (1,1.5), got ${f}`);
});

test("accessBoost matches documented spot values", () => {
  // recency neutral (no lastAccess), importance neutral ⇒ factor == accessBoost
  a.ok(approx(decayFactor({ access: 3, importance: 0.5 }, NOW), 1 + DECAY.ACCESS_K * 2, 1e-9)); // log2(4)=2 ⇒ 1.30
  a.ok(approx(decayFactor({ access: 0, importance: 0.5 }, NOW), 1.0));                            // log2(1)=0 ⇒ 1.00
});

test("factor is monotonically decreasing in age (fixed access/importance)", () => {
  const at = (days) => decayFactor({ access: 2, lastAccessMs: NOW - days * DAY, importance: 0.5 }, NOW);
  a.ok(at(1) > at(60) && at(60) > at(400), "recent > mid > old");
});

// ===================== 3. long-unused dampen toward floor =====================

test("long-unused ⇒ factor < 1 and drifting toward the floor", () => {
  const f = decayFactor({ access: 1, lastAccessMs: NOW - 730 * DAY, importance: 0.5 }, NOW); // ~2 years
  a.ok(f < 1, `expected <1, got ${f}`);
  a.ok(f < 0.5, `expected toward 0.3 floor, got ${f}`);
  a.ok(f >= DECAY.FACTOR_MIN);
});

// ===================== 4. clamp bounds [0.3, 1.5] =============================

test("clamp helper pins to [0.3, 1.5]", () => {
  a.equal(clamp(99, DECAY.FACTOR_MIN, DECAY.FACTOR_MAX), 1.5);
  a.equal(clamp(-5, DECAY.FACTOR_MIN, DECAY.FACTOR_MAX), 0.3);
  a.equal(clamp(0.9, DECAY.FACTOR_MIN, DECAY.FACTOR_MAX), 0.9);
});

test("factor never leaves [0.3, 1.5] across an extreme sweep", () => {
  const cases = [
    { access: 1e9, lastAccessMs: NOW, importance: 1 },              // everything max ⇒ clamps high
    { access: 0, lastAccessMs: NOW - 3650 * DAY, importance: 0 },   // everything min ⇒ clamps low
    { access: 50, lastAccessMs: NOW - 5 * DAY, importance: 0.9 },
    { access: 1, lastAccessMs: NOW - 1000 * DAY, importance: 0.1 },
    {},
  ];
  for (const c of cases) {
    const f = decayFactor(c, NOW);
    a.ok(f >= DECAY.FACTOR_MIN && f <= DECAY.FACTOR_MAX, `out of range: ${f} for ${JSON.stringify(c)}`);
  }
});

test("max clamp is exactly 1.5, min clamp is exactly 0.3", () => {
  a.equal(decayFactor({ access: 1e9, lastAccessMs: NOW, importance: 1 }, NOW), DECAY.FACTOR_MAX);
  a.equal(decayFactor({ access: 0, lastAccessMs: NOW, importance: 0 }, NOW), DECAY.FACTOR_MIN); // weight 0 ⇒ 0 ⇒ floor
});

// ===================== 5. access update: increment + persist ==================

test("recordAccess increments access, stamps lastAccessMs, persists atomically", () => {
  const p = path.join(tmpDir, "scores1.json");
  a.equal(recordAccess(["01-episodic/x.md"], { path: p, nowMs: NOW }), true);
  let store = JSON.parse(fs.readFileSync(p, "utf8"));
  a.equal(store.version, 1);
  a.equal(store.entries["01-episodic/x.md"].access, 1);
  a.equal(store.entries["01-episodic/x.md"].lastAccessMs, NOW);
  a.equal(store.entries["01-episodic/x.md"].importance, DECAY.IMPORTANCE_DEFAULT);

  // second recall bumps to 2 and refreshes lastAccessMs
  a.equal(recordAccess(["01-episodic/x.md"], { path: p, nowMs: NOW + DAY }), true);
  store = JSON.parse(fs.readFileSync(p, "utf8"));
  a.equal(store.entries["01-episodic/x.md"].access, 2);
  a.equal(store.entries["01-episodic/x.md"].lastAccessMs, NOW + DAY);

  // no stray lock/tmp left behind
  a.ok(!fs.existsSync(`${p}.lock`) && !fs.existsSync(`${p}.tmp`));
});

test("recordAccess dedups repeated paths and no-ops on empty input", () => {
  const p = path.join(tmpDir, "scores2.json");
  a.equal(recordAccess(["dup.md", "dup.md", null, ""], { path: p, nowMs: NOW }), true);
  const store = JSON.parse(fs.readFileSync(p, "utf8"));
  a.equal(store.entries["dup.md"].access, 1, "duplicate counted once");
  a.equal(recordAccess([], { path: p, nowMs: NOW }), false);
  a.equal(recordAccess(undefined, { path: p, nowMs: NOW }), false);
});

// ===================== 6. corrupt file ⇒ safe neutral =========================

test("corrupt scores file ⇒ loadDecayScores neutral (no throw), search-safe", () => {
  const p = path.join(tmpDir, "corrupt.json");
  fs.writeFileSync(p, "{ this is not valid json ]]]");
  a.deepEqual(loadDecayScores(p), { version: 1, entries: {} });
  a.equal(decayFactor(loadDecayScores(p).entries["anything"], NOW), 1.0); // neutral factor
});

test("recordAccess over a corrupt file recovers instead of throwing", () => {
  const p = path.join(tmpDir, "corrupt2.json");
  fs.writeFileSync(p, "totally // broken");
  a.equal(recordAccess(["fresh.md"], { path: p, nowMs: NOW }), true); // best-effort: rewrites clean
  const store = JSON.parse(fs.readFileSync(p, "utf8"));
  a.equal(store.entries["fresh.md"].access, 1);
});

// --- report -------------------------------------------------------------------
console.log(`\ntest-decay: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
process.exit(failed ? 1 : 0);
