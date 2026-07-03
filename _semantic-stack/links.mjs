// links.mjs — PROVIDER-FREE entity/link layer (A-MEM-style) over the semantic memory index.
//
// WHY THIS EXISTS: pure top-k vector similarity retrieves what is MOST like the query — but the best
// cross-domain connections are relevant yet DISSIMILAR (a market pattern and a behavioral pattern
// share a principle without sharing words or vectors near the top). connection-synthesis used to fake
// "domain" from the coarse `type` field and demote same-`type` hits — which contradicts its own thesis
// (two `type:pattern` notes bridging market+behavior got thrown away as "same domain"). This module
// replaces that heuristic with a real link layer + a diversity-aware candidate selector.
//
// TWO PURE PRIMITIVES (model-free, deterministic — synthetic vectors/timestamps in tests):
//   • buildLinks(chunks, opts)              → a link GRAPH over memory chunks, from pure-code signals.
//   • connectCandidates(seedVec, chunks, opts) → DIVERSE cross-links for a seed (MMR), each w/ a reason.
//
// LINK SIGNALS (A-MEM, provider-free — NO LLM in the base):
//   1. semantic similarity in the RELATED-BUT-DISTINCT band  SIM_FLOOR ≤ cosine < SIM_CEIL
//        - below SIM_FLOOR  = unrelated (no edge);  at/above SIM_CEIL = near-duplicate (NOT a
//          connection — that redundancy is reconcile.mjs's job, so we exclude it outright).
//   2. temporal proximity — written within TEMPORAL_WINDOW_DAYS of each other.
//   3. OPTIONAL shared named entities — the running agent may supply `chunk.entities` (or opts.entitiesOf);
//      base auto-linking works WITHOUT them (similarity + temporal only). No entity extraction is done here.
//   A pair is linked if ANY enabled signal fires (except near-dups, always excluded). Each edge carries a
//   composite weight (semantic-dominant; temporal/entity corroboration strictly increases it) + a reason.
//
// CROSS-DOMAIN MECHANISM (the fix): connectCandidates ranks by MMR — score = rel − λ·redundancy, where
//   rel = cosine(seed, chunk) and redundancy = max cosine to an already-picked candidate. High λ pushes
//   DIVERSITY: it deliberately surfaces relevant-but-dissimilar memories instead of a cluster of
//   near-duplicates, which is exactly the cross-domain material synthesis needs. `type` is only a display
//   label here — it NEVER gates candidacy (that was the bug).
//
// SAFETY / PURITY: the two primitives import only `cosine` from store.mjs (the dependency-free half of
// common.mjs) — NO node-llama-cpp, NO network. The CLI dynamically imports common.mjs for embed() ONLY at
// runtime, so pure importers (the tests) never load a model. Missing/empty/corrupt index ⇒ [] (graceful).
import { cosine } from "./store.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// --- tunables (all overridable via opts; the CLI also honors a couple of env knobs) ----------------
export const LINKS = {
  SIM_FLOOR: 0.35,            // cosine < FLOOR  ⇒ unrelated (no semantic edge)
  SIM_CEIL: 0.85,            // cosine ≥ CEIL   ⇒ near-duplicate ⇒ EXCLUDED (redundancy, not a connection)
  TEMPORAL_WINDOW_DAYS: 14,  // written within ~2 weeks ⇒ a temporal edge
  MMR_LAMBDA: 0.5,           // MMR redundancy penalty: score = rel − λ·maxSimToSelected (0.5 = balanced/diverse)
  MAX_PER_NODE: 8,           // buildLinks: cap edges per node (A-MEM keeps the graph sparse; 0/Infinity ⇒ off)
  W_SEM: 0.60,               // composite-weight coefficients (semantic dominates; corroboration adds on top)
  W_TEMPORAL: 0.25,
  W_ENTITY: 0.15,
  SEM_BASE: 0.15,            // in-band semantic weight floor, so a barely-in-band edge is still positive
  ENTITY_SAT: 3,            // shared-entity count at which the entity contribution saturates to 1
  DAY_MS: 24 * 60 * 60 * 1000,
  CLI_K: 12,                 // default candidate count for the CLI
  SNIPPET_LEN: 140,
};

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d) => (Number.isFinite(v) ? v : d);
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Stable id for a link endpoint / candidate: explicit id > ref > rel:line > path:line > positional.
function chunkId(c, i) {
  if (c && c.id != null) return String(c.id);
  if (c && c.ref != null) return String(c.ref);
  if (c && c.rel != null) return `${c.rel}:${c.startLine == null ? 0 : c.startLine}`;
  if (c && c.path != null) return `${c.path}:${c.startLine == null ? 0 : c.startLine}`;
  return `#${i}`;
}

