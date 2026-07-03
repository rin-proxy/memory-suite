// surface.mjs — SURFACE: resurface "forgotten but important" memories for the morning briefing.
//
// Model-free. Reuses the decay signal's living access data (memory/.semantic/decay-scores.json).
// Where retrieval-time decay REWARDS recent/frequent use, SURFACE INVERTS it: it looks for memories
// that are important yet have gone unseen for a while and are rarely recalled. This is the
// Generative-Agents "importance × relevance × recency" idea with recency inverted into staleness.
// Relevance weighting is model-dependent and intentionally left out here (see TODO(model)).
//
//   surfaceScore = importanceWeight × stalenessBoost × neglectFactor
//     importanceWeight = importance / IMPORTANCE_DEFAULT      (0.5 ⇒ 1.0, 1.0 ⇒ 2.0, 0 ⇒ 0)
//     stalenessBoost   = 1 - 2^(-ageDays / STALE_HALF_LIFE)   (~0 just-seen → →1 long-forgotten)
//     neglectFactor    = 1 / (1 + NEGLECT_K·log2(access+1))   (rarely-recalled ⇒ high; often-recalled ⇒ low)
//
// Entries with no lastAccessMs are skipped (no staleness to compute). Absent/empty/corrupt store ⇒ [].
import { DECAY, loadDecayScores, DECAY_PATH } from "./decay.mjs";

export const SURFACE = {
  DAY_MS: 24 * 60 * 60 * 1000,
  STALE_HALF_LIFE_DAYS: 21, // staleness reaches ~0.5 after ~3 weeks unseen
  NEGLECT_K: 0.5,           // how hard frequent recall down-weights "forgotten"
  MIN_AGE_DAYS: 3,          // too-fresh items aren't "forgotten" yet — never surface them
  DEFAULT_TOP: 5,
};

function reasonFor(imp, ageDays, access) {
  const impLabel = imp >= 0.75 ? "high-importance" : imp <= 0.35 ? "low-importance" : "important";
  const days = Math.round(ageDays);
  const seen = days >= 1 ? `last seen ${days}d ago` : "last seen today";
  return `${impLabel} · ${seen} · ${access} recall${access === 1 ? "" : "s"}`;
}

// Pure: rank a scores object's entries by "forgotten but important".
// Returns [{ relPath, score, ageDays, access, importance, reason }], highest score first, capped at top.
export function surfaceCandidates(scores, opts = {}) {
  const now = opts.now || Date.now();
  const top = Number.isFinite(opts.top) && opts.top > 0 ? opts.top : SURFACE.DEFAULT_TOP;
  const entries = scores && scores.entries && typeof scores.entries === "object" ? scores.entries : {};
  const out = [];
  for (const [relPath, e] of Object.entries(entries)) {
    if (!e || typeof e !== "object") continue;
    if (!Number.isFinite(e.lastAccessMs) || e.lastAccessMs <= 0) continue; // need a timestamp to age
    const ageDays = Math.max(0, (now - e.lastAccessMs) / SURFACE.DAY_MS);
    if (ageDays < SURFACE.MIN_AGE_DAYS) continue; // too fresh to count as "forgotten"
    const access = Number.isFinite(e.access) && e.access > 0 ? e.access : 0;
    const imp = Number.isFinite(e.importance) ? Math.max(0, Math.min(1, e.importance)) : DECAY.IMPORTANCE_DEFAULT;

    const importanceWeight = imp / DECAY.IMPORTANCE_DEFAULT;
    const stalenessBoost = 1 - Math.pow(2, -ageDays / SURFACE.STALE_HALF_LIFE_DAYS);
    const neglectFactor = 1 / (1 + SURFACE.NEGLECT_K * Math.log2(access + 1));
    const score = importanceWeight * stalenessBoost * neglectFactor;
    if (!(score > 0)) continue; // importance 0 or just-accessed (staleness 0) ⇒ nothing to resurface
    out.push({ relPath, score, ageDays, access, importance: imp, reason: reasonFor(imp, ageDays, access) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, top);
}

// --- CLI: node surface.mjs --top 5 [--ws <workspace-root>] ----------------------
function main(argv) {
  let top = SURFACE.DEFAULT_TOP;
  let ws = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--top") top = parseInt(argv[++i], 10) || SURFACE.DEFAULT_TOP;
    else if (argv[i] === "--ws") ws = argv[++i];
  }
  const p = ws ? `${ws}/memory/.semantic/decay-scores.json` : DECAY_PATH;
  const items = surfaceCandidates(loadDecayScores(p), { top });
  if (!items.length) { process.stdout.write("(nothing to resurface)\n"); return; }
  for (const it of items) process.stdout.write(`- \`${it.relPath}\` — ${it.reason}\n`);
}

// TODO(model): an optional --relevance <query> path could additionally weight by embedding
// similarity to "today"; kept out so this module stays model-free (no node-llama-cpp import).

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
