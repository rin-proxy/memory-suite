// reconcile.mjs — WRITE-TIME memory reconciliation: dedup + conflict pre-filter for the "add a memory" path.
//
// WHAT THIS IS: before a new memory is written, embed it and compare (cosine) against the already-indexed
// memory chunks. A near-identical hit is dropped deterministically; an ambiguous "similar" hit is handed to
// the RUNNING AGENT to judge (duplicate / update / contradiction / distinct). Everything else is genuinely new.
// This keeps the store from silently accumulating duplicate or contradictory memories over time.
//
// PROVIDER-FREE BY DESIGN (the key adaptation of the dinomem reconciliation pattern):
//   • cosine PRE-FILTER  = pure code (this module). No LLM, no cloud, no network.
//   • VERDICT for the ambiguous MID band = the agent that invoked the skill supplies the judgment, using
//     `verdictPrompt` + the surrounding context it already has. There is NO standing provider / API call —
//     dinomem needs a live LLM to arbitrate every write; here the deterministic band is handled in code and
//     only the genuinely-ambiguous band defers to the human-in-the-loop agent already in the session.
//
// SAFETY CONTRACT (never block a store): a missing model, a missing/corrupt index, an un-embeddable
// candidate, or ANY error ⇒ action "new" (store normally). Reconciliation only ever PREVENTS a write when it
// is confident the write is a near-duplicate (HIGH band); whenever unsure or unavailable it defers to normal
// writing. It can drop a dup or ask for review — it can never lose a memory the agent meant to keep.
//
// The pure core `reconcile(candVec, existing, opts)` is model-free and imports only `cosine` from store.mjs
// (the dependency-free half of common.mjs), so tests run with synthetic vectors and NO node-llama-cpp. The
// CLI dynamically imports common.mjs for embed() only when actually run.
import { cosine } from "./store.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// --- tunable thresholds (the CLI additionally honors env RECONCILE_HIGH / RECONCILE_MID) ------------
export const RECONCILE = {
  HIGH: 0.95,       // cosine ≥ HIGH        → NEAR-IDENTICAL → action "skip"   (deterministic dedup, no agent)
  MID: 0.85,        // MID ≤ cosine < HIGH  → SIMILAR        → action "review" (agent-driven verdict)
  TOP_K: 5,         // max near-matches reported
  SNIPPET_LEN: 140, // chars of context shown per match
};

// Collapse whitespace + trim + cap — same snippet shape hybrid.mjs/deep.mjs print.
function snippetOf(text, n) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, n);
}

// Build the advisory prompt handed to the RUNNING AGENT for a MID-band "review". NO external LLM is called:
// the agent that triggered the write answers this itself, using its own reasoning plus the shown context.
function buildVerdictPrompt(candidateText, matches, mid, high) {
  const cand = snippetOf(candidateText, 600) || "<candidate memory>";
  const rows = matches.map((m, i) => `  ${i + 1}. [${m.score.toFixed(3)}] ${m.path}\n     ${m.snippet}`).join("\n");
  return [
    `WRITE-TIME RECONCILIATION — cosine put this candidate in the ambiguous band [${mid.toFixed(2)}, ${high.toFixed(2)}).`,
    "YOU are the judge (no external model is consulted). Compare the CANDIDATE against the SIMILAR EXISTING",
    "memory below and pick ONE verdict:",
    "  • DUPLICATE     — same information already stored → skip the write.",
    "  • UPDATE        — candidate supersedes/refines an existing note → edit or replace that note.",
    "  • CONTRADICTION — candidate conflicts with an existing note → resolve which is true, then correct it.",
    "  • DISTINCT      — related but genuinely new → store it.",
    "",
    "CANDIDATE:",
    `  ${cand}`,
    "",
    "SIMILAR EXISTING:",
    rows,
  ].join("\n");
}

// PURE core (model-free, deterministic): decide new | skip | review for a candidate vector.
//   candVec  : number[]                    embedding of the candidate memory (DOCUMENT space — NOT query-prefixed)
//   existing : [{ path, vector, text }]    flattened indexed chunks (path = rel file, vector = its embedding)
//   opts     : { high, mid, topK, snippetLen, candidateText }
// Returns { action, topScore, matches:[{path,score,snippet}], recommendation, verdictPrompt, thresholds }.
export function reconcile(candVec, existing, opts = {}) {
  const HIGH = Number.isFinite(opts.high) ? opts.high : RECONCILE.HIGH;
  const MID = Number.isFinite(opts.mid) ? opts.mid : RECONCILE.MID;
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? opts.topK : RECONCILE.TOP_K;
  const snippetLen = Number.isFinite(opts.snippetLen) && opts.snippetLen > 0 ? opts.snippetLen : RECONCILE.SNIPPET_LEN;
  const thresholds = { high: HIGH, mid: MID };

  const dim = Array.isArray(candVec) ? candVec.length : 0;
  const list = Array.isArray(existing) ? existing : [];

  // Guard: no candidate vector OR nothing to compare against ⇒ never block ⇒ "new".
  if (!dim || list.length === 0) {
    return {
      action: "new", topScore: 0, matches: [],
      recommendation: "new — nothing to compare against (no candidate vector or empty index); store normally.",
      verdictPrompt: null, thresholds,
    };
  }

  // Score every existing chunk that carries a same-dimension vector; skip malformed / mismatched ones.
  const scored = [];
  for (const e of list) {
    const v = e && e.vector;
    if (!Array.isArray(v) || v.length !== dim) continue;
    const score = cosine(candVec, v);
    if (!Number.isFinite(score)) continue;
    scored.push({ path: e && e.path != null ? String(e.path) : "", score, snippet: snippetOf(e && e.text, snippetLen) });
  }
  scored.sort((a, b) => b.score - a.score);

  const topScore = scored.length ? scored[0].score : 0;
  // Matches worth surfacing = at/above MID (the ones that drive skip/review), ranked, capped at topK.
  const matches = scored.filter((m) => m.score >= MID).slice(0, topK);

  if (topScore >= HIGH) {
    const dup = (matches[0] && matches[0].path) || "an existing memory";
    return {
      action: "skip", topScore, matches,
      recommendation: `skip — near-identical to ${dup} (cosine ${topScore.toFixed(3)} ≥ ${HIGH.toFixed(2)}); do not store the duplicate.`,
      verdictPrompt: null, thresholds,
    };
  }
  if (topScore >= MID) {
    return {
      action: "review", topScore, matches,
      recommendation: `review — similar to ${matches.length} existing chunk(s) (top cosine ${topScore.toFixed(3)}, in [${MID.toFixed(2)}, ${HIGH.toFixed(2)})); could be duplicate / update / contradiction — the running agent decides.`,
      verdictPrompt: buildVerdictPrompt(opts.candidateText, matches, MID, HIGH),
      thresholds,
    };
  }
  return {
    action: "new", topScore, matches: [],
    recommendation: `new — closest existing memory is cosine ${topScore.toFixed(3)} < ${MID.toFixed(2)}; store normally.`,
    verdictPrompt: null, thresholds,
  };
}

