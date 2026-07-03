// deep.mjs — DEEP recall: curated index ∪ transcript shards, hybrid (semantic + keyword) via RRF.
//   node deep.mjs "query" [k] [--src engineer|threads|archive] [--after YYYY-MM-DD] [--before YYYY-MM-DD]
import { WS, INDEX_PATH, QUERY_PREFIX, embed, cosine, dispose, fs, path } from "./common.mjs";
import { loadDecayScores, decayFactor, recordAccess } from "./decay.mjs";

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]); }
const query = pos[0];
const k = parseInt(pos[1] || "8", 10);
if (!query) { console.error('Usage: mdeep "query" [k] [--src S] [--after YYYY-MM-DD] [--before YYYY-MM-DD]'); process.exit(1); }

const chunks = [];
// curated index (unchanged store)
if (fs.existsSync(INDEX_PATH)) {
  const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  for (const [rel, e] of Object.entries(idx.files))
    for (const c of e.chunks) chunks.push({ source: `mem:${(e.meta && e.meta.type) || "note"}`, rel, ref: `${rel}:${c.startLine}`, text: c.text, vector: c.vector, ts: (e.meta && e.meta.date) || "" });
}
// transcript shards
const TDIR = `${WS}/memory/.semantic/transcripts`;
if (fs.existsSync(TDIR)) {
  for (const f of fs.readdirSync(TDIR)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    const src = f.split("-")[0];
    if (flags.src && src !== flags.src) continue;
    let shard; try { shard = JSON.parse(fs.readFileSync(path.join(TDIR, f), "utf8")); } catch { continue; }
    for (const it of shard.items || []) {
      const day = String(it.ts || "").slice(0, 10);
      if (flags.after && day && day < flags.after) continue;
      if (flags.before && day && day > flags.before) continue;
      chunks.push({ source: `tx:${it.src}`, rel: null, ref: `${path.relative(WS, it.file)}:${it.line}`, text: it.text, vector: it.vector, ts: it.ts });
    }
  }
}
if (!chunks.length) { console.error("❌ no chunks indexed yet."); process.exit(1); }

const qv = await embed(QUERY_PREFIX + query); await dispose();
const sem = chunks.map((c) => cosine(qv, c.vector));
const STOP = new Set("the and for with that this from dari dan yang untuk atau ke di ada itu aku kamu apa".split(/\s+/));
const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
const kw = chunks.map((c) => { const t = c.text.toLowerCase(); let s = 0; for (const term of terms) s += t.split(term).length - 1; return s; });

const RRF = 60;
const semRank = new Map([...chunks.keys()].sort((a, b) => sem[b] - sem[a]).map((idx, r) => [idx, r]));
const kwRank = new Map([...chunks.keys()].filter((i) => kw[i] > 0).sort((a, b) => kw[b] - kw[a]).map((idx, r) => [idx, r]));
const merged = [...chunks.keys()].map((i) => {
  let r = 0;
  if (semRank.has(i)) r += 1 / (RRF + semRank.get(i));
  if (kwRank.has(i)) r += 1 / (RRF + kwRank.get(i));
  return { i, r, sem: sem[i], kw: kw[i], factor: 1 };
}).sort((a, b) => b.r - a.r);

// Post-fusion memory-decay re-rank (shared with msem). Only curated files carry a rel/entry; transcript
// chunks have rel=null ⇒ factor 1.0 (neutral). No entries ⇒ skip re-ranking ⇒ exact RRF order preserved.
const decay = loadDecayScores();
if (Object.keys(decay.entries).length) {
  const nowMs = Date.now();
  for (const m of merged) { m.factor = decayFactor(decay.entries[chunks[m.i].rel], nowMs); m.score = m.r * m.factor; }
  merged.sort((a, b) => (b.score ?? b.r) - (a.score ?? a.r));
}

const nTx = chunks.filter((c) => c.source.startsWith("tx")).length;
console.log(`🔎 deep: "${query}"  (${chunks.length} chunks: ${nTx} transcript + ${chunks.length - nTx} curated · kw: ${terms.join(", ") || "none"})\n`);
for (const m of merged.slice(0, k)) {
  const c = chunks[m.i];
  console.log(`  rrf ${m.r.toFixed(4)} | ×${m.factor.toFixed(2)} | sem ${m.sem.toFixed(3)} | kw ${m.kw} | [${c.source}${c.ts ? " " + String(c.ts).slice(0, 10) : ""}] ${c.ref}`);
  console.log(`        ${c.text.replace(/\s+/g, " ").slice(0, 150)}\n`);
}

// Living signal (best-effort): reinforce the curated files we returned (transcript rel=null is skipped).
recordAccess([...new Set(merged.slice(0, k).map((m) => chunks[m.i].rel))]);
