// index-transcripts.mjs — build/update the DEEP transcript index (separate, sharded store).
//   node index-transcripts.mjs --backfill    [--src engineer|threads|archive|cc|all] [--cc-dir <path>] [--max N] [--dry]
//   node index-transcripts.mjs --incremental  [...]
// Sharded per src+month at memory/.semantic/transcripts/<src>-<YYYY-MM>.json ; cursor at .cursor.json
// Claude Code sessions shard per project-slug too: transcripts/cc-<slug>-<YYYY-MM>.json (recall as --src cc).
import { WS, embed, dispose, fs, path } from "./common.mjs";
import { parseFile, kindOf } from "./transcripts.mjs";
import { redact } from "./redact.mjs";
import os from "node:os";

const DIR = `${WS}/memory/.semantic/transcripts`;
const CURSOR = `${DIR}/.cursor.json`;
const BATCH = 16;
const MODEL = "snowflake-arctic-embed-l-v2.0-f16.gguf";
// Legacy "engineer" transcript dir (OpenClaw-bundled Claude Code). Override with $CLAUDE_PROJECTS_DIR.
// If this dir is absent (e.g. no such sessions on this host), engineer indexing is skipped gracefully
// (walkJsonl() returns [] for a missing dir), so the run still indexes threads + archives.
const ENG = process.env.CLAUDE_PROJECTS_DIR || `${process.env.HOME}/.openclaw/.claude/projects`;
// Standalone Claude Code projects root. Opt-in: indexed only when --cc-dir is passed or --src cc|claude-code.
// Override the default with $CC_PROJECTS_DIR. Missing dir → walkJsonl() returns [] → skipped gracefully.
const CC_DEFAULT = process.env.CC_PROJECTS_DIR || `${process.env.HOME}/.claude/projects`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const incremental = has("--incremental");
const dry = has("--dry");
const srcFilter = val("--src", "all");
const maxEmbed = parseInt(val("--max", "100000"), 10);
// Claude Code discovery is additive/opt-in: triggered by --cc-dir <path> or --src cc|claude-code.
const ccDir = val("--cc-dir", null);
const ccWanted = ccDir != null || srcFilter === "cc" || srcFilter === "claude-code";
const ccRoot = ccWanted ? (ccDir || CC_DEFAULT) : null;

// Cross-platform via Node's `os`. The old /proc reads were Linux-only (silently no-op on macOS/BSD).
// CAVEAT: os.freemem() is NOT comparable across OSes. On Linux it ≈ MemFree (conservative but meaningful).
// On macOS it counts only truly-free pages — macOS holds most RAM as reclaimable cache, so freemem reads
// FAR below actually-available memory, and a fixed floor false-trips on essentially every run (exactly what
// broke transcript indexing on macOS). So the floor is OS-aware + env-tunable:
//   darwin → 0 (disabled; rely on the loadavg entry-guard + the OS memory manager/compressor)
//   linux  → 350MB    ·    override either with TRANSCRIPT_MIN_FREE_MB=<mb>
const MIN_FREE_MB = Number(process.env.TRANSCRIPT_MIN_FREE_MB) || (os.platform() === "darwin" ? 0 : 350);
function memAvailMB() { return os.freemem() / (1024 * 1024); }
// mid-run we ONLY guard memory (anti-OOM): embedding itself pegs the single core, so a load check mid-run would pause us on our own work.
function memGuard() {
  if (MIN_FREE_MB <= 0) return null; // disabled (macOS default): freemem underreports available RAM there
  const a = memAvailMB();
  return a < MIN_FREE_MB ? `free mem ${a.toFixed(0)}MB of ${(os.totalmem() / (1024 * 1024)).toFixed(0)}MB too low` : null;
}
// ambient load matters only BEFORE we start (is something else hammering the box?).
function entryGuard() {
  const load = os.loadavg()[0]; // 1-min load average (0 on platforms without support, e.g. Windows)
  if (load > 2.5) return `ambient load ${load.toFixed(2)} too high`;
  return memGuard();
}
// distinguish "missing" (expected on first run → use default) from "corrupt" (ABORT — never overwrite good data with {}).
function loadJson(f, d) {
  if (!fs.existsSync(f)) return d;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { console.error(`❌ ${f} exists but is corrupt/unparseable (${e.message}); aborting so indexed data isn't overwritten. Move it aside, then re-run.`); process.exit(1); }
}
function walkJsonl(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(p);
  }
  return acc;
}
// project-slug for a Claude Code file = its dir path relative to the CC root, sanitized for a filename.
//   <ccRoot>/-Users-rin/<uuid>.jsonl → "Users-rin"   (a file directly under the root → "root")
function ccSlug(root, file) {
  const rel = path.relative(root, path.dirname(file));
  const s = rel.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "root";
}
// Each entry: { file, kind (parser selector), src (shard/-src token + stored label), slug (CC only) }.
function sources() {
  const out = [];
  const add = (f) => { const k = kindOf(f); if (fs.existsSync(f) && k && (srcFilter === "all" || k === srcFilter)) out.push({ file: f, kind: k, src: k, slug: null }); };
  walkJsonl(`${WS}/memory/threads`).forEach(add);
  for (const f of fs.readdirSync(`${WS}/memory`)) if (f.startsWith("session-archive") && f.endsWith(".jsonl")) add(`${WS}/memory/${f}`);
  walkJsonl(ENG).forEach(add);
  // Standalone Claude Code sessions (opt-in): kind "claude-code" (parser) → shard/recall token "cc",
  // sharded per project-slug + month. Dedup by path so a dir shared with ENG isn't indexed twice.
  if (ccRoot) {
    const seen = new Set(out.map((o) => o.file));
    for (const f of walkJsonl(ccRoot)) if (!seen.has(f)) out.push({ file: f, kind: "claude-code", src: "cc", slug: ccSlug(ccRoot, f) });
  }
  return out;
}
function shardPath(src, ts, slug) {
  const m = ts && /^\d{4}-\d{2}/.test(String(ts)) ? String(ts).slice(0, 7) : "undated";
  const tag = slug ? `${src}-${slug}` : src;
  return `${DIR}/${tag}-${m}.json`;
}