// Timestamp (ms) for a chunk: explicit numeric `ts` wins; else parse a `date` string ("YYYY-MM-DD" or ISO).
// No usable date ⇒ null (⇒ the temporal signal simply doesn't fire — never a crash).
function readTs(c) {
  if (!c) return null;
  if (Number.isFinite(c.ts)) return c.ts;
  if (typeof c.date === "string" && c.date) {
    const t = Date.parse(c.date.length <= 10 ? `${c.date}T00:00:00Z` : c.date);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Normalized, de-duped, lowercased entity list for a chunk (agent-supplied). No extraction here.
function entitiesOf(c, fn) {
  const raw = typeof fn === "function" ? fn(c) : c && c.entities;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) if (typeof e === "string" && e.trim()) out.push(e.trim().toLowerCase());
  return [...new Set(out)];
}

function snippetOf(text, n) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, n);
}
function fmtDays(d) { return d == null ? "?" : d < 1 ? "<1d" : `${Math.round(d)}d`; }

function reasonForLink(sim, floor, ceil, signals, dtDays, shared) {
  const parts = [];
  if (signals.includes("semantic")) parts.push(`related in meaning (cosine ${sim.toFixed(2)}, band [${floor.toFixed(2)},${ceil.toFixed(2)}))`);
  if (signals.includes("temporal")) parts.push(`written ${fmtDays(dtDays)} apart`);
  if (signals.includes("entity")) parts.push(`shared entities: ${shared.slice(0, 4).join(", ")}`);
  return parts.join("; ");
}

// Keep, per node, only its strongest `cap` edges (edges already sorted strongest-first).
function prunePerNode(links, cap) {
  const count = Object.create(null);
  const kept = [];
  for (const l of links) {
    const ca = count[l.a] || 0, cb = count[l.b] || 0;
    if (ca < cap && cb < cap) { kept.push(l); count[l.a] = ca + 1; count[l.b] = cb + 1; }
  }
  return kept;
}

// ============================== buildLinks ==============================
// PURE: build a link graph over memory chunks. Returns [] for < 2 chunks (nothing to link).
//   chunks : [{ vector:number[], id?/ref?/rel?/path?, startLine?, ts?/date?, entities? , type? }]
//   opts   : { simFloor, simCeil, temporalWindowDays, maxPerNode(0/Infinity⇒off),
//              temporal:false ⇒ disable temporal, entities:false ⇒ disable entity, entitiesOf:(c)=>string[] }
// Each edge: { a, b, signals:["semantic"|"temporal"|"entity"...], sim, weight(0..1), dtDays|null,
//             sharedEntities:string[], reason }. Sorted by weight DESC (deterministic tie-break on ids).
export function buildLinks(chunks, opts = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (list.length < 2) return [];

  const FLOOR = num(opts.simFloor, LINKS.SIM_FLOOR);
  const CEIL = num(opts.simCeil, LINKS.SIM_CEIL);
  const WIN = num(opts.temporalWindowDays, LINKS.TEMPORAL_WINDOW_DAYS);
  const span = (CEIL - FLOOR) || 1;
  const useTemporal = opts.temporal !== false;
  const useEntities = opts.entities !== false;
  const entFn = typeof opts.entitiesOf === "function" ? opts.entitiesOf : null;

  // Precompute per-chunk facts once (id, vector, ts, entities).
  const meta = list.map((c, i) => ({
    id: chunkId(c, i),
    vec: Array.isArray(c && c.vector) ? c.vector : null,
    ts: readTs(c),
    ents: useEntities ? entitiesOf(c, entFn) : [],
  }));

  const links = [];
  for (let i = 0; i < list.length; i++) {
    const A = meta[i];
    if (!A.vec || !A.vec.length) continue;
    for (let j = i + 1; j < list.length; j++) {
      const B = meta[j];
      if (!B.vec || B.vec.length !== A.vec.length) continue; // mismatched/absent dim ⇒ skip, never crash
      const sim = cosine(A.vec, B.vec);
      if (!Number.isFinite(sim)) continue;
      if (sim >= CEIL) continue; // near-duplicate ⇒ not a connection (reconcile's job)

      const signals = [];
      let wSem = 0, wTemp = 0, wEnt = 0, dtDays = null, shared = [];

      if (sim >= FLOOR) { signals.push("semantic"); wSem = LINKS.SEM_BASE + (1 - LINKS.SEM_BASE) * clamp((sim - FLOOR) / span, 0, 1); }
      if (useTemporal && A.ts != null && B.ts != null) {
        dtDays = Math.abs(A.ts - B.ts) / LINKS.DAY_MS;
        if (dtDays <= WIN) { signals.push("temporal"); wTemp = 1 - dtDays / WIN; }
      }
      if (useEntities && A.ents.length && B.ents.length) {
        const setB = new Set(B.ents);
        shared = A.ents.filter((x) => setB.has(x));
        if (shared.length) { signals.push("entity"); wEnt = Math.min(1, shared.length / LINKS.ENTITY_SAT); }
      }
      if (!signals.length) continue;

      const weight = clamp(LINKS.W_SEM * wSem + LINKS.W_TEMPORAL * wTemp + LINKS.W_ENTITY * wEnt, 0, 1);
      links.push({ a: A.id, b: B.id, signals, sim, weight, dtDays, sharedEntities: shared, reason: reasonForLink(sim, FLOOR, CEIL, signals, dtDays, shared) });
    }
  }

  links.sort((x, y) => (y.weight - x.weight) || cmp(x.a + "|" + x.b, y.a + "|" + y.b));

  let cap;
  if (opts.maxPerNode === 0 || opts.maxPerNode === Infinity) cap = Infinity;
  else cap = posInt(opts.maxPerNode, LINKS.MAX_PER_NODE);
  return cap === Infinity ? links : prunePerNode(links, cap);
}

