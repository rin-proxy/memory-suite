// test-capture.mjs — provider-free unit test for the Layer 2 compaction-capture core (no model, no net).
// Run: node cognitive-memory/hooks/compaction-capture/test-capture.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import {
  messagesFromTranscript, normalizeMessages, selectHighSignal, buildSnapshotMarkdown, writeCapture,
  findSmartCacheSnapshot, captureWindow,
} from "./capture.mjs";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };

// --- transcript parsing: keep user/assistant text, drop tool/thinking blocks + other line types ------
const jsonl = [
  JSON.stringify({ type: "user", timestamp: "t1", message: { role: "user", content: "Let's go with Postgres for the store." } }),
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", text: "hmm" },
    { type: "text", text: "Got it. Remember that you prefer TypeScript." },
    { type: "tool_use", name: "Bash", input: {} },
  ] } }),
  JSON.stringify({ type: "summary", summary: "noise" }),
  "not json",
  "",
].join("\n");
const msgs = messagesFromTranscript(jsonl);
ok(msgs.length === 2, `transcript → 2 msgs (got ${msgs.length})`);
ok(!/thinking|tool_use|hmm/.test(JSON.stringify(msgs)), "tool/thinking blocks dropped");

// --- normalizeMessages: strings, {role,content}, and content-block arrays -----------------------------
const norm = normalizeMessages([
  "plain string note",
  { role: "user", content: "decided to ship the redesign this week" },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  { junk: true },
]);
ok(norm.length === 3, `normalize → 3 (got ${norm.length})`);

// --- high-signal selection: flags decision/remember/preference, ignores chit-chat --------------------
const picked = selectHighSignal([
  { role: "user", text: "how's the weather today?" },
  { role: "user", text: "We decided to go with Postgres. Also remember that I prefer TypeScript." },
]);
ok(picked.length === 2, `2 high-signal lines (got ${picked.length})`);
ok(picked.some((p) => p.tags.includes("decision")), "decision tagged");
ok(picked.some((p) => p.tags.includes("remember") || p.tags.includes("preference")), "remember/preference tagged");

// --- snapshot markdown: parseMeta-compatible frontmatter + body --------------------------------------
const md = buildSnapshotMarkdown({ messages: norm, meta: { trigger: "auto", source: "test", capturedAt: "2026-07-03T10:00:00.000Z" } });
ok(md.startsWith("---\ntype: compaction-snapshot\n"), "frontmatter present");
ok(/date: 2026-07-03/.test(md) && /source: compaction-capture/.test(md), "date + source fields");
const empty = buildSnapshotMarkdown({ messages: [], meta: { capturedAt: "2026-07-03T10:00:00.000Z" } });
ok(/breadcrumb/i.test(empty), "empty window → breadcrumb note");

