// test-metrics.mjs — PURE unit tests for the IR metrics (metrics.mjs). No framework, NO network,
// NO embedding/rerank model. Every expected value is hand-computed (derivation in the comments) and,
// for the nDCG decimals, cross-checked with Math.log2 in the same expression so the literal can't drift.
// Run: node test-metrics.mjs   (exits non-zero on any failure)
import assert from "node:assert/strict";
import { recallAtK, precisionAtK, mrr, ndcgAtK, metricsAtK } from "./metrics.mjs";
// Also exercise the PURE parts of the runner (dataset loading + the ranking adapter) — importing
// run-eval.mjs must NOT load node-llama-cpp (it dynamic-imports the model only when embedding), so this
// stays a model-free test. Proves "metrics + dataset-loading are testable without a model".
import { parseDataset, parseCorpus, keywordTerms, rrfMerge, retrieve } from "./run-eval.mjs";

// --- tiny inline runner (async-aware; mirrors test-rerank style) --------------
let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  deepEqual: (x, y, m) => { assertCount++; assert.deepEqual(x, y, m); },
  close: (x, y, m, eps = 1e-9) => { assertCount++; assert.ok(Math.abs(x - y) <= eps, `${m || ""} — got ${x}, want ≈${y}`); },
};
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const L2 = Math.log2;

// ============================================================================
// Case A — PARTIAL hit. retrieved = [d1,d2,d3,d4,d5], relevant = {d2,d4,d6}.
//   d2 is at rank 2, d4 at rank 4, d6 is never retrieved.  |relevant| = 3.
// ============================================================================
const A_ret = ["d1", "d2", "d3", "d4", "d5"];
const A_rel = ["d2", "d4", "d6"];

test("recall@k — partial hits", () => {
  a.close(recallAtK(A_ret, A_rel, 1), 0, "top-1 [d1] has 0 of 3 relevant");
  a.close(recallAtK(A_ret, A_rel, 3), 1 / 3, "top-3 finds d2 → 1/3");
  a.close(recallAtK(A_ret, A_rel, 5), 2 / 3, "top-5 finds d2,d4 → 2/3");
});
test("precision@k — partial hits (divides by k)", () => {
  a.close(precisionAtK(A_ret, A_rel, 1), 0, "top-1 has 0 relevant → 0/1");
  a.close(precisionAtK(A_ret, A_rel, 3), 1 / 3, "1 relevant in top-3 → 1/3");
  a.close(precisionAtK(A_ret, A_rel, 5), 2 / 5, "2 relevant in top-5 → 2/5 = 0.4");
});
test("MRR — first relevant is d2 at rank 2 → 1/2", () => {
  a.close(mrr(A_ret, A_rel), 0.5);
});
test("nDCG@5 — DCG = 1/log2(3)+1/log2(5); IDCG = 1+1/log2(3)+1/log2(4)", () => {
  // DCG:  d2 at rank 2 → 1/log2(3);  d4 at rank 4 → 1/log2(5).
  // IDCG: 3 relevant packed at ranks 1,2,3 → 1/log2(2)+1/log2(3)+1/log2(4).
  const dcg = 1 / L2(3) + 1 / L2(5);
  const idcg = 1 / L2(2) + 1 / L2(3) + 1 / L2(4);
  a.close(ndcgAtK(A_ret, A_rel, 5), dcg / idcg);         // formula cross-check
  a.close(ndcgAtK(A_ret, A_rel, 5), 0.49818925746641285); // hand-computed literal
});

// ============================================================================
// Case B — PERFECT ranking. relevant = {d2,d4}, both at the very top.
//   These are exact-1 checks (independent of decimal arithmetic).
// ============================================================================
const B_ret = ["d2", "d4", "d1", "d3", "d5"];
const B_rel = ["d2", "d4"];

