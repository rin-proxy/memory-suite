// metrics.mjs — PURE, dependency-free information-retrieval metrics for the memory-suite eval harness.
//
// No imports, no I/O, no model, no network. Everything here is a deterministic function of two inputs:
//   retrieved : ordered array of memory ids (best rank first), e.g. the file rel-paths msem/mdeep return.
//   relevant  : the ground-truth relevant ids — accepted as an Array OR a Set (deduped internally).
// Relevance is BINARY (an id is relevant or not), which is what our labeled datasets provide.
//
// EDGE-CASE CONVENTIONS (documented once, applied consistently; unit-tested in test-metrics.mjs):
//   - relevant is EMPTY (|relevant| == 0): the query is degenerate. We return the *vacuous* value —
//       recall = 1     ("found all zero relevant items"),
//       ndcg   = 1     (DCG 0 / IDCG 0 → an empty ranking is trivially ideal),
//       precision = 0  (nothing retrieved can be relevant when nothing is relevant),
//       mrr    = 0     (there is no relevant item to rank).
//     The runner (run-eval.mjs) warns about and skips empty-relevant queries, so these never reach an
//     aggregate; the convention exists only so the functions are total (never NaN / never throw).
//   - k <= 0: nothing is examined ⇒ recall/precision/ndcg = 0.
//   - k > retrieved.length: only the ids that exist are considered (no padding with phantom hits), BUT
//       precisionAtK still divides by k (empty rank slots count as non-relevant — the standard P@k).
//   - duplicate ids in `retrieved`: only the FIRST occurrence of an id counts (a memory can't be
//       "found twice"); later duplicates are skipped for hit-counting and DCG.

// --- helpers -----------------------------------------------------------------

// Normalise `relevant` (Array | Set | iterable) into a Set for O(1) membership + a stable size.
function toRelSet(relevant) {
  return relevant instanceof Set ? relevant : new Set(relevant || []);
}
// The first-`k` retrieved ids with duplicates removed (first occurrence wins), in rank order.
function topKUnique(retrieved, k) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(retrieved) ? retrieved : [];
  for (let i = 0; i < list.length && out.length < k; i++) {
    const id = list[i];
    if (seen.has(id)) continue; // a repeated id occupies no new "slot"
    seen.add(id);
    out.push(id);
  }
  return out;
}
// Count how many of the top-k unique retrieved ids are in the relevant set.
function hitsAtK(retrieved, relSet, k) {
  let h = 0;
  for (const id of topKUnique(retrieved, k)) if (relSet.has(id)) h++;
  return h;
}

// --- recall@k ----------------------------------------------------------------
// recall@k = |relevant ∩ top-k(retrieved)| / |relevant|
// "Of all the relevant memories, what fraction did we surface in the top k?"
export function recallAtK(retrieved, relevant, k) {
  const relSet = toRelSet(relevant);
  if (relSet.size === 0) return 1; // vacuous: nothing to recall (see conventions)
  if (!(k > 0)) return 0;
  return hitsAtK(retrieved, relSet, k) / relSet.size;
}

// --- precision@k -------------------------------------------------------------
// precision@k = |relevant ∩ top-k(retrieved)| / k   (divides by k, NOT by #retrieved — the classic P@k;
// so returning fewer than k results is penalised for the empty slots).
// "Of the k memories we surfaced, what fraction were actually relevant?"
export function precisionAtK(retrieved, relevant, k) {
  const relSet = toRelSet(relevant);
  if (!(k > 0)) return 0;
  if (relSet.size === 0) return 0; // nothing relevant ⇒ nothing retrieved can be a hit
  return hitsAtK(retrieved, relSet, k) / k;
}

// --- MRR (mean reciprocal rank, single-query form) ---------------------------
// mrr = 1 / rank_of_first_relevant   (rank is 1-based). No relevant found ⇒ 0.
// "How high up is the first relevant memory?" (rank 1 → 1.0, rank 2 → 0.5, …).
// Aggregate MRR is the mean of this over queries (done in run-eval.mjs).
export function mrr(retrieved, relevant) {
  const relSet = toRelSet(relevant);
  if (relSet.size === 0) return 0;
  const unique = topKUnique(retrieved, Infinity);
  for (let i = 0; i < unique.length; i++) {
    if (relSet.has(unique[i])) return 1 / (i + 1); // first hit at 1-based rank i+1
  }
  return 0; // no relevant id anywhere in the ranking
}

// --- nDCG@k (binary relevance) ----------------------------------------------
// DCG@k  = Σ_{i=1..k} rel_i / log2(i + 1)         with rel_i ∈ {0,1}  (position 1 → /log2(2) = /1)
// IDCG@k = Σ_{i=1..min(k, |relevant|)} 1 / log2(i + 1)   (all relevant packed at the top = ideal)
// nDCG@k = DCG@k / IDCG@k  ∈ [0, 1]
// "How good is the ordering vs. the best possible ordering of the same relevant set?"
export function ndcgAtK(retrieved, relevant, k) {
  const relSet = toRelSet(relevant);
  if (relSet.size === 0) return 1; // vacuous: empty relevant ⇒ any ranking is ideal (see conventions)
  if (!(k > 0)) return 0;

  let dcg = 0;
  const topk = topKUnique(retrieved, k);
  for (let i = 0; i < topk.length; i++) {
    if (relSet.has(topk[i])) dcg += 1 / Math.log2(i + 2); // rank i+1 → log2((i+1)+1) = log2(i+2)
  }
  // Ideal DCG: as many relevant items as can fit in k, all at the front.
  const ideal = Math.min(k, relSet.size);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);

  return idcg === 0 ? 0 : dcg / idcg;
}

// Convenience: compute every metric for one query in a single pass-friendly call.
// Returns { recall, precision, ndcg } for the given k plus the k-independent { mrr }.
export function metricsAtK(retrieved, relevant, k) {
  return {
    recall: recallAtK(retrieved, relevant, k),
    precision: precisionAtK(retrieved, relevant, k),
    ndcg: ndcgAtK(retrieved, relevant, k),
    mrr: mrr(retrieved, relevant),
  };
}
