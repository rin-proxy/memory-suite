// run-eval.mjs — provider-free retrieval eval runner for the memory-suite.
//
// WHAT IT DOES: loads a labeled dataset (JSONL of { query, relevant:[ids] }), runs retrieval over a
// corpus, and reports aggregate IR metrics (recall@k, precision@k, nDCG@k, MRR) — the numbers you watch
// before/after a change to decay / reranker / reconciliation / links. It re-implements the SAME ranking
// pipeline as the real engine (hybrid.mjs / deep.mjs): keyword + semantic → Reciprocal Rank Fusion →
// decay multiply → optional cross-encoder rerank. Only index-building and query-embedding touch the
// model; the ranking adapter (`retrieve`) is PURE, so it — and the metrics + dataset loading — are fully
// unit-testable WITHOUT a model or network (see test-metrics.mjs).
//
// MODEL GATING: semantic/hybrid modes need the arctic-embed GGUF; if it's absent we print how to get it
// and exit cleanly (0). `--mode keyword` needs NO model and runs anywhere (great for CI + the fixture).
//
// USAGE:
//   node eval/run-eval.mjs --dataset eval/fixtures/mini.jsonl [--corpus PATH] [--k 5,10] [--mode hybrid]
//   node eval/run-eval.mjs --dataset eval/fixtures/mini.jsonl --mode keyword          # no model needed
//   node eval/run-eval.mjs --dataset ... --ab decay  --decay-scores eval/fixtures/mini-decay.json
//   node eval/run-eval.mjs --dataset ... --ab rerank                                   # needs reranker GGUF
//
// The `retrieve` adapter is a swappable named export: a variant harness can import a different ranker
// and feed it the same dataset/metrics.
import { WS, cosine, fs, path } from "../store.mjs";
import { decayFactor } from "../decay.mjs";
import { rerankStage } from "../rerank.mjs";
import { recallAtK, precisionAtK, ndcgAtK, mrr } from "./metrics.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";

// Embedding model coordinates. MIRRORED from common.mjs (the source of truth) so this module never has to
// statically import common.mjs — which would pull node-llama-cpp and break the pure test on a box that
// has no runtime installed. When the runtime IS present we read the real values back from common.mjs.
export const EMBED_MODEL = `${WS}/node-llama-cpp/models/snowflake-arctic-embed-l-v2.0-f16.gguf`;
const QUERY_PREFIX = "query: ";
const STOP = new Set("the and for with that this from dari dan yang untuk atau ke di ada itu aku kamu apa how what why where when who does should relate".split(/\s+/));

// ============================================================================
// Dataset + corpus loading  (PURE — exported for unit tests; no fs beyond load*)
// ============================================================================

// Parse dataset JSONL text → { queries:[{query, relevant:Set|[]}], warnings:[], skipped }.
// Lines that are blank or start with `#` are ignored. Malformed lines or empty-relevant queries are
// SKIPPED with a warning (they'd pollute an aggregate), never crash the run.
export function parseDataset(text) {
  const queries = [], warnings = [];
  let skipped = 0, lineNo = 0;
  for (const raw of String(text).split("\n")) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { warnings.push(`line ${lineNo}: not valid JSON — skipped`); skipped++; continue; }
    const q = obj && typeof obj.query === "string" ? obj.query.trim() : "";
    const rel = Array.isArray(obj && obj.relevant) ? obj.relevant.filter((x) => typeof x === "string" && x) : null;
    if (!q) { warnings.push(`line ${lineNo}: missing/empty "query" — skipped`); skipped++; continue; }
    if (!rel) { warnings.push(`line ${lineNo}: missing/invalid "relevant" array — skipped`); skipped++; continue; }
    if (rel.length === 0) { warnings.push(`line ${lineNo}: empty "relevant" (query "${q.slice(0, 40)}") — skipped`); skipped++; continue; }
    queries.push({ query: q, relevant: rel });
  }
  return { queries, warnings, skipped };
}

