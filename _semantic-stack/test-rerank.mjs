// test-rerank.mjs — unit tests for the OPTIONAL cross-encoder rerank stage (rerank.mjs).
// PURE Node: no framework, NO network, NO embedding/reranker model. All cross-encoder scores are
// injected as deterministic mocks (opts.scoreFn), so nothing here loads node-llama-cpp or a GGUF.
// Run: node test-rerank.mjs
// Covers: flag gating (off by default), model-path resolution + availability (pure fs), the pure
// two-stage merge (reorders by score, stable on ties, tail untouched, safe on empty/absent scores),
// the orchestrator with a mock reranker (reorders, top-k respected, correct text/query wiring), and
// the BACKWARD-COMPAT contract (off / unavailable / error ⇒ order IDENTICAL & same array reference).
import assert from "node:assert/strict";
import {
  RERANK, isRerankEnabled, rerankModelPath, rerankAvailable, twoStageRerank, rerankStage,
} from "./rerank.mjs";

// --- tiny inline runner (async-aware) ----------------------------------------
let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  deepEqual: (x, y, m) => { assertCount++; assert.deepEqual(x, y, m); },
};
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- fixtures ----------------------------------------------------------------
// Stage-1 (RRF + decay) ordered candidates. `text` is a 1-char label; the mock scorer maps it → score.
const mkRanked = (labels) => labels.map((t, n) => ({ i: n, rrf: 1 / (n + 1), text: t }));
const labels = (arr) => arr.map((r) => r.text);
const getText = (r) => r.text;
// A deterministic "cross-encoder": higher score = more relevant. Absent label ⇒ 0.
const SCORE = { A: 0.10, B: 0.90, C: 0.50, D: 0.30, E: 0.70, F: 0.20 };
const mockScore = (_q, texts) => texts.map((t) => (t in SCORE ? SCORE[t] : 0));

// ===================== 1. gating — OFF by default ============================

test("isRerankEnabled: OFF by default; env/flag/explicit toggles", () => {
  a.equal(isRerankEnabled({ env: {} }), false, "no env, no flag ⇒ off");
  a.equal(isRerankEnabled({ env: {}, rerank: true }), true, "--rerank ⇒ on");
  a.equal(isRerankEnabled({ env: { RERANK: "1" } }), true, "RERANK=1 ⇒ on");
  a.equal(isRerankEnabled({ env: { RERANK: "0" } }), false, "RERANK=0 ⇒ off");
  a.equal(isRerankEnabled({ env: { RERANK: "1" }, enabled: false }), false, "explicit enabled:false overrides");
  a.equal(isRerankEnabled({ env: {}, enabled: true }), true, "explicit enabled:true");
});

// ===================== 2. model path + availability (pure fs) ================

test("rerankModelPath: explicit > $RERANK_MODEL > default under workspace", () => {
  a.equal(rerankModelPath({ modelPath: "/x/y.gguf" }), "/x/y.gguf");
  a.equal(rerankModelPath({ env: { RERANK_MODEL: "/env/m.gguf" } }), "/env/m.gguf");
  a.ok(rerankModelPath({ env: {} }).endsWith(`/${RERANK.MODEL_FILE}`), "default ends with the model file");
});

test("rerankAvailable: false for a missing model file (no model load, no throw)", () => {
  a.equal(rerankAvailable({ modelPath: "/definitely/not/here.gguf" }), false);
});

// ===================== 3. pure two-stage merge ===============================

test("twoStageRerank: re-sorts the head by score DESC", () => {
  const ranked = mkRanked(["A", "B", "C"]);            // decay order A,B,C
  const out = twoStageRerank(ranked, [0.10, 0.90, 0.50]);
  a.deepEqual(labels(out), ["B", "C", "A"], "sorted by score desc");
  a.deepEqual(labels(ranked), ["A", "B", "C"], "input array not mutated");
});

test("twoStageRerank: ties keep stage-1 order (stable ⇒ equal-score reranker is a no-op)", () => {
  const ranked = mkRanked(["A", "B", "C", "D"]);
  const out = twoStageRerank(ranked, [0.5, 0.5, 0.5, 0.5]);
  a.deepEqual(labels(out), ["A", "B", "C", "D"], "order preserved on ties");
});

test("twoStageRerank: only the top-N head is reranked; the tail is untouched", () => {
  const ranked = mkRanked(["A", "B", "C", "D", "E", "F"]);
  const out = twoStageRerank(ranked, [0.10, 0.90, 0.50], { topN: 3 }); // scores only for head of 3
  a.deepEqual(labels(out.slice(0, 3)), ["B", "C", "A"], "head reordered");
  a.deepEqual(labels(out.slice(3)), ["D", "E", "F"], "tail identical to stage-1");
});

