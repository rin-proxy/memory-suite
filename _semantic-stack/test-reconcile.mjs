// test-reconcile.mjs — unit tests for the PURE write-time reconciliation core (reconcile.mjs).
// Pure Node, no framework, no network, NO embedding model (never imports common.mjs / node-llama-cpp).
// Synthetic unit vectors give exact, controllable cosines. Covers: skip / review / new bucketing,
// HIGH & MID threshold boundaries (just-above / just-below / inclusive), empty index ⇒ new, guard on a
// missing candidate vector ⇒ new, ranking + topK cap, match shape, snippet cleanup, the agent-driven
// verdict prompt, and malformed/mismatched-dimension vectors being skipped. Exits non-zero on any failure.
import assert from "node:assert/strict";
import { cosine } from "./store.mjs";
import { reconcile, RECONCILE } from "./reconcile.mjs";

// --- tiny inline runner -------------------------------------------------------
let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
};
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
}

// --- synthetic vectors: REF and unit vectors at a chosen cosine to REF --------
const REF = [1, 0];
const at = (c) => [c, Math.sqrt(1 - c * c)]; // cosine(REF, at(c)) === c (within float epsilon)
const ex = (path, c, text) => ({ path, vector: at(c), text: text == null ? `body of ${path}` : text });

// ============================ 1. bucketing (defaults) =========================

test("near-identical (≥ default HIGH 0.95) ⇒ skip, no verdict prompt", () => {
  const r = reconcile(REF, [ex("dup.md", 0.99, "duplicate body")], { candidateText: "cand" });
  a.equal(r.action, "skip");
  a.ok(r.topScore >= RECONCILE.HIGH, `topScore ${r.topScore} ≥ HIGH`);
  a.equal(r.verdictPrompt, null, "skip is deterministic — no agent verdict");
  a.equal(r.matches[0].path, "dup.md", "skip names the duplicate");
});

test("mid-similar (default [0.85,0.95)) ⇒ review with matches + agent verdict prompt", () => {
  const r = reconcile(REF, [ex("sim.md", 0.90, "similar body")], { candidateText: "CAND_XYZ" });
  a.equal(r.action, "review");
  a.ok(r.topScore >= RECONCILE.MID && r.topScore < RECONCILE.HIGH, `topScore ${r.topScore} in band`);
  a.equal(r.matches[0].path, "sim.md");
  a.ok(typeof r.verdictPrompt === "string" && r.verdictPrompt.length > 0, "review hands a prompt to the agent");
});

test("dissimilar (< default MID 0.85) ⇒ new, no matches, no prompt", () => {
  const r = reconcile(REF, [ex("far.md", 0.20)], { candidateText: "cand" });
  a.equal(r.action, "new");
  a.equal(r.matches.length, 0);
  a.equal(r.verdictPrompt, null);
  a.ok(r.topScore > 0 && r.topScore < RECONCILE.MID, `topScore ${r.topScore} below MID`);
});

// ===================== 2. agent-driven verdict prompt (provider-free) =========

test("verdict prompt embeds the candidate + match path + the 4-way menu (no external model)", () => {
  const r = reconcile(REF, [ex("notes/a.md", 0.90, "existing note body")], { candidateText: "CAND_XYZ text" });
  const p = r.verdictPrompt;
  a.ok(p.includes("CAND_XYZ text"), "candidate text is shown to the judging agent");
  a.ok(p.includes("notes/a.md"), "the similar existing note is shown");
  a.ok(p.includes("DUPLICATE") && p.includes("UPDATE") && p.includes("CONTRADICTION") && p.includes("DISTINCT"),
    "all four verdicts offered");
  a.ok(/no external model/i.test(p), "prompt states no external model is consulted");
});

// ============================ 3. HIGH boundary ================================
// Use the measured cosine so comparisons are exact regardless of float representation.

test("HIGH boundary: just-above ⇒ skip, just-below (≥MID) ⇒ review", () => {
  const v = at(0.90);
  const s = cosine(REF, v); // ≈ 0.90, exact value reconcile() will also compute
  const one = [{ path: "p.md", vector: v, text: "t" }];
  a.equal(reconcile(REF, one, { high: s - 1e-6, mid: 0.5 }).action, "skip", "score just ABOVE high ⇒ skip");
  a.equal(reconcile(REF, one, { high: s + 1e-6, mid: s - 1e-6 }).action, "review", "score just BELOW high ⇒ review");
});

test("HIGH boundary is inclusive: score exactly == HIGH ⇒ skip", () => {
  // identical vectors ⇒ cosine exactly 1.0 (integer arithmetic, no float wobble)
  a.equal(reconcile([3, 4], [{ path: "id.md", vector: [3, 4], text: "t" }], { high: 1.0, mid: 0.5 }).action, "skip");
});

// ============================ 4. MID boundary ================================

test("MID boundary: just-above ⇒ review, just-below ⇒ new, exactly-MID ⇒ review (inclusive)", () => {
  const v = at(0.87);
  const s = cosine(REF, v);
  const one = [{ path: "p.md", vector: v, text: "t" }];
  a.equal(reconcile(REF, one, { high: 0.99, mid: s - 1e-6 }).action, "review", "just above MID ⇒ review");
  a.equal(reconcile(REF, one, { high: 0.99, mid: s + 1e-6 }).action, "new", "just below MID ⇒ new");
  a.equal(reconcile(REF, one, { high: 0.99, mid: s }).action, "review", "exactly MID ⇒ review (>= is inclusive)");
});