function connectReason(rel, red, type) {
  const t = type ? ` [${type}]` : "";
  return `seed-relevant (${rel.toFixed(2)}) yet diverse from earlier picks (overlap ${red.toFixed(2)})${t} — cross-domain candidate`;
}

// ============================== connectCandidates ==============================
// PURE: MMR-diverse cross-link candidates for a seed vector. Guards ⇒ [] (no seedVec / no chunks / none
// in band). `type` is a DISPLAY label only — it never gates candidacy.
//   seedVec : number[]                     query-space embedding of the seed
//   chunks  : [{ vector, rel?/path?, startLine?, type?, text? }]   flattened indexed chunks
//   opts    : { k, lambda, relFloor, relCeil, dedupByPath:false⇒off, snippetLen }
// Pool = { c : relFloor ≤ cosine(seed,c) < relCeil }  (drops unrelated AND near-restatements of the seed).
// Greedy MMR: pick argmax(rel − λ·maxSimToSelected). Returns [{ id, path, startLine, type, rel,
//   redundancy, mmr, reason, snippet }] in selection order (first = most seed-relevant anchor).
export function connectCandidates(seedVec, chunks, opts = {}) {
  const dim = Array.isArray(seedVec) ? seedVec.length : 0;
  const list = Array.isArray(chunks) ? chunks : [];
  if (!dim || list.length === 0) return [];

  const lambda = num(opts.lambda, LINKS.MMR_LAMBDA);
  const relFloor = num(opts.relFloor, LINKS.SIM_FLOOR);
  const relCeil = num(opts.relCeil, LINKS.SIM_CEIL);
  const k = posInt(opts.k, 8);
  const snippetLen = posInt(opts.snippetLen, LINKS.SNIPPET_LEN);

  // Build the relevance pool (band-gated only — NO type/domain gate).
  let pool = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const v = c && c.vector;
    if (!Array.isArray(v) || v.length !== dim) continue;
    const rel = cosine(seedVec, v);
    if (!Number.isFinite(rel) || rel < relFloor || rel >= relCeil) continue;
    pool.push({ id: chunkId(c, i), vec: v, rel, path: (c && (c.rel != null ? c.rel : c.path)) ?? null, startLine: c && c.startLine != null ? c.startLine : null, type: (c && c.type) || null, text: (c && c.text) || "" });
  }
  if (!pool.length) return [];

  // Note-level candidates: collapse multiple chunks of the same file to its best-rel chunk (CLI has paths;
  // pure tests use id-only chunks ⇒ this is inert). Keeps synthesis candidates one-per-note, not per-chunk.
  if (opts.dedupByPath !== false) {
    const byPath = new Map(); const passthrough = [];
    for (const p of pool) {
      if (typeof p.path === "string" && p.path) { const prev = byPath.get(p.path); if (!prev || p.rel > prev.rel) byPath.set(p.path, p); }
      else passthrough.push(p);
    }
    pool = passthrough.concat([...byPath.values()]);
  }

  const selected = [];
  const remaining = pool.slice();
  while (selected.length < k && remaining.length) {
    let best = -1, bestMmr = -Infinity, bestRel = -Infinity, bestId = null, bestRed = 0;
    for (let r = 0; r < remaining.length; r++) {
      const cand = remaining[r];
      let red = 0;
      for (const s of selected) { const o = cosine(cand.vec, s.vec); if (o > red) red = o; }
      const mmr = cand.rel - lambda * red;
      // deterministic argmax: mmr desc, then rel desc, then id asc
      if (mmr > bestMmr || (mmr === bestMmr && (cand.rel > bestRel || (cand.rel === bestRel && (bestId === null || cmp(cand.id, bestId) < 0))))) {
        best = r; bestMmr = mmr; bestRel = cand.rel; bestId = cand.id; bestRed = red;
      }
    }
    const pick = remaining.splice(best, 1)[0];
    selected.push({ ...pick, redundancy: bestRed, mmr: bestMmr });
  }

  return selected.map((s) => ({
    id: s.id, path: s.path, startLine: s.startLine, type: s.type,
    rel: s.rel, redundancy: s.redundancy, mmr: s.mmr,
    reason: connectReason(s.rel, s.redundancy, s.type),
    snippet: snippetOf(s.text, snippetLen),
  }));
}

