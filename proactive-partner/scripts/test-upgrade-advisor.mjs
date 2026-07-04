// test-upgrade-advisor.mjs — pure-logic tests for scripts/upgrade-advisor.sh (the provider-free
// optional-flag advisor). Drives the REAL bash script with SYNTHETIC workspaces (crafted index.json
// chunk counts, file mtimes, crontab source, dep/model presence) and asserts the recommendations.
//
// No model, no network, no node_modules — just fs + a child bash process. Mirrors the inline-runner
// style of the _semantic-stack tests.  Run:  node test-upgrade-advisor.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVISOR = path.join(HERE, "upgrade-advisor.sh");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-advisor-test-"));
let caseN = 0;

// --- tiny inline runner (mirrors test-vecstore/test-rerank) -----------------
let assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  has: (set, f, m) => { assertCount++; assert.ok(set.has(f), m || `expected rec ${f}`); },
  hasNot: (set, f, m) => { assertCount++; assert.ok(!set.has(f), m || `did NOT expect rec ${f}`); },
  match: (s, re, m) => { assertCount++; assert.ok(re.test(s), m || `expected ${re} in: ${s}`); },
};

// Write a single-line index.json (like the real writer) whose files[*].chunks total `nChunks`.
function writeIndex(p, nChunks) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const chunks = [];
  for (let i = 0; i < nChunks; i++) chunks.push({ startLine: i + 1, text: "t", vector: [] });
  const index = { meta: { model: "m", dim: 4, builtAt: "" }, files: { "memory/00-core/note.md": { mtime: 0, meta: {}, chunks } } };
  fs.writeFileSync(p, JSON.stringify(index)); // single-line — matches store.mjs writeJsonAtomic
}

// Build a synthetic case: full control over every probe the advisor reads. Returns { env }.
// opts: { chunks, noIndex, stale, deps, model, cron, sqliteThreshold, rerankerThreshold }
//   deps/model default TRUE (healthy);  cron default "present";  content default older (fresh).
function makeCase(opts = {}) {
  const dir = path.join(ROOT, "c" + (++caseN));
  const mem = path.join(dir, "memory");
  const sem = path.join(mem, ".semantic");
  const index = path.join(sem, "index.json");
  const models = path.join(dir, "models");
  const nm = path.join(dir, "node_modules");
  fs.mkdirSync(path.join(mem, "00-core"), { recursive: true });
  fs.mkdirSync(sem, { recursive: true });
  fs.mkdirSync(models, { recursive: true });
  fs.mkdirSync(nm, { recursive: true });

  const env = { ...process.env };
  delete env.VECSTORE_THRESHOLD; // don't let the ambient engine tuning leak into default cases
  env.ADVISOR_MEMORY_DIR = mem;
  env.ADVISOR_INDEX = index;
  env.ADVISOR_RERANKER_MODEL = path.join(models, "bge-reranker-v2-m3-Q8_0.gguf");
  env.ADVISOR_SQLITE_VEC_DIR = nm;
  env.ADVISOR_INSTALL_CMD = "INSTALL"; // fixed prefix ⇒ deterministic cmd assertions

  // index.json (unless we're testing the missing-index guard)
  if (!opts.noIndex && opts.chunks !== undefined) writeIndex(index, opts.chunks);

  // one content .md for the staleness probe
  const content = path.join(mem, "00-core", "note.md");
  fs.writeFileSync(content, "# note\ncontent\n");

  // mtimes (epoch seconds): index fixed; content newer (stale) or older (fresh)
  const idxT = 2_000_000;
  const contentT = opts.stale ? idxT + 5000 : idxT - 5000;
  if (fs.existsSync(index)) fs.utimesSync(index, idxT, idxT);
  fs.utimesSync(content, contentT, contentT);

  // crontab source: "present" (has tag) | "absent" (file w/o tag) | "missing" (unreadable ⇒ guard)
  const cron = opts.cron || "present";
  if (cron === "missing") {
    env.ADVISOR_CRONTAB_FILE = path.join(dir, "no-such-crontab");
  } else {
    const cf = path.join(dir, "crontab.txt");
    let body = "# unrelated\n0 0 * * * echo hi\n";
    if (cron === "present") body += "30 3 * * * cd x && node index.mjs # memory-suite-reindex\n";
    fs.writeFileSync(cf, body);
    env.ADVISOR_CRONTAB_FILE = cf;
  }

  // sqlite-vec deps present? (default yes)
  if (opts.deps !== false) { fs.mkdirSync(path.join(nm, "better-sqlite3")); fs.mkdirSync(path.join(nm, "sqlite-vec")); }
  // reranker model present? (default yes)
  if (opts.model !== false) fs.writeFileSync(env.ADVISOR_RERANKER_MODEL, "GGUF");

  if (opts.sqliteThreshold !== undefined) env.ADVISOR_SQLITE_VEC_THRESHOLD = String(opts.sqliteThreshold);
  if (opts.rerankerThreshold !== undefined) env.ADVISOR_RERANKER_THRESHOLD = String(opts.rerankerThreshold);

  return { env };
}

