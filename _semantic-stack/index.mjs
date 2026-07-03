// Build / update the semantic memory index.
//   node index.mjs              full rebuild
//   node index.mjs --incremental   only re-embed changed files
import { WS, INDEX_PATH, MODEL, embed, chunkText, parseMeta, dispose, writeJsonAtomic, fs, path } from "./common.mjs";

const MEM = `${WS}/memory`;
const EXCLUDE = [/\/backup-/, /\/archive\//, /\/checkpoints\//, /\.search-cache/, /\.semantic/, /\/dreaming\//, /\/subagents\//, /-log\.md$/, /session-archive/];
const ROOT_FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "MEMORY.md", "DECISIONS.md", "HEARTBEAT.md", "DREAMS.md", "AGENTS.md"];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (EXCLUDE.some((rx) => rx.test(p))) continue;
    if (e.isSymbolicLink()) continue; // skip symlinks: targets are walked directly (avoids dupes + dangling links)
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

const incremental = process.argv.includes("--incremental");
const files = [
  ...ROOT_FILES.map((f) => `${WS}/${f}`).filter((f) => fs.existsSync(f)),
  ...walk(MEM),
];

// --- crash-safe writes: single-writer lock + atomic replace (no torn/lost index.json) ---
const LOCK = `${INDEX_PATH}.lock`;
const LOCK_STALE_MS = 3 * 60 * 60 * 1000; // steal a lock left behind by a crashed run (>3h old)
let _lockHeld = false;
function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" }); // exclusive create; EEXIST if held
    return (_lockHeld = true);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.rmSync(LOCK, { force: true }); return acquireLock(); } } catch {}
    return false;
  }
}
function releaseLock() { if (_lockHeld) { try { fs.rmSync(LOCK, { force: true }); } catch {} _lockHeld = false; } }
process.on("exit", releaseLock); // also fires on process.exit()/uncaught throw
// writeJsonAtomic (crash-safe tmp+rename) now lives in common.mjs — shared with decay.mjs.

if (!acquireLock()) { console.error(`⏭  another index build holds ${LOCK}; skipping this run.`); process.exit(0); }

let index = { meta: { model: path.basename(MODEL), dim: 0, builtAt: "" }, files: {} };
if (incremental && fs.existsSync(INDEX_PATH)) {
  // corrupt/partial existing index → ABORT (never silently reset to {} and overwrite good vectors).
  try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")); }
  catch (e) {
    console.error(`❌ existing ${INDEX_PATH} is corrupt/unparseable (${e.message}); aborting so it isn't overwritten with a fresh index. Move it aside, then run a full rebuild: node index.mjs`);
    process.exit(1);
  }
}

const present = new Set(files.map((f) => path.relative(WS, f)));
for (const rel of Object.keys(index.files)) if (!present.has(rel)) delete index.files[rel]; // drop deleted

let reused = 0, embedded = 0, chunkCount = 0;
for (const file of files) {
  const rel = path.relative(WS, file);
  const mtime = fs.statSync(file).mtimeMs;
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
  const meta = parseMeta(rel, raw);
  if (incremental && index.files[rel] && index.files[rel].mtime === mtime) {
    index.files[rel].meta = meta; // refresh metadata cheaply, reuse existing vectors
    reused += index.files[rel].chunks.length; chunkCount += index.files[rel].chunks.length; continue;
  }
  const chunks = chunkText(raw, 900);
  const out = [];
  for (const c of chunks) {
    let vector;
    try { vector = await embed(c.text); } catch { continue; } // skip un-embeddable chunk, keep build alive
    index.meta.dim = vector.length;
    out.push({ startLine: c.startLine, text: c.text, vector });
    embedded++;
  }
  index.files[rel] = { mtime, meta, chunks: out };
  chunkCount += out.length;
  process.stdout.write(`\r  indexed ${embedded} new chunks (reused ${reused})…`);
}

index.meta.builtAt = new Date().toISOString();
writeJsonAtomic(INDEX_PATH, index);
await dispose();
console.log(`\n✅ index: ${Object.keys(index.files).length} files, ${chunkCount} chunks (embedded ${embedded}, reused ${reused}) → ${INDEX_PATH}`);
releaseLock();