// --- writeCapture: real files land in <ws>/memory/.compaction, queue gets flagged lines --------------
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
try {
  const res = writeCapture({
    ws, messages: normalizeMessages([{ role: "user", content: "We decided to launch Monday. Remember that." }]),
    meta: { trigger: "manual", source: "test" },
  });
  ok(fs.existsSync(res.snapshotPath), "snapshot file written");
  ok(res.snapshotRel.startsWith("memory/.compaction/snapshot-"), "snapshot rel path");
  ok(!/-log\.md$/.test(res.snapshotPath), "filename not excluded by indexer (-log.md)");
  const q = fs.readFileSync(path.join(ws, "memory/.compaction/curation-queue.md"), "utf8");
  ok(/- \[ \] /.test(q) && res.queued > 0, `queue has ${res.queued} flagged line(s)`);
  // idempotent: identical window ⇒ identical content digest suffix
  const res2 = writeCapture({ ws, messages: normalizeMessages([{ role: "user", content: "We decided to launch Monday. Remember that." }]), meta: { trigger: "manual", source: "test" } });
  ok(res2.snapshotRel.split("-").pop() === res.snapshotRel.split("-").pop(), "same content → same digest suffix");
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- smart-cache-aware: a FRESH smart-cache-pro snapshot ⇒ REFERENCE it (indexed stub, NO full copy) ---
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "capture-ref-"));
  const scDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcache-"));
  const scFile = path.join(scDir, "transcript-2026-07-03T15-31-48-728Z.jsonl"); // CC-port verbatim copy
  fs.writeFileSync(scFile, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  // Pin the fake's mtime 60s AHEAD and query at that instant so ONLY our fake is "fresh" — any real
  // ~/.claude/cache/compaction file is ≥60s older ⇒ stale ⇒ excluded. Makes the test machine-independent.
  const ts = Math.floor(Date.now() / 1000) + 60;
  fs.utimesSync(scFile, ts, ts);
  const now = ts * 1000 + 1;
  process.env.SMART_CACHE_DIR = scDir;
  try {
    const hit = findSmartCacheSnapshot({ ws, now, maxAgeMs: 5000 });
    ok(hit && hit.path === scFile && hit.format === "cc-transcript", "findSmartCacheSnapshot: fresh .jsonl found + typed cc-transcript");

    const messages = normalizeMessages([{ role: "user", content: "We decided to launch Monday. Remember that." }]);
    const res = captureWindow({ ws, messages, meta: { trigger: "manual", source: "test" }, now, maxAgeMs: 5000 });
    ok(res.mode === "reference", `smart-cache present ⇒ reference mode (got ${res.mode})`);
    ok(/-ref\.md$/.test(res.snapshotPath), "reference stub filename ends -ref.md");
    ok(res.verbatim === scFile, "result points at the smart-cache verbatim path");
    const body = fs.readFileSync(res.snapshotPath, "utf8");
    ok(body.includes(`full_verbatim: ${scFile}`), "stub carries full_verbatim pointer to smart-cache copy");
    ok(/^smart_cache: true$/m.test(body), "stub frontmatter marks smart_cache: true");
    ok(!/## Window \(/.test(body), "NO full verbatim window body in the stub (no duplication)");
    ok(/## High-signal lines/.test(body) && res.queued > 0, "stub still carries flagged high-signal lines + queue");
    const q = fs.readFileSync(path.join(ws, "memory/.compaction/curation-queue.md"), "utf8");
    ok(/- \[ \] /.test(q), "curation queue still populated in reference mode");
  } finally {
    delete process.env.SMART_CACHE_DIR;
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(scDir, { recursive: true, force: true });
  }
}

// --- freshness gate: a STALE smart-cache snapshot (query pinned 1h past every mtime) is ignored ⇒ null --
{
  const scDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcache-stale-"));
  const scFile = path.join(scDir, "snapshot-old.json"); // OpenClaw-format name
  fs.writeFileSync(scFile, "{}");
  const sec = Math.floor(Date.now() / 1000);
  fs.utimesSync(scFile, sec, sec);
  process.env.SMART_CACHE_DIR = scDir;
  try {
    ok(findSmartCacheSnapshot({ now: Date.now() + 3600000, maxAgeMs: 5000 }) === null, "stale snapshot ignored (freshness gate)");
  } finally {
    delete process.env.SMART_CACHE_DIR;
    fs.rmSync(scDir, { recursive: true, force: true });
  }
}

// --- backward-compat: smart-cache ABSENT ⇒ full self-snapshot, byte-for-byte as before -----------------
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "capture-self-"));
  try {
    // maxAgeMs:-1e15 ⇒ NOTHING is ever "fresh" (independent of any real snapshot on this machine) ⇒ self.
    const messages = normalizeMessages([{ role: "user", content: "We decided to launch Monday. Remember that." }]);
    const res = captureWindow({ ws, messages, meta: { trigger: "manual", source: "test" }, maxAgeMs: -1e15 });
    ok(res.mode === "self", `smart-cache absent ⇒ self mode (got ${res.mode})`);
    ok(!/-ref\.md$/.test(res.snapshotPath), "self-snapshot filename is NOT -ref.md");
    const body = fs.readFileSync(res.snapshotPath, "utf8");
    ok(/## Window \(/.test(body) && /\*\*user:\*\*/.test(body), "self-snapshot has the full verbatim window body (backward-compat)");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

console.log(`✅ test-capture: ${n} assertions passed`);