// Parse corpus into [{ id, text, type, date }]. Accepts JSONL (one obj/line) OR a single JSON array.
export function parseCorpus(text) {
  const s = String(text).trim();
  const rows = [];
  const push = (o) => {
    if (!o || typeof o !== "object") return;
    const id = typeof o.id === "string" ? o.id : (typeof o.rel === "string" ? o.rel : null);
    const t = typeof o.text === "string" ? o.text : (typeof o.content === "string" ? o.content : "");
    if (id == null || !t) return;
    rows.push({ id, text: t, type: o.type || "note", date: o.date || "" });
  };
  if (s.startsWith("[")) { try { for (const o of JSON.parse(s)) push(o); } catch { /* fall through */ } }
  else for (const line of s.split("\n")) { const l = line.trim(); if (!l || l.startsWith("#")) continue; try { push(JSON.parse(l)); } catch { /* skip */ } }
  return rows;
}

export function loadDataset(p) { return parseDataset(fs.readFileSync(p, "utf8")); }
export function loadCorpus(p) { return parseCorpus(fs.readFileSync(p, "utf8")); }

// Load a decay-scores store (decay.mjs format) → its entries object, or {} on any problem.
export function loadDecayEntries(p) {
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    return o && o.entries && typeof o.entries === "object" ? o.entries : {};
  } catch { return {}; }
}

// ============================================================================
// Ranking pipeline  (PURE — faithful mirror of hybrid.mjs; unit-testable with fake vectors)
// ============================================================================

// Keyword terms of a query (mirrors hybrid.mjs: len ≥ 3, drop stopwords, lowercase alnum split).
export function keywordTerms(query) {
  return String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}
// Keyword score per chunk: term frequency in text + a small id/path-match bonus (mirrors hybrid.mjs).
export function keywordScores(terms, chunks) {
  return chunks.map((c) => {
    const t = String(c.text).toLowerCase();
    let s = 0;
    for (const term of terms) s += t.split(term).length - 1;
    if (terms.some((term) => String(c.id).toLowerCase().includes(term))) s += 3;
    return s;
  });
}

// Reciprocal Rank Fusion of a semantic score array and a keyword score array (either may be null to
// disable that signal). Returns [{ i, rrf, sem, kw, factor:1 }] sorted by rrf DESC — exactly the shape
// hybrid.mjs builds before its decay/rerank stages.
export function rrfMerge(chunks, semScore, kwScore, RRF_K = 60) {
  const idx = [...chunks.keys()];
  const semRank = semScore ? new Map(idx.slice().sort((a, b) => semScore[b] - semScore[a]).map((i, r) => [i, r])) : null;
  const kwRank = kwScore ? new Map(idx.filter((i) => kwScore[i] > 0).sort((a, b) => kwScore[b] - kwScore[a]).map((i, r) => [i, r])) : null;
  return idx.map((i) => {
    let rrf = 0;
    if (semRank && semRank.has(i)) rrf += 1 / (RRF_K + semRank.get(i));
    if (kwRank && kwRank.has(i)) rrf += 1 / (RRF_K + kwRank.get(i));
    return { i, rrf, sem: semScore ? semScore[i] : 0, kw: kwScore ? kwScore[i] : 0, factor: 1 };
  }).sort((a, b) => b.rrf - a.rrf);
}