// ------------------------------------- CLI ---------------------------------------------------------
// node links.mjs --seed '<text>' [--ws PATH] [--k N] [--lambda F] [--tsv | --json]
//   default : human-readable candidate list (relevance, overlap, reason, snippet).
//   --tsv   : one machine line per candidate  "path:line<TAB>type<TAB>rel<TAB>reason"  (what the shell reads).
//   --json  : the full candidate array as JSON.
// Missing/empty/corrupt index, missing seed, or an unavailable embedding model ⇒ NO candidates (graceful).
function parseArgs(argv) {
  const o = { seed: null, ws: null, k: LINKS.CLI_K, lambda: null, json: false, tsv: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") o.seed = argv[++i];
    else if (a === "--ws") o.ws = argv[++i];
    else if (a === "--k") o.k = parseInt(argv[++i], 10);
    else if (a === "--lambda") o.lambda = parseFloat(argv[++i]);
    else if (a === "--json") o.json = true;
    else if (a === "--tsv") o.tsv = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (o.seed == null && !a.startsWith("--")) o.seed = a; // positional seed
  }
  return o;
}

function emitEmpty(o, why) {
  if (o.json) process.stdout.write("[]\n");
  process.stderr.write(`# links: ${why} → no cross-link candidates\n`);
  return 0;
}

function emit(cands, o, lambda) {
  if (o.json) { process.stdout.write(JSON.stringify(cands) + "\n"); return; }
  if (o.tsv) {
    for (const c of cands) {
      const loc = `${c.path}:${c.startLine}`;
      const reason = String(c.reason).replace(/[\t\n]+/g, " ");
      process.stdout.write(`${loc}\t${c.type || "note"}\t${c.rel.toFixed(3)}\t${reason}\n`);
    }
    return;
  }
  if (!cands.length) { process.stdout.write("No diverse cross-link candidates found.\n"); return; }
  process.stdout.write(`🔗 ${cands.length} diverse cross-link candidate(s) (MMR λ=${lambda}):\n\n`);
  for (const c of cands) {
    process.stdout.write(`  • [${c.type || "note"}] ${c.path}:${c.startLine}\n`);
    process.stdout.write(`    rel ${c.rel.toFixed(3)} · overlap ${c.redundancy.toFixed(3)} · ${c.reason}\n`);
    if (c.snippet) process.stdout.write(`    ${c.snippet}\n`);
    process.stdout.write("\n");
  }
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write("Usage: node links.mjs --seed '<text>' [--ws PATH] [--k N] [--lambda F] [--tsv | --json]\n");
    return 0;
  }
  if (!o.seed || !o.seed.trim()) return emitEmpty(o, "no --seed text provided");

  const ws = o.ws || process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;
  const indexPath = `${ws}/memory/.semantic/index.json`;

  let index;
  try {
    if (!fs.existsSync(indexPath)) return emitEmpty(o, "no semantic index yet");
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch { return emitEmpty(o, "semantic index unreadable/corrupt"); }

  const chunks = [];
  for (const [rel, entry] of Object.entries((index && index.files) || {})) {
    const meta = (entry && entry.meta) || {};
    for (const c of (entry && entry.chunks) || []) {
      if (Array.isArray(c.vector) && c.vector.length) {
        chunks.push({ id: `${rel}:${c.startLine}`, rel, path: rel, startLine: c.startLine, text: c.text, vector: c.vector, type: meta.type || "note", date: meta.date || "" });
      }
    }
  }
  if (!chunks.length) return emitEmpty(o, "index has no vectors yet");

  // Embed the seed as a QUERY (arctic-embed is asymmetric — queries get the prefix; docs don't). Dynamic
  // import so merely importing this module (the pure tests) never loads node-llama-cpp.
  let seedVec;
  try {
    const common = await import("./common.mjs");
    seedVec = await common.embed((common.QUERY_PREFIX || "") + o.seed);
    if (typeof common.dispose === "function") await common.dispose();
  } catch { return emitEmpty(o, "embedding model unavailable"); }
  if (!Array.isArray(seedVec) || !seedVec.length) return emitEmpty(o, "could not embed seed");

  const lambda = o.lambda != null && Number.isFinite(o.lambda) ? o.lambda : LINKS.MMR_LAMBDA;
  const cands = connectCandidates(seedVec, chunks, { k: posInt(o.k, LINKS.CLI_K), lambda });
  emit(cands, o, lambda);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch(() => process.exit(0));
}