// Run the advisor; parse UPGRADE_REC lines into { flags:Set, recs:{flag→kv}, stdout, status }.
function run(env) {
  let stdout = "", status = 0;
  try {
    stdout = execFileSync("bash", [ADVISOR, "/synthetic/ws"], { env, encoding: "utf8" });
  } catch (e) { stdout = String(e.stdout || ""); status = e.status == null ? 1 : e.status; }
  const flags = new Set(), recs = {};
  for (const line of stdout.split("\n")) {
    if (line.indexOf("UPGRADE_REC") !== 0) continue;
    const kv = {};
    for (const part of line.split("\t").slice(1)) { const i = part.indexOf("="); if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1); }
    if (kv.flag) { flags.add(kv.flag); recs[kv.flag] = kv; }
  }
  return { stdout, status, flags, recs };
}

// ============================================================================
// Scenarios
// ============================================================================

// 1) Healthy baseline: below both thresholds, deps+model present, cron present, index fresh ⇒ NOTHING.
{
  const r = run(makeCase({ chunks: 100, deps: true, model: true, cron: "present" }).env);
  a.equal(r.flags.size, 0, "nothing should trigger on a healthy small workspace");
  a.equal(r.stdout.trim(), "", "prints NOTHING when nothing triggers");
  a.equal(r.status, 0, "exit 0 when nothing triggers");
}

// 2) Scale: chunks ≥ 8000 AND sqlite-vec deps absent ⇒ --with-sqlite-vec (model present ⇒ no reranker).
{
  const r = run(makeCase({ chunks: 8000, deps: false, model: true, cron: "present" }).env);
  a.has(r.flags, "--with-sqlite-vec", "8000 chunks + no deps ⇒ recommend sqlite-vec");
  a.hasNot(r.flags, "--with-reranker", "reranker model present ⇒ no reranker rec");
  a.hasNot(r.flags, "--with-cron", "fresh index + cron present ⇒ no cron rec");
  a.match(r.recs["--with-sqlite-vec"].measured, /chunks=8000/, "measured carries the chunk count");
  a.match(r.recs["--with-sqlite-vec"].threshold, /chunks>=8000/, "threshold carries the compare point");
}

// 3) Scale suppressed when the deps ARE installed.
{
  const r = run(makeCase({ chunks: 8000, deps: true, model: true }).env);
  a.hasNot(r.flags, "--with-sqlite-vec", "deps installed ⇒ no sqlite-vec rec even at scale");
}

// 4) Scale boundary: 7999 < 8000 ⇒ no sqlite-vec.
{
  const r = run(makeCase({ chunks: 7999, deps: false, model: true }).env);
  a.hasNot(r.flags, "--with-sqlite-vec", "just below threshold ⇒ no sqlite-vec rec");
}

// 5) Precision: chunks ≥ 2000 AND reranker model absent ⇒ --with-reranker (softer SUGGESTION).
{
  const r = run(makeCase({ chunks: 2000, deps: true, model: false, cron: "present" }).env);
  a.has(r.flags, "--with-reranker", "2000 chunks + no model ⇒ suggest reranker");
  a.equal(r.recs["--with-reranker"].severity, "suggest", "reranker is a softer suggestion");
  a.hasNot(r.flags, "--with-sqlite-vec", "2000 < 8000 ⇒ no sqlite-vec rec");
}