test("twoStageRerank: absent/invalid scores ⇒ input returned UNCHANGED (same reference)", () => {
  const ranked = mkRanked(["A", "B", "C"]);
  a.equal(twoStageRerank(ranked, null), ranked, "null scores ⇒ same array ref");
  a.equal(twoStageRerank(ranked, "nope"), ranked, "non-array scores ⇒ same array ref");
});

test("twoStageRerank: empty candidates ⇒ safe empty array", () => {
  a.deepEqual(twoStageRerank([], [0.9]), []);
  a.deepEqual(twoStageRerank(null, [0.9]), []);
});

// ===================== 4. orchestrator with a MOCK reranker ==================

test("rerankStage: enabled + mock scorer reorders by rerank score", async () => {
  const merged = mkRanked(["A", "B", "C"]);
  const res = await rerankStage("q", merged, getText, { enabled: true, scoreFn: mockScore, k: 3 });
  a.equal(res.applied, true, "applied");
  a.equal(res.scored, 3, "scored the whole head");
  a.deepEqual(labels(res.ranked), ["B", "C", "A"], "reordered by mock scores");
});

test("rerankStage: mock scorer receives head TEXTS in stage-1 order, and the query", async () => {
  const merged = mkRanked(["A", "B", "C", "D"]);
  let seenQ = null, seenTexts = null;
  const capture = (q, texts) => { seenQ = q; seenTexts = texts.slice(); return texts.map(() => 0.5); };
  const res = await rerankStage("hello", merged, getText, { enabled: true, scoreFn: capture });
  a.equal(seenQ, "hello", "query passed through");
  a.deepEqual(seenTexts, ["A", "B", "C", "D"], "candidate texts handed over in stage-1 order");
  a.deepEqual(labels(res.ranked), ["A", "B", "C", "D"], "all-tie scores ⇒ order preserved");
});

test("rerankStage: top-k limit respected — top-k drawn from the reranked head", async () => {
  const merged = mkRanked(["A", "B", "C", "D", "E", "F"]); // scores: A .1 B .9 C .5 D .3 E .7 F .2
  const res = await rerankStage("q", merged, getText, { enabled: true, scoreFn: mockScore, k: 3 });
  const topk = res.ranked.slice(0, 3);
  a.equal(topk.length, 3, "exactly k results");
  a.deepEqual(labels(topk), ["B", "E", "C"], "top-3 by rerank score");
});

// ===================== 5. BACKWARD-COMPAT (no regression) ====================

test("rerankStage: DISABLED ⇒ order IDENTICAL and the SAME array reference (byte-for-byte)", async () => {
  const merged = mkRanked(["A", "B", "C", "D"]);
  const before = labels(merged);
  const res = await rerankStage("q", merged, getText, { enabled: false, scoreFn: mockScore, k: 8 });
  a.equal(res.applied, false, "not applied");
  a.equal(res.ranked, merged, "returns the exact same array (no copy, no reorder)");
  a.deepEqual(labels(res.ranked.slice(0, 8)), before.slice(0, 8), "slice(0,k) identical to today");
});

test("rerankStage: reranker UNAVAILABLE (scorer→null) ⇒ order UNCHANGED (model-gated fallback)", async () => {
  const merged = mkRanked(["A", "B", "C"]);
  const res = await rerankStage("q", merged, getText, { enabled: true, scoreFn: () => null });
  a.equal(res.applied, false, "not applied");
  a.equal(res.reason, "unavailable");
  a.equal(res.ranked, merged, "same array ref ⇒ ranking is exactly today's");
});

test("rerankStage: scorer THROWS ⇒ swallowed, order UNCHANGED (never breaks search)", async () => {
  const merged = mkRanked(["A", "B", "C"]);
  const res = await rerankStage("q", merged, getText, { enabled: true, scoreFn: () => { throw new Error("boom"); } });
  a.equal(res.applied, false);
  a.deepEqual(labels(res.ranked), ["A", "B", "C"], "order preserved despite scorer error");
});

test("rerankStage: scorer returns WRONG-LENGTH scores ⇒ ignored, order UNCHANGED", async () => {
  const merged = mkRanked(["A", "B", "C"]);
  const res = await rerankStage("q", merged, getText, { enabled: true, scoreFn: (_q, t) => t.slice(1).map(() => 0.5) });
  a.equal(res.applied, false, "length mismatch rejected");
  a.equal(res.ranked, merged);
});

test("rerankStage: empty candidates ⇒ safe no-op", async () => {
  const res = await rerankStage("q", [], getText, { enabled: true, scoreFn: mockScore });
  a.equal(res.applied, false);
  a.equal(res.reason, "empty");
  a.deepEqual(res.ranked, []);
});

// --- run + report ------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
  }
  console.log(`\ntest-rerank: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
  process.exit(failed ? 1 : 0);
})();
