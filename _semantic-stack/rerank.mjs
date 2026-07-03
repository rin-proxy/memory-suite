// rerank.mjs — OPTIONAL cross-encoder reranker: the final, off-by-default stage of retrieval.
//
// WHAT THIS IS: a second-stage precision re-rank that runs AFTER hybrid (RRF) + decay. Stage 1
// (RRF + decay, unchanged) narrows to the top ~N candidates; stage 2 (this) scores each
// (query, candidate-text) pair with a local cross-encoder and re-sorts the head by that score.
// Cross-encoders read the query and the document TOGETHER, so they judge relevance far more
// precisely than the bi-encoder cosine that produced stage 1 — at the cost of one model pass per
// candidate, which is why it's a re-rank over a small head rather than a full scan.
//
// RUNTIME: node-llama-cpp (v3.18+/3.19) exposes reranking via
//   model.createRankingContext() → ctx.rankAll(query, documents) → number[]  (score 0..1 per doc)
//   (see https://node-llama-cpp.withcat.ai/guide/embedding#reranking). We use rankAll (not
//   rankAndSort) because we need the scores ALIGNED to our rich candidate objects, not just text.
// MODEL: a GGUF reranker, default bge-reranker-v2-m3-Q8_0.gguf. It is NOT bundled and NOT installed
//   by default — reranking stays dormant until the model is present (see rerankAvailable()).
//
// BACKWARD-COMPAT CONTRACT (do not break — this is the whole point of "optional"):
//   - flag OFF (default: no RERANK=1 env, no --rerank)  ⇒ rerankStage returns the input order
//     UNCHANGED (same array), so hybrid.mjs / deep.mjs behave byte-for-byte as they do today.
//   - reranker model absent, runtime missing, or ANY error ⇒ same: input order unchanged. Never
//     throws into the search path; a broken/absent reranker degrades to exactly today's ranking.
//   - node-llama-cpp is imported DYNAMICALLY, only when actually scoring, so importing this module
//     (e.g. from the pure test) never loads the native runtime or any model.
import { WS, fs } from "./store.mjs";

// --- tunables ----------------------------------------------------------------
export const RERANK = {
  TOP_N: 50,                                 // stage-1 head size handed to the cross-encoder
  MODEL_FILE: "bge-reranker-v2-m3-Q8_0.gguf",// default reranker GGUF (downloaded, not bundled)
  DOC_CHARS: 1200,                           // cap doc chars per pair (mirrors common.mjs embed())
};

// Resolve the reranker model path: explicit opt > $RERANK_MODEL > default under the workspace.
export function rerankModelPath(opts = {}) {
  if (opts.modelPath) return opts.modelPath;
  const env = opts.env || process.env;
  if (env.RERANK_MODEL) return env.RERANK_MODEL;
  return `${WS}/node-llama-cpp/models/${RERANK.MODEL_FILE}`;
}

// Is the reranker model file actually present? Pure fs check — never loads a model, never throws.
export function rerankAvailable(opts = {}) {
  try { return fs.existsSync(rerankModelPath(opts)); } catch { return false; }
}

// Gate: OFF by default. opts.enabled (boolean) wins (explicit / test hook); else the --rerank CLI
// flag (opts.rerank); else the RERANK=1 env flag. Anything unset ⇒ false.
export function isRerankEnabled(opts = {}) {
  if (typeof opts.enabled === "boolean") return opts.enabled;
  if (opts.rerank === true || opts.rerank === "1" || opts.rerank === "true") return true;
  const env = opts.env || process.env;
  return env.RERANK === "1" || env.RERANK === "true";
}

