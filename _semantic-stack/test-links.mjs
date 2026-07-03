// test-links.mjs — unit tests for the PURE provider-free link layer (links.mjs).
// Pure Node, no framework, NO network, NO embedding model (never imports common.mjs / node-llama-cpp).
// Synthetic UNIT vectors give exact, controllable cosines; synthetic dates give exact temporal gaps.
// Covers, for buildLinks: semantic linking inside the band, near-duplicates excluded, temporal linking
// (+ window), entity linking (+ agent-supplied / base-works-without), corroboration raises weight,
// monotonic weight across the band, FLOOR/CEIL boundaries, empty/singleton ⇒ []; and for
// connectCandidates: MMR surfaces relevant-but-DISSIMILAR over a near-duplicate (λ matters), seed-band
// gating, reasons, and empty guards ⇒ []. Exits non-zero on any failure.
import assert from "node:assert/strict";
import { cosine } from "./store.mjs";
import { buildLinks, connectCandidates, LINKS } from "./links.mjs";

// --- tiny inline runner -------------------------------------------------------
let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  deepEqual: (x, y, m) => { assertCount++; assert.deepEqual(x, y, m); },
  approx: (x, y, tol, m) => { assertCount++; assert.ok(Math.abs(x - y) <= (tol ?? 1e-9), `${m || ""} (|${x}-${y}| > ${tol ?? 1e-9})`); },
};
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
}

// --- synthetic vectors --------------------------------------------------------
const REF = [1, 0];
const unit = (c) => [c, Math.sqrt(1 - c * c)]; // cosine(REF, unit(c)) === c (both unit vectors)
// chunk helpers
const vc = (c, extra = {}) => ({ vector: unit(c), ...extra });     // a chunk at cosine c to REF
const ref = (extra = {}) => ({ vector: REF, ...extra });

// ============================ 1. semantic band ================================

test("semantic: an in-band pair (0.60) links with a SEMANTIC-only signal, positive weight", () => {
  const links = buildLinks([ref({ id: "A" }), vc(0.60, { id: "B" })]);
  a.equal(links.length, 1, "one edge");
  a.deepEqual(links[0].signals, ["semantic"], "semantic only (no ts / no entities)");
  a.approx(links[0].sim, 0.60, 1e-9, "cosine ≈ 0.60");
  a.ok(links[0].weight > 0, "positive weight");
  a.ok(typeof links[0].reason === "string" && links[0].reason.includes("cosine"), "reason describes the link");
});

test("near-duplicate (0.97) is EXCLUDED even when written the same day (redundancy, not a connection)", () => {
  const links = buildLinks([ref({ id: "A", date: "2026-01-01" }), vc(0.97, { id: "B", date: "2026-01-01" })]);
  a.equal(links.length, 0, "no edge for a near-duplicate pair");
});

test("below the floor (0.20) with no other signal ⇒ no edge", () => {
  a.equal(buildLinks([ref({ id: "A" }), vc(0.20, { id: "B" })]).length, 0);
});

// ============================ 2. temporal =====================================

test("temporal: dissimilar (0.20) but written 3 days apart ⇒ a TEMPORAL-only edge", () => {
  const links = buildLinks([ref({ id: "A", date: "2026-01-01" }), vc(0.20, { id: "B", date: "2026-01-04" })]);
  a.equal(links.length, 1, "temporal proximity alone forms an edge");
  a.deepEqual(links[0].signals, ["temporal"], "temporal only (0.20 is below the semantic floor)");
  a.approx(links[0].dtDays, 3, 1e-6, "3-day gap");
  a.approx(links[0].weight, LINKS.W_TEMPORAL * (1 - 3 / LINKS.TEMPORAL_WINDOW_DAYS), 1e-9, "temporal weight");
});

test("temporal window: 0.20 + ~120 days apart ⇒ no edge (outside the window)", () => {
  a.equal(buildLinks([ref({ date: "2026-01-01" }), vc(0.20, { date: "2026-05-01" })]).length, 0);
});

// ============================ 3. corroboration ================================

test("corroboration: semantic + temporal weighs STRICTLY MORE than the same similarity alone", () => {
  const solo = buildLinks([ref({}), vc(0.60, {})])[0];
  const both = buildLinks([ref({ date: "2026-01-01" }), vc(0.60, { date: "2026-01-02" })])[0];
  a.deepEqual(both.signals, ["semantic", "temporal"], "both signals fire");
  a.ok(both.weight > solo.weight, `corroborated ${both.weight} > solo ${solo.weight}`);
});