// THE RETRIEVAL ADAPTER (swappable). Given a query, an in-memory index, and a config, return an ORDERED,
// DEDUPED list of memory ids (best rank first) — the exact input the metrics expect. Pure given qVec:
// the model only ever runs upstream (to produce index vectors + qVec), so this is testable model-free.
//   index  : { chunks: [{ id, text, vector|null }] }
//   config : { mode:'keyword'|'semantic'|'hybrid', qVec:number[]|null, decayEntries:{}|null,
//              rerank:bool, k:int, nowMs:int, scoreFn?:fn(for a mock reranker in tests) }
export async function retrieve(query, index, config = {}) {
  const chunks = index.chunks;
  if (!chunks.length) return [];
  const mode = config.mode || "hybrid";
  const terms = keywordTerms(query);

  const wantSem = mode !== "keyword" && Array.isArray(config.qVec);
  const wantKw = mode !== "semantic";
  const semScore = wantSem ? chunks.map((c) => (Array.isArray(c.vector) ? cosine(config.qVec, c.vector) : -1)) : null;
  const kwScore = wantKw ? keywordScores(terms, chunks) : null;

  const merged = rrfMerge(chunks, semScore, kwScore);

  // Post-fusion decay multiply — identical contract to hybrid.mjs: entries present ⇒ multiply & re-sort;
  // no entries ⇒ skipped entirely, so the order stays exactly the RRF order (every factor 1.0).
  const entries = config.decayEntries;
  if (entries && Object.keys(entries).length) {
    const nowMs = config.nowMs || Date.now();
    for (const r of merged) { r.factor = decayFactor(entries[chunks[r.i].id], nowMs); r.score = r.rrf * r.factor; }
    merged.sort((a, b) => (b.score ?? b.rrf) - (a.score ?? a.rrf));
  }

  // Optional cross-encoder rerank — the real rerankStage from rerank.mjs (off by default, model-gated).
  // `enabled` (when a boolean) hard-pins the toggle so an A/B column can't be flipped by a stray RERANK
  // env; when undefined, rerankStage falls back to the --rerank flag (config.rerank) then the env.
  const rerankOpts = { k: config.k, rerank: config.rerank === true, scoreFn: config.scoreFn };
  if (typeof config.enabled === "boolean") rerankOpts.enabled = config.enabled;
  const rr = await rerankStage(query, merged, (r) => chunks[r.i].text, rerankOpts);

  // Chunk order → unique memory ids (a memory can back several chunks; first/best occurrence wins).
  const ids = [], seen = new Set();
  for (const r of rr.ranked) { const id = chunks[r.i].id; if (!seen.has(id)) { seen.add(id); ids.push(id); } }
  return ids;
}

// ============================================================================
// Aggregation
// ============================================================================

// Run one config over all queries; return aggregate + per-query rows. `embedded` maps query→qVec (or {}).
async function evalConfig(queries, index, config, ks, embedded) {
  const sums = { mrr: 0, byK: Object.fromEntries(ks.map((k) => [k, { recall: 0, precision: 0, ndcg: 0 }])) };
  const perQuery = [];
  for (const { query, relevant } of queries) {
    const qVec = embedded[query] || null;
    const ids = await retrieve(query, index, { ...config, qVec });
    const relSet = new Set(relevant);
    const row = { query, relevant, mrr: mrr(ids, relSet), byK: {}, retrievedTopK: ids.slice(0, Math.max(...ks)) };
    sums.mrr += row.mrr;
    for (const k of ks) {
      const m = { recall: recallAtK(ids, relSet, k), precision: precisionAtK(ids, relSet, k), ndcg: ndcgAtK(ids, relSet, k) };
      row.byK[k] = m;
      sums.byK[k].recall += m.recall; sums.byK[k].precision += m.precision; sums.byK[k].ndcg += m.ndcg;
    }
    perQuery.push(row);
  }
  const n = queries.length || 1;
  const aggregate = { mrr: sums.mrr / n, byK: Object.fromEntries(ks.map((k) => [k, {
    recall: sums.byK[k].recall / n, precision: sums.byK[k].precision / n, ndcg: sums.byK[k].ndcg / n,
  }])) };
  return { aggregate, perQuery };
}

// Flatten an aggregate into ordered metric rows for printing/diffing.
function metricRows(agg, ks) {
  const rows = [];
  for (const k of ks) { const m = agg.byK[k]; rows.push([`recall@${k}`, m.recall], [`precision@${k}`, m.precision], [`nDCG@${k}`, m.ndcg]); }
  rows.push(["MRR", agg.mrr]);
  return rows;
}

// ============================================================================
// Printing
// ============================================================================
const f4 = (x) => x.toFixed(4);
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function printSingle(label, agg, ks) {
  const rows = metricRows(agg, ks);
  const w = Math.max(12, ...rows.map((r) => r[0].length));
  console.log(`\n  ${pad("metric", w)}  ${padL(label, 9)}`);
  console.log(`  ${"-".repeat(w)}  ${"-".repeat(9)}`);
  for (const [name, v] of rows) console.log(`  ${pad(name, w)}  ${padL(f4(v), 9)}`);
}

