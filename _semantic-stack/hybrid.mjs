// Hybrid memory search: semantic (arctic-embed) + keyword, merged via Reciprocal Rank Fusion.
// Optional metadata filters by dimension (article's "filter by type/time/topic/status").
// Usage: node hybrid.mjs "query" [k] [--type T] [--status S] [--tag G]
import { INDEX_PATH, QUERY_PREFIX, embed, cosine, dispose, fs } from "./common.mjs";
import { loadDecayScores, decayFactor, recordAccess } from "./decay.mjs";
import { rerankStage, disposeRerank } from "./rerank.mjs";
import { openVecStore, isVecStoreEnabled, vecStoreMode, vecDbPath, vecPoolSize } from "./vecstore.mjs";

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--rerank") flags.rerank = true;            // OPTIONAL final rerank stage (boolean flag; no value)
  else if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const query = pos[0];
const k = parseInt(pos[1] || "8", 10);
if (!query) { console.error('Usage: msem "query" [k] [--type T] [--status S] [--tag G]'); process.exit(1); }
const filterDesc = ["type", "status", "tag"].filter((f) => flags[f]).map((f) => `${f}=${flags[f]}`).join(" ");

// ── semantic candidate source ────────────────────────────────────────────────────────────────────────
// DEFAULT: full index.json scan + JS cosine over every chunk (the `if (!viaVec)` block below — UNCHANGED).
// OPT-IN: when sqlite-vec is enabled (VECSTORE=sqlite / auto above the chunk threshold) AND the derived db
// + its native deps are present, fetch the semantic candidate set from the db instead (no whole-JSON load,
// no JS cosine over every chunk). ANY miss — opted-out, deps absent, db missing, dim mismatch, error, or an
// empty result — leaves viaVec=false and the JSON path runs EXACTLY as before. Only this FETCH changes; the
// keyword + RRF + decay + rerank stages downstream are byte-for-byte identical for either backend.
let chunks = null, qv = null, viaVec = false;
if (vecStoreMode(process.env) !== "off") {
  const store = await openVecStore(vecDbPath(process.env));
  if (store) {
    try {
      if (isVecStoreEnabled(store.chunkCount, process.env)) {
        qv = await embed(QUERY_PREFIX + query);
        if (qv.length === store.dim) {
          const cands = store.topK(qv, vecPoolSize(k, process.env), { type: flags.type, status: flags.status, tag: flags.tag });
          if (cands && cands.length) {
            // Reconstruct the index.json chunk order (by ord) so RRF/decay tie-breaks match the JSON path.
            // vec candidates carry their stored vector (bit-identical to index.json's) so semScore below is
            // computed by the SAME f64 cosine() as the JSON path ⇒ identical ranking, not sqlite's f32 distance.
            cands.sort((x, y) => x.ord - y.ord);
            chunks = cands.map((c) => ({ rel: c.path, startLine: c.startLine, text: c.text, vector: c.vector, type: c.meta.type }));
            viaVec = true;
          }
        }
      }
    } catch { viaVec = false; } // never let the accelerator break search — fall through to JSON
    store.close();
  }
}

if (!viaVec) {
  if (!fs.existsSync(INDEX_PATH)) { console.error("❌ No index. Run: node index.mjs"); process.exit(1); }
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  chunks = [];
  for (const [rel, entry] of Object.entries(index.files)) {
    const meta = entry.meta || { type: "note", status: "active", tags: [] };
    if (flags.type && meta.type !== flags.type) continue;
    if (flags.status && meta.status !== flags.status) continue;
    if (flags.tag && !(meta.tags || []).includes(flags.tag)) continue;
    for (const c of entry.chunks) chunks.push({ rel, startLine: c.startLine, text: c.text, vector: c.vector, type: meta.type });
  }
  if (chunks.length === 0) { console.log(`❌ No chunks match filters (${filterDesc}).`); process.exit(0); }
  if (qv === null) qv = await embed(QUERY_PREFIX + query); // reuse qv if a vec attempt already embedded it
}

// semantic — one shared line for BOTH backends (JSON scan or vec pool). Byte-for-byte identical to the
// original when viaVec is false; identical ranking when viaVec is true (same vectors, same cosine()).
await dispose();
const semScore = chunks.map((c) => cosine(qv, c.vector));

// keyword
const STOP = new Set("the and for with that this from dari dan yang untuk atau ke di ada itu aku kamu apa how what why".split(/\s+/));
const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
const kwScore = chunks.map((c) => {
  const t = c.text.toLowerCase();
  let s = 0;
  for (const term of terms) s += t.split(term).length - 1;
  if (terms.some((term) => c.rel.toLowerCase().includes(term))) s += 3;
  return s;
});

// Reciprocal Rank Fusion
const RRF_K = 60;
const semRank = new Map([...chunks.keys()].sort((a, b) => semScore[b] - semScore[a]).map((idx, r) => [idx, r]));
const kwRank = new Map([...chunks.keys()].filter((i) => kwScore[i] > 0).sort((a, b) => kwScore[b] - kwScore[a]).map((idx, r) => [idx, r]));
const merged = [...chunks.keys()].map((i) => {
  let rrf = 0;
  if (semRank.has(i)) rrf += 1 / (RRF_K + semRank.get(i));
  if (kwRank.has(i)) rrf += 1 / (RRF_K + kwRank.get(i));
  return { i, rrf, sem: semScore[i], kw: kwScore[i], factor: 1 };
}).sort((a, b) => b.rrf - a.rrf);

// Post-fusion memory-decay re-rank: multiply each candidate's RRF by its file's decay factor, then re-sort.
// Backward-compat: no entries ⇒ we skip re-ranking entirely, so the array stays the exact RRF order (factor 1.0).
const decay = loadDecayScores();
if (Object.keys(decay.entries).length) {
  const nowMs = Date.now();
  for (const r of merged) { r.factor = decayFactor(decay.entries[chunks[r.i].rel], nowMs); r.score = r.rrf * r.factor; }
  merged.sort((a, b) => (b.score ?? b.rrf) - (a.score ?? a.rrf));
}

// OPTIONAL final stage — cross-encoder rerank of the decay-ordered head (OFF by default; model-gated).
// Disabled OR reranker model/runtime unavailable ⇒ `ordered` === `merged`, so everything below is
// byte-for-byte identical to today. Enable with RERANK=1 env or the --rerank flag (needs the reranker model).
const rr = await rerankStage(query, merged, (r) => chunks[r.i].text, { k, rerank: flags.rerank === true });
const ordered = rr.ranked;

console.log(`🔎 hybrid: "${query}"${filterDesc ? " [" + filterDesc + "]" : ""}  (${chunks.length} chunks · kw: ${terms.join(", ") || "none"})\n`);
if (rr.applied) console.log(`   ⟲ reranked top ${rr.scored} via ${rr.model} (cross-encoder)\n`);
for (const r of ordered.slice(0, k)) {
  const c = chunks[r.i];
  const snip = c.text.replace(/\s+/g, " ").slice(0, 150);
  console.log(`  rrf ${r.rrf.toFixed(4)} | ×${r.factor.toFixed(2)} | sem ${r.sem.toFixed(3)} | kw ${r.kw} | [${c.type}]  ${c.rel}:${c.startLine}`);
  console.log(`         ${snip}\n`);
}

// Living signal (best-effort, never fails/slows search): reinforce the files we actually returned.
recordAccess([...new Set(ordered.slice(0, k).map((r) => chunks[r.i].rel))]);
if (rr.applied) await disposeRerank();