test("perfect ranking — recall/precision/mrr/ndcg all ideal", () => {
  a.close(recallAtK(B_ret, B_rel, 2), 1, "both relevant in top-2");
  a.close(precisionAtK(B_ret, B_rel, 2), 1, "top-2 are both relevant");
  a.close(mrr(B_ret, B_rel), 1, "first result is relevant → rank 1");
  a.close(ndcgAtK(B_ret, B_rel, 2), 1, "ideal ordering → nDCG 1");
  a.close(ndcgAtK(B_ret, B_rel, 5), 1, "extra non-relevant tail doesn't dilute a full-recall ideal head");
});

// ============================================================================
// Case C — ZERO hits. None of the relevant ids appear in `retrieved`.
// ============================================================================
const C_ret = ["d1", "d3", "d5"];
const C_rel = ["d2", "d4"];

test("zero hits — every metric is 0", () => {
  a.close(recallAtK(C_ret, C_rel, 3), 0);
  a.close(precisionAtK(C_ret, C_rel, 3), 0);
  a.close(mrr(C_ret, C_rel), 0);
  a.close(ndcgAtK(C_ret, C_rel, 3), 0);
});

// ============================================================================
// Case D — EMPTY relevant set (degenerate). Documented vacuous convention:
//   recall = 1, ndcg = 1, precision = 0, mrr = 0.
// ============================================================================
test("empty relevant — vacuous recall/ndcg = 1, precision/mrr = 0", () => {
  const ret = ["d1", "d2"];
  a.close(recallAtK(ret, [], 5), 1, "0 of 0 relevant found → 1");
  a.close(ndcgAtK(ret, [], 5), 1, "empty relevant → ideal by convention");
  a.close(precisionAtK(ret, [], 5), 0, "nothing relevant ⇒ no hit possible");
  a.close(mrr(ret, []), 0, "no relevant item to rank");
});

// ============================================================================
// Case E — k > retrieved.length. retrieved = [d1,d2], relevant = {d2}, k = 5.
//   recall counts real hits; precision still divides by k (empty slots = misses).
// ============================================================================
const E_ret = ["d1", "d2"];
const E_rel = ["d2"];

test("k > len(retrieved) — recall over real hits, precision divides by k", () => {
  a.close(recallAtK(E_ret, E_rel, 5), 1, "d2 found → 1/1");
  a.close(precisionAtK(E_ret, E_rel, 5), 1 / 5, "1 hit but k=5 slots → 1/5 = 0.2");
  a.close(mrr(E_ret, E_rel), 0.5, "d2 at rank 2");
  a.close(ndcgAtK(E_ret, E_rel, 5), 1 / L2(3), "DCG=1/log2(3), IDCG=1 → 0.6309…");
  a.close(ndcgAtK(E_ret, E_rel, 5), 0.6309297535714575, "hand-computed literal");
});

// ============================================================================
// Case F — k <= 0 guard. Nothing is examined ⇒ recall/precision/ndcg = 0.
// ============================================================================
test("k <= 0 — recall/precision/ndcg = 0 (mrr is k-independent)", () => {
  a.close(recallAtK(E_ret, E_rel, 0), 0);
  a.close(precisionAtK(E_ret, E_rel, 0), 0);
  a.close(ndcgAtK(E_ret, E_rel, 0), 0);
  a.close(mrr(E_ret, E_rel), 0.5, "mrr ignores k");
});

// ============================================================================
// Case G — DUPLICATE ids in `retrieved` must not create phantom hits.
//   retrieved = [d2,d2], relevant = {d2,d4}: d2 counts once, d4 is missing.
// ============================================================================
test("duplicate retrieved ids — counted once, not twice", () => {
  a.close(recallAtK(["d2", "d2"], ["d2", "d4"], 2), 0.5, "only d2 found (once) of 2 relevant");
  a.close(precisionAtK(["d2", "d2"], ["d2", "d4"], 2), 0.5, "1 unique hit / k=2");
});