// PURE two-stage merge. Given the stage-1 order `ranked` and cross-encoder `scores` aligned to its
// head, re-sort the head (top `topN`) by score DESC and keep the tail as-is. Ties keep the stage-1
// order (stable), so a reranker that returns equal scores is a no-op. Missing/short/invalid scores
// ⇒ the input order is returned UNCHANGED (backward-compat). Does not mutate the input items.
export function twoStageRerank(ranked, scores, opts = {}) {
  if (!Array.isArray(ranked) || ranked.length === 0) return Array.isArray(ranked) ? ranked : [];
  if (!Array.isArray(scores)) return ranked; // no rerank signal ⇒ exactly stage-1 order
  const topN = Number.isInteger(opts.topN) && opts.topN > 0 ? opts.topN : ranked.length;
  const cut = Math.min(topN, ranked.length, scores.length);
  if (cut <= 0) return ranked;
  const head = ranked.slice(0, cut).map((item, ord) => ({
    item, ord, score: Number.isFinite(scores[ord]) ? scores[ord] : -Infinity,
  }));
  head.sort((a, b) => (b.score - a.score) || (a.ord - b.ord)); // desc; stable on ties
  return head.map((h) => h.item).concat(ranked.slice(cut));
}

// --- model-backed scorer (the only part that touches node-llama-cpp / a model) ---
let _rr = null; // cached { modelPath, model, ctx } so repeated calls in one process reuse the load
// Score every candidate text for the query with the cross-encoder. Returns number[] aligned to
// `texts`, or null when the reranker is unavailable OR anything fails (⇒ caller keeps stage-1 order).
export async function rerankScores(query, texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!rerankAvailable(opts)) return null; // MODEL-GATE: not installed ⇒ signal "unavailable"
  const modelPath = rerankModelPath(opts);
  try {
    const { getLlama } = await import("node-llama-cpp"); // dynamic ⇒ pure importers never load it
    if (!_rr || _rr.modelPath !== modelPath) {
      await disposeRerank();
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      const ctx = await model.createRankingContext();
      _rr = { modelPath, model, ctx };
    }
    const docs = texts.map((t) => String(t == null ? "" : t).slice(0, RERANK.DOC_CHARS));
    const scores = await _rr.ctx.rankAll(query, docs); // number[] aligned to docs, each 0..1
    return Array.isArray(scores) && scores.length === docs.length ? scores : null;
  } catch {
    return null; // runtime/model error ⇒ graceful fallback, never fail a search
  }
}

export async function disposeRerank() {
  const rr = _rr; _rr = null;
  try { if (rr) await rr.model.dispose(); } catch {}
}

// ORCHESTRATOR wired into hybrid.mjs (msem) and deep.mjs (mdeep) as the final optional stage.
//   query    — the search string
//   ranked   — the stage-1 (RRF + decay) ordered array of candidate objects
//   getText  — (item, idx) => string : pulls the candidate text out of a stage-1 item
//   opts     — { k, topN, enabled, rerank, env, modelPath, scoreFn, modelLabel }
//              scoreFn is injectable (tests pass a deterministic mock; default = rerankScores).
// Returns { ranked, applied, scored, model, reason }. When not applied, `ranked` IS the input array
// (same reference) so downstream `.slice(0, k)` is byte-for-byte identical to today.
export async function rerankStage(query, ranked, getText, opts = {}) {
  const out = { ranked, applied: false, scored: 0, model: null, reason: "" };
  if (!Array.isArray(ranked) || ranked.length === 0) { out.reason = "empty"; return out; }
  if (!isRerankEnabled(opts)) { out.reason = "disabled"; return out; }

  const topN = Math.min(Number.isInteger(opts.topN) && opts.topN > 0 ? opts.topN : RERANK.TOP_N, ranked.length);
  const head = ranked.slice(0, topN);
  const get = typeof getText === "function" ? getText : (item) => (item && item.text) || "";
  const texts = head.map((item, idx) => { const t = get(item, idx); return typeof t === "string" ? t : ""; });

  const scoreFn = typeof opts.scoreFn === "function" ? opts.scoreFn : rerankScores;
  let scores = null;
  try { scores = await scoreFn(query, texts, opts); } catch { scores = null; }
  if (!Array.isArray(scores) || scores.length !== head.length) { out.reason = "unavailable"; return out; }

  out.ranked = twoStageRerank(ranked, scores, { topN });
  out.applied = true;
  out.scored = head.length;
  out.model = opts.modelLabel || (opts.scoreFn ? "mock" : (rerankModelPath(opts).split("/").pop() || "reranker"));
  out.reason = "reranked";
  return out;
}