// --- crash-safe writes: single-writer lock + atomic replace (no torn/lost shards or cursor) ---
const LOCK = `${DIR}/.lock`;
const LOCK_STALE_MS = 3 * 60 * 60 * 1000; // steal a lock left behind by a crashed run (>3h old)
let _lockHeld = false;
function acquireLock() {
  try {
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
function writeJsonAtomic(target, obj) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj)); // write sidecar…
  fs.renameSync(tmp, target);                 // …then atomically swap over the real file
}

const g = entryGuard();
if (g) { console.error(`⏭  skip run: ${g}`); process.exit(0); }

fs.mkdirSync(DIR, { recursive: true });
if (!acquireLock()) { console.error(`⏭  skip run: another indexer holds ${LOCK}`); process.exit(0); }
const cursor = loadJson(CURSOR, {});
const files = sources();
const shards = {};
function getShard(p, src) {
  if (shards[p]) return shards[p];
  const s = loadJson(p, { meta: { model: MODEL, dim: 0, src }, items: [] });
  s._ids = new Set(s.items.map((x) => x.id));
  return (shards[p] = s);
}

let scanned = 0, newUnits = 0, embedded = 0, redactedTot = 0, dupSkip = 0, stop = false;
outer:
for (const { file, kind, src, slug } of files) {
  const st = fs.statSync(file);
  const cur = cursor[file] || { size: 0, mtime: 0, linesIndexed: 0 };
  if (incremental && cur.size === st.size && cur.mtime === st.mtimeMs) continue; // unchanged
  scanned++;
  const { units, lineCount } = parseFile(file, incremental ? cur.linesIndexed : 0, kind);
  for (const u of units) {
    const shard = getShard(shardPath(src, u.ts, slug), src);
    if (shard._ids.has(u.id)) { dupSkip++; continue; }
    newUnits++;
    const r = redact(u.text); redactedTot += r.redacted;
    if (dry) { shard._ids.add(u.id); continue; }
    let vector; try { vector = await embed(r.text); } catch { continue; }
    shard.meta.dim = vector.length;
    shard.items.push({ id: u.id, file: u.file, line: u.line, ts: u.ts, role: u.role, src, sub: u.sub, text: r.text, vector });
    shard._ids.add(u.id);
    embedded++;
    if (embedded % BATCH === 0) {
      await new Promise((r) => setTimeout(r, 15));
      const gg = memGuard(); if (gg) { console.error(`⏸  pausing (mem): ${gg}`); stop = true; break outer; }
    }
    if (embedded >= maxEmbed) { console.error(`⏸  hit --max ${maxEmbed}`); stop = true; break outer; }
  }
  if (!stop) cursor[file] = { size: st.size, mtime: st.mtimeMs, linesIndexed: lineCount };
}

try {
  if (!dry) {
    for (const [p, s] of Object.entries(shards)) {
      const { _ids, ...rest } = s; rest.meta.builtAt = new Date().toISOString();
      writeJsonAtomic(p, rest);
    }
    writeJsonAtomic(CURSOR, cursor);
  }
} finally {
  releaseLock();
}
await dispose();
console.log(`✅ transcripts: scanned ${scanned} files · ${newUnits} new units · embedded ${embedded} · redacted ${redactedTot} secrets · dup-skip ${dupSkip}${stop ? " · CAPPED (rerun to continue)" : ""}`);

// fail-loud: a changed file yielded zero new units AND zero dups → parser likely broke
if (!dry && scanned > 0 && newUnits === 0 && dupSkip === 0) {
  console.error("⚠️  scanned changed files but produced 0 units — check parsers."); process.exit(2);
}