// ============================================================================
// Extra — `relevant` accepted as a Set, and metricsAtK bundles the four.
// ============================================================================
test("relevant accepted as a Set; metricsAtK bundles all four", () => {
  a.close(recallAtK(A_ret, new Set(A_rel), 5), 2 / 3, "Set input works like Array");
  const m = metricsAtK(A_ret, A_rel, 5);
  a.close(m.recall, 2 / 3);
  a.close(m.precision, 2 / 5);
  a.close(m.mrr, 0.5);
  a.close(m.ndcg, 0.49818925746641285);
});

// ============================================================================
// Runner internals — PURE dataset loading + the ranking adapter, tested WITHOUT a model.
// (These import from run-eval.mjs, which must not pull node-llama-cpp on import.)
// ============================================================================
test("parseDataset — keeps valid lines, skips comments/blank/malformed/empty-relevant", () => {
  const text = [
    "# a comment",
    "",
    '{"query":"q one","relevant":["m1","m2"]}',
    '{"query":"q two","relevant":[]}',        // empty relevant → skipped
    '{"query":"","relevant":["m3"]}',         // empty query    → skipped
    "{not json}",                             // malformed      → skipped
    '{"query":"q three","relevant":["m4"]}',
  ].join("\n");
  const ds = parseDataset(text);
  a.equal(ds.queries.length, 2, "only the two well-formed queries survive");
  a.equal(ds.skipped, 3, "empty-relevant + empty-query + malformed all skipped");
  a.deepEqual(ds.queries[0].relevant, ["m1", "m2"], "relevant parsed");
  a.ok(ds.warnings.length >= 3, "one warning per skipped line");
});

test("parseCorpus — reads JSONL rows and ignores comments/blank", () => {
  const rows = parseCorpus('# hdr\n\n{"id":"a","text":"alpha"}\n{"id":"b","text":"beta","type":"note"}');
  a.equal(rows.length, 2);
  a.equal(rows[0].id, "a");
  a.equal(rows[1].text, "beta");
});

test("keywordTerms — lowercases, drops stopwords + short tokens", () => {
  a.deepEqual(keywordTerms("What is the ReRanker?"), ["reranker"], "stopwords/short dropped, lowercased");
});

test("rrfMerge — semantic-only ranks by cosine order; ids come out sorted", () => {
  const chunks = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const merged = rrfMerge(chunks, [1.0, 0.0, 0.7], null); // sem scores: a>c>b
  a.deepEqual(merged.map((r) => chunks[r.i].id), ["a", "c", "b"], "RRF over semantic order");
});

test("retrieve (adapter) — PURE semantic path with fake vectors, no model", async () => {
  const index = { chunks: [
    { id: "a", text: "alpha", vector: [1, 0] },
    { id: "b", text: "beta", vector: [0, 1] },
    { id: "c", text: "both", vector: [0.7, 0.7] },
  ] };
  const ids = await retrieve("q", index, { mode: "semantic", qVec: [1, 0] });
  a.deepEqual(ids, ["a", "c", "b"], "closest cosine first (a), then c, then b");
});

test("retrieve (adapter) — dedups chunks that share a memory id (first/best wins)", async () => {
  const index = { chunks: [
    { id: "x", text: "t1", vector: [1, 0] },
    { id: "x", text: "t2", vector: [1, 0] }, // same id, second chunk
    { id: "y", text: "t3", vector: [0, 1] },
  ] };
  const ids = await retrieve("q", index, { mode: "semantic", qVec: [1, 0] });
  a.deepEqual(ids, ["x", "y"], "x appears once despite two chunks");
});

test("retrieve (adapter) — keyword path needs no vectors/qVec (model-free)", async () => {
  const index = { chunks: [{ id: "a", text: "apple pie" }, { id: "b", text: "banana bread" }] };
  const ids = await retrieve("apple", index, { mode: "keyword" });
  a.equal(ids[0], "a", "keyword hit ranks first with no embeddings at all");
});

// --- run + report ------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
  }
  console.log(`\ntest-metrics: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
  process.exit(failed ? 1 : 0);
})();
