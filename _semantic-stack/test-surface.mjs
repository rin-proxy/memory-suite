// test-surface.mjs — pure tests for surface.mjs (no embedding model, no network).
import assert from "node:assert/strict";
import { surfaceCandidates } from "./surface.mjs";

let pass = 0, fail = 0, asserts = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function a(cond, msg) { asserts++; assert.ok(cond, msg); }
function aeq(x, y, msg) { asserts++; assert.equal(x, y, msg); }

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch → deterministic
const ago = (days) => NOW - days * DAY;
const scoresOf = (entries) => ({ version: 1, entries });

t("empty entries => []", () => {
  aeq(surfaceCandidates(scoresOf({}), { now: NOW }).length, 0);
});
t("missing/corrupt scores => [] (no throw)", () => {
  aeq(surfaceCandidates(null, { now: NOW }).length, 0);
  aeq(surfaceCandidates(undefined, { now: NOW }).length, 0);
  aeq(surfaceCandidates({}, { now: NOW }).length, 0);
  aeq(surfaceCandidates({ entries: "nope" }, { now: NOW }).length, 0);
});
t("entry without lastAccessMs is skipped", () => {
  aeq(surfaceCandidates(scoresOf({ a: { access: 1, importance: 0.9 } }), { now: NOW }).length, 0);
});
t("staleness rises with age: older ranks higher", () => {
  const r = surfaceCandidates(scoresOf({
    fresh: { access: 1, importance: 0.5, lastAccessMs: ago(1) },
    old:   { access: 1, importance: 0.5, lastAccessMs: ago(120) },
  }), { now: NOW });
  aeq(r[0].relPath, "old");
});
t("importance weighting: higher importance ranks higher (same age/access)", () => {
  const r = surfaceCandidates(scoresOf({
    lo: { access: 1, importance: 0.3, lastAccessMs: ago(60) },
    hi: { access: 1, importance: 0.9, lastAccessMs: ago(60) },
  }), { now: NOW });
  aeq(r[0].relPath, "hi");
});
t("neglect: frequently-recalled ranks lower (same age/importance)", () => {
  const r = surfaceCandidates(scoresOf({
    rare:   { access: 1,  importance: 0.6, lastAccessMs: ago(60) },
    common: { access: 20, importance: 0.6, lastAccessMs: ago(60) },
  }), { now: NOW });
  aeq(r[0].relPath, "rare");
});
t("stale+important+rare outranks fresh+frequent", () => {
  const r = surfaceCandidates(scoresOf({
    forgotten: { access: 1,  importance: 0.9, lastAccessMs: ago(90) },
    familiar:  { access: 30, importance: 0.9, lastAccessMs: ago(1) },
  }), { now: NOW });
  aeq(r[0].relPath, "forgotten");
});
t("--top limit respected", () => {
  const entries = {};
  for (let i = 0; i < 10; i++) entries["f" + i] = { access: 1, importance: 0.6, lastAccessMs: ago(30 + i) };
  aeq(surfaceCandidates(scoresOf(entries), { now: NOW, top: 3 }).length, 3);
});
t("importance 0 => excluded (score 0)", () => {
  aeq(surfaceCandidates(scoresOf({ z: { access: 1, importance: 0, lastAccessMs: ago(100) } }), { now: NOW }).length, 0);
});
t("just-accessed => ~0 staleness => excluded", () => {
  aeq(surfaceCandidates(scoresOf({ z: { access: 1, importance: 0.9, lastAccessMs: NOW } }), { now: NOW }).length, 0);
});
t("too-fresh (< MIN_AGE_DAYS) => excluded even if important", () => {
  aeq(surfaceCandidates(scoresOf({ z: { access: 1, importance: 0.95, lastAccessMs: ago(2) } }), { now: NOW }).length, 0);
});
t("result carries reason + fields", () => {
  const r = surfaceCandidates(scoresOf({ a: { access: 2, importance: 0.8, lastAccessMs: ago(45) } }), { now: NOW });
  a(r[0].reason.includes("45d"), "reason mentions age");
  aeq(r[0].access, 2, "carries access");
  a(r[0].score > 0, "positive score");
  a(r[0].reason.includes("2 recalls"), "pluralizes recalls");
});
t("scores sorted descending", () => {
  const r = surfaceCandidates(scoresOf({
    a: { access: 1, importance: 0.9, lastAccessMs: ago(100) },
    b: { access: 1, importance: 0.4, lastAccessMs: ago(10) },
    c: { access: 5, importance: 0.6, lastAccessMs: ago(50) },
  }), { now: NOW });
  for (let i = 1; i < r.length; i++) a(r[i - 1].score >= r[i].score, "descending");
});

console.log(`\ntest-surface: ${pass} passed, ${fail} failed  (${pass + fail} tests, ${asserts} assertions)`);
process.exit(fail ? 1 : 0);