// 6) Precision suppressed when the model IS present.
{
  const r = run(makeCase({ chunks: 5000, deps: true, model: true }).env);
  a.hasNot(r.flags, "--with-reranker", "reranker model present ⇒ no reranker rec");
}

// 7) Precision boundary: 1999 < 2000 ⇒ no reranker.
{
  const r = run(makeCase({ chunks: 1999, deps: true, model: false }).env);
  a.hasNot(r.flags, "--with-reranker", "just below threshold ⇒ no reranker rec");
}

// 8) Staleness: content newer than the index (cron present) ⇒ --with-cron.
{
  const r = run(makeCase({ chunks: 10, deps: true, model: true, cron: "present", stale: true }).env);
  a.has(r.flags, "--with-cron", "unindexed newer content ⇒ recommend cron");
  a.match(r.recs["--with-cron"].measured, /stale=yes/, "measured records the staleness signal");
}

// 9) No staleness + cron present ⇒ no cron rec.
{
  const r = run(makeCase({ chunks: 10, deps: true, model: true, cron: "present", stale: false }).env);
  a.hasNot(r.flags, "--with-cron", "fresh index + reindex cron present ⇒ no cron rec");
}

// 10) Missing reindex cron (fresh index) ⇒ --with-cron on the cron signal alone.
{
  const r = run(makeCase({ chunks: 10, deps: true, model: true, cron: "absent", stale: false }).env);
  a.has(r.flags, "--with-cron", "no reindex cron ⇒ recommend cron even when fresh");
  a.match(r.recs["--with-cron"].measured, /cron=absent/, "measured records the missing cron");
}

// 11) Crontab source UNAVAILABLE (guard) + fresh index ⇒ NO cron rec (skip, never false-fire).
{
  const r = run(makeCase({ chunks: 10, deps: true, model: true, cron: "missing", stale: false }).env);
  a.hasNot(r.flags, "--with-cron", "unreadable crontab ⇒ skip the cron check, don't fire");
  a.equal(r.status, 0, "guarded crontab ⇒ still exit 0");
}

// 12) Missing index.json ⇒ scale+precision SKIP, no error (cron present ⇒ nothing fires).
{
  const r = run(makeCase({ noIndex: true, deps: false, model: false, cron: "present", stale: false }).env);
  a.hasNot(r.flags, "--with-sqlite-vec", "no index ⇒ skip scale check");
  a.hasNot(r.flags, "--with-reranker", "no index ⇒ skip precision check");
  a.equal(r.status, 0, "missing index ⇒ guarded, exit 0");
}

// 13) Env-tunable thresholds: lower both ⇒ a small corpus now triggers scale + precision.
{
  const r = run(makeCase({ chunks: 100, deps: false, model: false, cron: "present", sqliteThreshold: 50, rerankerThreshold: 50 }).env);
  a.has(r.flags, "--with-sqlite-vec", "custom low sqlite threshold ⇒ fires at 100 chunks");
  a.has(r.flags, "--with-reranker", "custom low reranker threshold ⇒ fires at 100 chunks");
}

// 14) All three at once: large + no deps + no model + no cron + stale ⇒ every flag, exact cmds.
{
  const r = run(makeCase({ chunks: 9000, deps: false, model: false, cron: "absent", stale: true }).env);
  a.has(r.flags, "--with-cron", "combined: cron");
  a.has(r.flags, "--with-sqlite-vec", "combined: sqlite-vec");
  a.has(r.flags, "--with-reranker", "combined: reranker");
  a.equal(r.recs["--with-cron"].cmd, "INSTALL --with-cron", "cmd embeds the exact approval-gated install command");
  a.equal(r.recs["--with-sqlite-vec"].cmd, "INSTALL --with-sqlite-vec", "sqlite-vec cmd exact");
  a.equal(r.recs["--with-reranker"].cmd, "INSTALL --with-reranker", "reranker cmd exact");
  a.match(r.stdout, /Engine upgrades available/, "human-readable section header present when triggered");
  a.match(r.stdout, /Approval-gated/, "approval-gated contract stated in the output");
  a.equal(r.status, 0, "triggering run still exits 0");
}

// ============================================================================
console.log(`\n✅ test-upgrade-advisor: all assertions passed (${assertCount} assertions, ${caseN} synthetic cases)`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