// ============================ 4. entities (optional) ==========================

test("entity: agent-supplied shared entity links two dissimilar notes (case-insensitive)", () => {
  const links = buildLinks([
    ref({ id: "A", entities: ["Acme"] }),
    vc(0.20, { id: "B", entities: ["acme", "unrelated"] }),
  ]);
  a.equal(links.length, 1, "shared entity forms an edge");
  a.deepEqual(links[0].signals, ["entity"], "entity only (0.20 sub-floor, no dates)");
  a.deepEqual(links[0].sharedEntities, ["acme"], "normalized shared entity");
});

test("entities disabled ⇒ that same sub-floor/no-date pair does NOT link (entities are opt-in)", () => {
  const chunks = [ref({ entities: ["Acme"] }), vc(0.20, { entities: ["acme"] })];
  a.equal(buildLinks(chunks, { entities: false }).length, 0, "entity signal off ⇒ nothing links them");
});

test("BASE auto-linking works WITHOUT entities: two in-band notes still link on similarity alone", () => {
  const links = buildLinks([ref({}), vc(0.60, {})]); // no entities anywhere
  a.equal(links.length, 1);
  a.deepEqual(links[0].signals, ["semantic"]);
});

// ============================ 5. threshold bands ==============================

test("weight is monotonic across the band: a stronger similarity links more strongly", () => {
  const low = buildLinks([ref({}), vc(0.45, {})])[0].weight;
  const high = buildLinks([ref({}), vc(0.80, {})])[0].weight;
  a.ok(high > low, `weight(0.80)=${high} > weight(0.45)=${low}`);
});

test("FLOOR boundary: inclusive at floor, excluded just below (measured cosine)", () => {
  const v = unit(0.45); const s = cosine(REF, v);
  const pair = [ref({}), { vector: v }];
  a.equal(buildLinks(pair, { simFloor: s, simCeil: 0.99 }).length, 1, "== floor ⇒ linked (>= inclusive)");
  a.equal(buildLinks(pair, { simFloor: s + 1e-6, simCeil: 0.99 }).length, 0, "just below floor ⇒ no edge");
});

test("CEIL boundary: excluded at/above ceil, included just below (measured cosine)", () => {
  const v = unit(0.80); const s = cosine(REF, v);
  const pair = [ref({}), { vector: v }];
  a.equal(buildLinks(pair, { simFloor: 0.1, simCeil: s }).length, 0, ">= ceil ⇒ near-dup excluded");
  a.equal(buildLinks(pair, { simFloor: 0.1, simCeil: s + 1e-6 }).length, 1, "just below ceil ⇒ linked");
});

// ============================ 6. graph hygiene ================================

test("empty / singleton / non-array ⇒ [] (nothing to link)", () => {
  a.deepEqual(buildLinks([]), []);
  a.deepEqual(buildLinks([ref({})]), []);
  a.deepEqual(buildLinks("nope"), []);
});

test("maxPerNode caps fan-out per node", () => {
  // C links to both leaves (cos 0.6); the leaves are anti-correlated (cos -0.28 < floor) so no leaf–leaf edge.
  const C = { id: "C", vector: [1, 0] };
  const L1 = { id: "L1", vector: [0.6, 0.8] };
  const L2 = { id: "L2", vector: [0.6, -0.8] };
  a.equal(buildLinks([C, L1, L2], { maxPerNode: Infinity }).length, 2, "uncapped: both C-edges");
  const capped = buildLinks([C, L1, L2], { maxPerNode: 1 });
  a.equal(capped.length, 1, "cap 1: C keeps only its single strongest edge");
});

test("malformed / mismatched-dimension vectors are skipped, not crashed on", () => {
  const chunks = [
    { id: "ok1", vector: [1, 0] },
    { id: "bad3d", vector: [1, 0, 0] }, // dim 3 vs 2 ⇒ skipped against 2-d peers
    { id: "null", vector: null },
    { id: "ok2", vector: unit(0.60) },
  ];
  const links = buildLinks(chunks);
  a.equal(links.length, 1, "only the two compatible 2-d vectors link");
  a.ok((links[0].a === "ok1" && links[0].b === "ok2"), "the compatible pair");
});