function printAB(baseLabel, baseAgg, varLabel, varAgg, ks) {
  const b = metricRows(baseAgg, ks), v = metricRows(varAgg, ks);
  const w = Math.max(12, ...b.map((r) => r[0].length));
  console.log(`\n  ${pad("metric", w)}  ${padL(baseLabel, 10)}  ${padL(varLabel, 10)}  ${padL("Δ", 9)}`);
  console.log(`  ${"-".repeat(w)}  ${"-".repeat(10)}  ${"-".repeat(10)}  ${"-".repeat(9)}`);
  for (let i = 0; i < b.length; i++) {
    const d = v[i][1] - b[i][1];
    const sign = d > 1e-12 ? "+" : (d < -1e-12 ? "" : " ");
    console.log(`  ${pad(b[i][0], w)}  ${padL(f4(b[i][1]), 10)}  ${padL(f4(v[i][1]), 10)}  ${padL(sign + f4(d), 9)}`);
  }
}

// ============================================================================
// Model engine (lazy) — the ONLY code that loads node-llama-cpp
// ============================================================================
async function loadEngine() {
  // Dynamic import so a box without node-llama-cpp can still import THIS module (pure test / keyword mode).
  const c = await import("../common.mjs");
  return { embed: c.embed, dispose: c.dispose, MODEL: c.MODEL, QUERY_PREFIX: c.QUERY_PREFIX };
}

// ============================================================================
// CLI
// ============================================================================
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--rerank") flags.rerank = true;
    else if (t === "--no-report") flags.noReport = true;
    else if (t.startsWith("--")) flags[t.slice(2)] = argv[++i];
    else pos.push(t);
  }
  return { flags, pos };
}

function parseKs(s) {
  const ks = String(s || "5,10").split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ks)].sort((a, b) => a - b);
}

