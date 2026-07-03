// Hybrid memory search: semantic (arctic-embed) + keyword, merged via Reciprocal Rank Fusion.
// Optional metadata filters by dimension (article's "filter by type/time/topic/status").
// Usage: node hybrid.mjs "query" [k] [--type T] [--status S] [--tag G]
import { INDEX_PATH, QUERY_PREFIX, embed, cosine, dispose, fs } from "./common.mjs";
import { loadDecayScores, decayFactor, recordAccess } from "./decay.mjs";

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const query = pos[0];
const k = parseInt(pos[1] || "8", 10);
if (!query) { console.error('Usage: msem "query" [k] [--type T] [--status S] [--tag G]'); process.exit(1); }
if (!fs.existsSync(INDEX_PATH)) { console.error("❌ No index. Run: node index.mjs"); process.exit(1); }

const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
const chunks = [];
for (const [rel, entry] of Object.entries(index.files)) {
  const meta = entry.meta || { type: "note", status: "active", tags: [] };
  if (flags.type && meta.type !== flags.type) continue;
  if (flags.status && meta.status !== flags.status) continue;
  if (flags.tag && !(meta.tags || []).includes(flags.tag)) continue;
  for (const c of entry.chunks) chunks.push({ rel, startLine: c.startLine, text: c.text, vector: c.vector, type: meta.type });
}
const filterDesc = ["type", "status", "tag"].filter((f) => flags[f]).map((f) => `${f}=${flags[f]}`).join(" ");
if (chunks.length === 0) { console.log(`❌ No chunks match filters (${filterDesc}).`); process.exit(0); }

// semantic
const qv = await embed(QUERY_PREFIX + query);
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

console.log(`🔎 hybrid: "${query}"${filterDesc ? " [" + filterDesc + "]" : ""}  (${chunks.length} chunks · kw: ${terms.join(", ") || "none"})\n`);
for (const r of merged.slice(0, k)) {
  const c = chunks[r.i];
  const snip = c.text.replace(/\s+/g, " ").slice(0, 150);
  console.log(`  rrf ${r.rrf.toFixed(4)} | ×${r.factor.toFixed(2)} | sem ${r.sem.toFixed(3)} | kw ${r.kw} | [${c.type}]  ${c.rel}:${c.startLine}`);
  console.log(`         ${snip}\n`);
}

// Living signal (best-effort, never fails/slows search): reinforce the files we actually returned.
recordAccess([...new Set(merged.slice(0, k).map((r) => chunks[r.i].rel))]);