// ================= 7. connectCandidates — MMR diversity (the cross-domain fix) =================
// 3-D vectors so seed-relevance and mutual-redundancy are controlled INDEPENDENTLY.
//   S seed. A: rel 0.80 (the anchor). P: rel 0.78 but a NEAR-DUP of A (cos 0.99). Q: rel 0.55 yet
//   DISSIMILAR to A (cos 0.44). Pure top-k/relevance ranks A,P,Q; MMR must prefer Q over P after A.
const S = [1, 0, 0];
const A = { id: "A", type: "pattern", vector: [0.8, 0.6, 0] };
const P = { id: "P", type: "pattern", vector: [0.78, 0.61, 0.139642] };   // cos(S,P)=0.78, cos(A,P)≈0.99
const Q = { id: "Q", type: "behavior", vector: [0.55, 0, 0.835165] };     // cos(S,Q)=0.55, cos(A,Q)=0.44

test("MMR (λ=0.5) surfaces the dissimilar-but-relevant Q over the near-duplicate P", () => {
  const out = connectCandidates(S, [A, P, Q], { k: 2, lambda: 0.5 });
  a.equal(out.length, 2, "top-2");
  a.equal(out[0].id, "A", "anchor = most seed-relevant");
  a.equal(out[1].id, "Q", "then the DIVERSE candidate, not the near-duplicate P");
  a.ok(!out.some((c) => c.id === "P"), "the near-duplicate P is kept out of the top-2");
});

test("pure relevance (λ=0) instead ranks the near-duplicate P second — proving λ drives diversity", () => {
  const out = connectCandidates(S, [A, P, Q], { k: 2, lambda: 0 });
  a.deepEqual(out.map((c) => c.id), ["A", "P"], "λ=0 ⇒ plain top-k by relevance");
});

test("MMR default λ places P last of three (redundancy penalty demotes the near-duplicate)", () => {
  const out = connectCandidates(S, [A, P, Q], { k: 3 });
  a.deepEqual(out.map((c) => c.id), ["A", "Q", "P"], "diverse Q ahead of redundant P");
  a.ok(out[1].redundancy < out[2].redundancy, "P carries the higher redundancy");
});

test("candidates carry a reason and their real relevance; type is a LABEL, never a gate", () => {
  const out = connectCandidates(S, [A, P, Q], { k: 3 });
  for (const c of out) {
    a.ok(typeof c.reason === "string" && c.reason.includes("seed-relevant"), "each candidate explains itself");
    a.ok(c.rel >= LINKS.SIM_FLOOR && c.rel < LINKS.SIM_CEIL, "rel sits in the candidate band");
  }
  a.equal(out.find((c) => c.id === "Q").type, "behavior", "cross-type Q surfaced beside type:pattern A (no domain=type demotion)");
});

// ================= 8. connectCandidates — band gating + guards =================

test("seed-band gating: near-restatement (rel≥ceil) AND unrelated (rel<floor) are both dropped", () => {
  const dup = { id: "DUP", vector: unit3(S, 0.97) };  // ~restates the seed
  const far = { id: "FAR", vector: unit3(S, 0.10) };  // unrelated
  const mid = { id: "MID", type: "pattern", vector: unit3(S, 0.60) };
  const out = connectCandidates(S, [dup, far, mid], { k: 5 });
  a.equal(out.length, 1, "only the mid-band candidate survives");
  a.equal(out[0].id, "MID");
});

test("guards ⇒ [] : no seed vector, no chunks, or nothing in band", () => {
  a.deepEqual(connectCandidates([], [A, P, Q]), [], "no seed ⇒ []");
  a.deepEqual(connectCandidates(S, []), [], "no chunks ⇒ []");
  a.deepEqual(connectCandidates(S, [{ id: "z", vector: unit3(S, 0.10) }]), [], "all sub-floor ⇒ []");
});

// build a 3-D unit vector at a chosen cosine to a reference axis-ish seed [1,0,0]
function unit3(seed, c) {
  // seed here is [1,0,0]; a vector [c, sqrt(1-c^2), 0] has cosine c to it.
  void seed;
  return [c, Math.sqrt(1 - c * c), 0];
}

// --- report -------------------------------------------------------------------
console.log(`\ntest-links: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
process.exit(failed ? 1 : 0);