// Build the two configs for an A/B run (or a single config when --ab is absent).
function planConfigs(flags, decayEntries) {
  const base = { mode: flags.mode || "hybrid", rerank: flags.rerank === true, decayEntries: flags.decayScores ? decayEntries : null };
  if (flags.ab === "decay") {
    return { ab: "decay",
      baseline: { label: "decay off", cfg: { ...base, decayEntries: null } },
      variant: { label: "decay on", cfg: { ...base, decayEntries } } };
  }
  if (flags.ab === "rerank") {
    // `enabled` pins each column so ambient RERANK=1 can't leak into the baseline.
    return { ab: "rerank",
      baseline: { label: "rerank off", cfg: { ...base, rerank: false, enabled: false } },
      variant: { label: "rerank on", cfg: { ...base, rerank: true, enabled: true } } };
  }
  return { ab: null, baseline: { label: "value", cfg: base } };
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (!flags.dataset) { console.error('Usage: node eval/run-eval.mjs --dataset PATH [--corpus PATH] [--k 5,10] [--mode keyword|semantic|hybrid] [--ab decay|rerank] [--decay-scores PATH] [--rerank] [--out PATH]'); process.exit(2); }
  flags.decayScores = flags["decay-scores"]; // normalise kebab flag

  const mode = flags.mode || "hybrid";
  if (!["keyword", "semantic", "hybrid"].includes(mode)) { console.error(`❌ unknown --mode "${mode}" (use keyword | semantic | hybrid).`); process.exit(2); }
  if (flags.ab && !["decay", "rerank"].includes(flags.ab)) { console.error(`❌ unknown --ab "${flags.ab}" (use decay | rerank).`); process.exit(2); }
  const ks = parseKs(flags.k);

  // --- load dataset ---
  if (!fs.existsSync(flags.dataset)) { console.error(`❌ dataset not found: ${flags.dataset}`); process.exit(1); }
  const ds = loadDataset(flags.dataset);
  for (const w of ds.warnings) console.error(`  ⚠ ${w}`);
  if (!ds.queries.length) { console.error("❌ no usable queries in dataset (need at least one line with a query and a non-empty relevant array)."); process.exit(1); }

  // --- locate + load corpus (default: <dataset-basename>-corpus.jsonl beside the dataset) ---
  const corpusPath = flags.corpus || flags.dataset.replace(/\.jsonl?$/i, "") + "-corpus.jsonl";
  if (!fs.existsSync(corpusPath)) { console.error(`❌ corpus not found: ${corpusPath}\n   pass --corpus PATH, or place it beside the dataset as <name>-corpus.jsonl`); process.exit(1); }
  const corpus = loadCorpus(corpusPath);
  if (!corpus.length) { console.error(`❌ corpus is empty or unparseable: ${corpusPath}`); process.exit(1); }

  const decayEntries = flags.decayScores ? loadDecayEntries(flags.decayScores) : {};

  // --- MODEL GATE (semantic/hybrid need arctic-embed; keyword does not) ---
  const needsModel = mode === "semantic" || mode === "hybrid";
  if (needsModel && !fs.existsSync(EMBED_MODEL)) {
    console.error(
`\n⏭  Embedding model not found — cannot run "${mode}" mode.
   expected: ${EMBED_MODEL}

   To obtain it, run the suite installer (downloads + sha256-verifies the GGUF, see PORTABILITY.md):
       ./install.sh
   or place the arctic-embed-l-v2.0 f16 GGUF at the path above and set $OPENCLAW_WORKSPACE if needed.

   No model? You can still run the harness end-to-end with keyword retrieval:
       node eval/run-eval.mjs --dataset ${flags.dataset} --mode keyword
`);
    process.exit(0); // clean exit — model absence is expected, not an error
  }

  // --- build index + embed queries (only when a model is needed) ---
  let engine = null;
  const index = { chunks: corpus.map((d) => ({ id: d.id, text: d.text, type: d.type, vector: null })) };
  const embedded = {}; // query → qVec
  if (needsModel) {
    try { engine = await loadEngine(); }
    catch (e) { console.error(`❌ could not load the embedding runtime (node-llama-cpp): ${e && e.message}\n   Try: ./install.sh   — or run with --mode keyword.`); process.exit(1); }
    process.stderr.write("  embedding corpus… ");
    for (const c of index.chunks) c.vector = await engine.embed(c.text);
    process.stderr.write("queries… ");
    for (const { query } of ds.queries) embedded[query] = await engine.embed((engine.QUERY_PREFIX || QUERY_PREFIX) + query);
    process.stderr.write("done\n");
  }

  // --- run baseline (+ variant) ---
  const plan = planConfigs(flags, decayEntries);
  const nowMs = Date.now();
  const withNow = (cfg) => ({ ...cfg, k: Math.max(...ks), nowMs });
  const baseline = await evalConfig(ds.queries, index, withNow(plan.baseline.cfg), ks, embedded);
  let variant = null;
  if (plan.ab) variant = await evalConfig(ds.queries, index, withNow(plan.variant.cfg), ks, embedded);

  // --- print ---
  console.log(`\n📊 eval: ${path.basename(flags.dataset)}  ·  ${ds.queries.length} queries  ·  corpus ${corpus.length} docs  ·  mode=${mode}  ·  k=${ks.join(",")}`);
  if (plan.ab) {
    console.log(`   A/B: ${plan.ab}  (${plan.baseline.label}  vs  ${plan.variant.label})`);
    printAB(plan.baseline.label, baseline.aggregate, plan.variant.label, variant.aggregate, ks);
    if (plan.ab === "rerank" && plan.variant.cfg.rerank) {
      const rerankModel = `${WS}/node-llama-cpp/models/bge-reranker-v2-m3-Q8_0.gguf`;
      if (!fs.existsSync(rerankModel)) console.log(`\n   note: reranker model absent (${path.basename(rerankModel)}) ⇒ "rerank on" degrades to baseline (Δ≈0). Install it to measure a real delta.`);
    }
    if (plan.ab === "decay" && !flags.decayScores) console.log(`\n   note: no --decay-scores given ⇒ decay has no entries ⇒ Δ≈0. Pass a decay store to measure an effect.`);
  } else {
    printSingle(plan.baseline.label, baseline.aggregate, ks);
  }

  // --- JSON report ---
  if (!flags.noReport) {
    const outPath = flags.out || path.join(path.dirname(fileURLToPath(import.meta.url)), "reports", "eval-report.json");
    const report = {
      generatedAt: new Date().toISOString(),
      dataset: flags.dataset, corpus: corpusPath, mode, k: ks,
      queries: ds.queries.length, skipped: ds.skipped,
      ab: plan.ab, warnings: ds.warnings,
      baseline: { label: plan.baseline.label, ...baseline },
      variant: plan.ab ? { label: plan.variant.label, ...variant } : null,
    };
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`\n📝 report → ${outPath}`);
    } catch (e) { console.error(`  ⚠ could not write report: ${e && e.message}`); }
  }

  if (engine) await engine.dispose();
}

// Only run the CLI when executed directly — importing this module (e.g. from a test) must NOT run main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