// ============================ 5. empty / guard ⇒ new ==========================

test("empty index ⇒ new (nothing to compare against)", () => {
  const r = reconcile(REF, [], { candidateText: "cand" });
  a.equal(r.action, "new");
  a.equal(r.matches.length, 0);
  a.equal(r.topScore, 0);
  a.equal(r.verdictPrompt, null);
});

test("missing/invalid candidate vector ⇒ new (never block a store)", () => {
  const existing = [ex("dup.md", 0.99)]; // would otherwise be a skip
  a.equal(reconcile(null, existing).action, "new");
  a.equal(reconcile(undefined, existing).action, "new");
  a.equal(reconcile([], existing).action, "new");
  a.equal(reconcile("nope", existing).action, "new");
});

// ============================ 6. ranking + topK ==============================

test("matches are ranked by cosine descending, mapped to the right paths", () => {
  const r = reconcile(REF, [ex("b.md", 0.88), ex("a.md", 0.94), ex("c.md", 0.90)], { candidateText: "cand" });
  a.equal(r.action, "review"); // all three in [0.85, 0.95)
  a.equal(r.matches.map((m) => m.path).join(","), "a.md,c.md,b.md", "sorted 0.94 > 0.90 > 0.88");
  a.ok(r.matches[0].score >= r.matches[1].score && r.matches[1].score >= r.matches[2].score, "monotonic desc");
});

test("topK caps the number of reported matches (default and custom)", () => {
  const many = [];
  for (let i = 0; i < 7; i++) many.push(ex(`m${i}.md`, 0.90)); // 7 all ≥ MID
  a.equal(reconcile(REF, many, { candidateText: "c" }).matches.length, RECONCILE.TOP_K, "default cap");
  a.equal(reconcile(REF, many, { candidateText: "c", topK: 2 }).matches.length, 2, "custom cap");
});

// ============================ 7. match shape + snippet =======================

test("each match has exactly {path, score, snippet} of the right types", () => {
  const r = reconcile(REF, [ex("s.md", 0.90, "hello world")], { candidateText: "c" });
  const m = r.matches[0];
  a.equal(typeof m.path, "string");
  a.equal(typeof m.score, "number");
  a.equal(typeof m.snippet, "string");
  a.equal(Object.keys(m).sort().join(","), "path,score,snippet", "no extra keys");
});

test("snippet collapses whitespace, trims, and caps at snippetLen", () => {
  const messy = "alpha\n\n\tbeta   gamma\n" + "x".repeat(400);
  const r = reconcile(REF, [{ path: "s.md", vector: at(0.90), text: messy }], { candidateText: "c" });
  const sn = r.matches[0].snippet;
  a.ok(sn.startsWith("alpha beta gamma"), `collapsed: ${sn.slice(0, 20)}`);
  a.ok(!/\s\s/.test(sn) && !sn.includes("\n") && !sn.includes("\t"), "no runs of whitespace / newlines / tabs");
  a.ok(sn.length <= RECONCILE.SNIPPET_LEN, `default cap: ${sn.length} ≤ ${RECONCILE.SNIPPET_LEN}`);
  a.ok(reconcile(REF, [{ path: "s.md", vector: at(0.90), text: messy }], { snippetLen: 10 }).matches[0].snippet.length <= 10,
    "custom snippetLen honored");
});

// ============================ 8. robustness ==================================

test("malformed / mismatched-dimension vectors are skipped, not crashed on", () => {
  const existing = [
    { path: "3d.md", vector: [1, 0, 0], text: "wrong dim" }, // dim 3 vs candidate dim 2 → skipped
    { path: "null.md", vector: null, text: "x" },            // not an array → skipped
    { path: "empty.md", vector: [], text: "y" },             // empty → skipped
    ex("ok.md", 0.90),                                        // the only comparable one
  ];
  const r = reconcile(REF, existing, { candidateText: "c" });
  a.equal(r.action, "review");
  a.equal(r.matches.length, 1, "only the same-dimension vector counts");
  a.equal(r.matches[0].path, "ok.md");
});

test("recommendation is a non-empty string and thresholds are echoed in every branch", () => {
  const skip = reconcile(REF, [ex("d.md", 0.99)], { high: 0.95, mid: 0.85 });
  const review = reconcile(REF, [ex("s.md", 0.90)], { high: 0.95, mid: 0.85 });
  const fresh = reconcile(REF, [ex("f.md", 0.10)], { high: 0.95, mid: 0.85 });
  for (const r of [skip, review, fresh]) {
    a.ok(typeof r.recommendation === "string" && r.recommendation.length > 0, "has a recommendation");
    a.ok(r.thresholds.high === 0.95 && r.thresholds.mid === 0.85, "effective thresholds echoed");
  }
});

// --- report -------------------------------------------------------------------
console.log(`\ntest-reconcile: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
process.exit(failed ? 1 : 0);