// ------------------------------------- CLI ---------------------------------------------------------
// node reconcile.mjs --text '…' | --file PATH   [--ws PATH] [--action-only] [--json]
//   --action-only : print ONLY the bare action word (new|skip|review) to stdout (for shell capture);
//                   the recommendation goes to stderr. This is what distill-store.sh consumes.
//   --json        : print the full result object as JSON.
//   (default)     : human-readable report (recommendation, matches, and the verdict prompt if review).

function parseArgs(argv) {
  const o = { text: null, file: null, ws: null, actionOnly: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text") o.text = argv[++i];
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--ws") o.ws = argv[++i];
    else if (a === "--action-only") o.actionOnly = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
  }
  return o;
}

function envFloat(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : dflt;
}

function emit(result, o) {
  if (o.actionOnly) {
    process.stdout.write(result.action + "\n");            // clean single token for `$(...)` capture
    process.stderr.write(`# reconcile: ${result.recommendation}\n`); // context to stderr, out of the way
    return;
  }
  if (o.json) { process.stdout.write(JSON.stringify(result) + "\n"); return; }
  process.stdout.write(`action: ${result.action}\n${result.recommendation}\n`);
  if (result.matches.length) {
    process.stdout.write("matches:\n");
    for (const m of result.matches) process.stdout.write(`  [${m.score.toFixed(3)}] ${m.path}\n    ${m.snippet}\n`);
  }
  if (result.verdictPrompt) process.stdout.write(`\n${result.verdictPrompt}\n`);
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write("Usage: node reconcile.mjs --text '…' | --file PATH  [--ws PATH] [--action-only] [--json]\n");
    return 0;
  }
  const high = envFloat("RECONCILE_HIGH", RECONCILE.HIGH);
  const mid = envFloat("RECONCILE_MID", RECONCILE.MID);
  const thresholds = { high, mid };

  // Any degraded path ⇒ emit "new" and exit 0 (never block a store).
  const emitNew = (why) => { emit({ action: "new", topScore: 0, matches: [], recommendation: `new — ${why}`, verdictPrompt: null, thresholds }, o); return 0; };

  const ws = o.ws || process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;
  let candidateText = o.text;
  if (candidateText == null && o.file) {
    try { candidateText = fs.readFileSync(o.file, "utf8"); } catch { candidateText = null; }
  }
  if (!candidateText || !candidateText.trim()) return emitNew("no candidate text provided; store normally.");

  // Load the semantic index (missing/corrupt ⇒ new). Vectors come from memory/.semantic/index.json.
  const indexPath = `${ws}/memory/.semantic/index.json`;
  let index;
  try {
    if (!fs.existsSync(indexPath)) return emitNew("no semantic index yet; store normally.");
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch { return emitNew("semantic index unreadable/corrupt; store normally."); }

  const existing = [];
  for (const [rel, entry] of Object.entries((index && index.files) || {})) {
    for (const c of (entry && entry.chunks) || []) {
      if (Array.isArray(c.vector) && c.vector.length) existing.push({ path: rel, vector: c.vector, text: c.text });
    }
  }
  if (existing.length === 0) return emitNew("index has no vectors yet; store normally.");

  // Embed the candidate as a DOCUMENT — NO query prefix, matching how index.mjs embeds chunks, so the
  // candidate and the stored chunks live in the same space. Dynamic import so merely importing this module
  // (the pure tests) never loads node-llama-cpp.
  let candVec;
  try {
    const common = await import("./common.mjs");
    candVec = await common.embed(candidateText);
    if (typeof common.dispose === "function") await common.dispose();
  } catch { return emitNew("embedding model unavailable; store normally."); }
  if (!Array.isArray(candVec) || candVec.length === 0) return emitNew("could not embed candidate; store normally.");

  emit(reconcile(candVec, existing, { high, mid, candidateText }), o);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch(() => process.exit(0));
}
