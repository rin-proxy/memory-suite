// capture.mjs — LAYER 2 compaction-capture: snapshot an about-to-be-compacted context window into the
// INDEXED memory store, plus a high-signal curation queue for the agent. PROVIDER-FREE.
//
// PURE CODE — node builtins only (fs/path/os/crypto/url). NO embedding model, NO network, NO provider
// call. The snapshot and the high-signal flagging are deterministic; judging what is worth *permanently*
// curating is AGENT-driven (the agent later drains memory/.compaction/curation-queue.md and promotes the
// keepers with scripts/save.sh — Layer 1 — which dedups via reconcile).
//
// Two front-ends share this module (both call captureWindow):
//   • OpenClaw file-hook   hooks/compaction-capture/handler.js  (in-memory event messages)
//   • Claude Code PreCompact  hooks/precompact-capture.sh → `node capture.mjs --transcript <jsonl>`
//
// SMART-CACHE-AWARE. If Rin's smart-cache-pro plugin is ALSO installed, it already keeps a VERBATIM copy of
// this same pre-compaction window in its own cache. captureWindow detects a fresh such snapshot
// (findSmartCacheSnapshot) and writes a lighter INDEXED reference stub (pointer + flagged lines) instead of
// duplicating the verbatim window; when smart-cache is absent it self-snapshots exactly as before. ONE-WAY:
// we only READ smart-cache's output and never modify it.
//
// CLI:
//   node capture.mjs --transcript <path.jsonl> [--ws <dir>] [--trigger <t>] [--source <s>]
//   node capture.mjs --messages   <path.json>  [--ws <dir>] [--trigger <t>] [--source <s>]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const CAPTURE_DIR_REL = "memory/.compaction";
const MAX_MSG_CHARS = 1200; // per-message cap in the snapshot body (matches the embed slice; keeps it lean)
const MAX_MESSAGES = 400;   // if the window is huge, keep the most-recent N in the snapshot body
const MAX_QUEUE = 40;       // cap flagged lines per compaction so the curation queue never floods

// Workspace root — MUST match store.mjs (OPENCLAW_WORKSPACE || ~/.openclaw/workspace) so the snapshot
// lands in the very store msem/mdeep index. An explicit hint (--ws / event context) wins.
export function resolveWs(hint) {
  return hint || process.env.OPENCLAW_WORKSPACE || `${os.homedir()}/.openclaw/workspace`;
}

// High-signal markers — a pure-regex heuristic. This only *nominates* lines; the agent makes the real
// keep/drop call. Order matters only for the label shown; a line can carry several tags.
export const MARKERS = [
  ["remember",   /\b(remember (?:this|that)|save (?:this|that)|note that|for future reference|don'?t forget|keep in mind|important:)\b/i],
  ["decision",   /\b(decided?|decision|we'?ll go with|going with|let'?s (?:go|ship|use|do)|chose|choosing|final(?:iz|is)ed?)\b/i],
  ["preference", /\b(prefer(?:s|red)?|always|never|from now on|reply in|no emojis|by default|make sure (?:to|you))\b/i],
  ["correction", /\b(actually|correction|i was wrong|to be clear|scratch that|instead of|not\s+\w.*\bbut\b)\b/i],
  ["milestone",  /\b(shipped|launched|deployed|completed|finished|merged|closed|achieved|milestone)\b/i],
  ["todo",       /\b(TODO|action item|next step|follow[- ]?up|still (?:need|todo)|remaining)\b/i],
];

// Drop tool/system wrappers so a flagged line is prose, not XML. Light + defensive (never throws).
const NOISE = /<\/?(?:function_calls|function_results|invoke|antml:[a-z]+|parameter|system-reminder|bash-(?:input|stdout|stderr)|local-command-[a-z]+|command-[a-z]+)[^>]*>/gi;
export function clean(s) {
  return String(s == null ? "" : s).replace(NOISE, " ").replace(/\s+/g, " ").trim();
}

// Pull display text from a content value: a string, or an array of {type:"text",text} blocks (thinking /
// tool_use / tool_result blocks carry no {type:"text"} → naturally dropped).
export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

// Normalize whatever a runtime hands us (event.messages / payload.messages / …) → [{role,text,ts}].
export function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (typeof m === "string") { const t = clean(m); if (t) out.push({ role: "note", text: t, ts: "" }); continue; }
    if (!m || typeof m !== "object") continue;
    const role = m.role || m.type || m.author || "?";
    const text = clean(textOf(m.content != null ? m.content : (m.text != null ? m.text : m.message)));
    if (text) out.push({ role: String(role), text, ts: m.ts || m.timestamp || "" });
  }
  return out;
}

// Parse a Claude-Code-style .jsonl transcript → [{role,text,ts}] (only user/assistant text).
export function messagesFromTranscript(jsonlText) {
  const out = [];
  for (const line of String(jsonlText).split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || (o.type !== "user" && o.type !== "assistant")) continue;
    const text = clean(textOf((o.message || {}).content));
    if (text) out.push({ role: o.type, text, ts: o.timestamp || "" });
  }
  return out;
}

// Deterministic high-signal selection → [{role,text,tags}]. Splits turns into sentence-ish lines so a
// flag points at the actual claim, dedups, and caps the count.
export function selectHighSignal(messages, limit = MAX_QUEUE) {
  const seen = new Set();
  const picked = [];
  for (const m of messages) {
    for (const chunk of m.text.split(/(?<=[.!?])\s+|\n+/)) {
      const line = chunk.trim();
      if (line.length < 12 || line.length > 400) continue;
      const tags = MARKERS.filter(([, rx]) => rx.test(line)).map(([t]) => t);
      if (!tags.length) continue;
      const key = line.toLowerCase().slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ role: m.role, text: line, tags });
      if (picked.length >= limit) return picked;
    }
  }
  return picked;
}

// Filesystem-safe compact UTC stamp, e.g. 20260703T142530Z
function fileStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function buildSnapshotMarkdown({ messages, meta }) {
  const now = meta.capturedAt || new Date().toISOString();
  const date = now.slice(0, 10);
  const kept = messages.slice(-MAX_MESSAGES);
  const truncated = messages.length - kept.length;
  const out = [
    "---",
    "type: compaction-snapshot",
    "status: active",
    `date: ${date}`,
    "tags: [compaction, layer2, auto-capture]",
    "source: compaction-capture",
    `trigger: ${meta.trigger || "unknown"}`,
    `origin: ${meta.source || "hook"}`,
    `messages: ${messages.length}`,
    `captured: ${now}`,
    "---",
    "",
    `# Compaction snapshot — ${now}`,
    "",
    "Context window that was about to be trimmed (Layer 2 · provider-free capture). Promoted into the",
    "indexed memory store so `msem`/`mdeep` can recall it; high-signal lines were also queued for the",
    "agent to curate (`memory/.compaction/curation-queue.md`).",
    "",
  ];
  if (!kept.length) {
    out.push(
      "> No message content was exposed to this hook (metadata-only runtime). This is a breadcrumb — the",
      "> raw window is still recoverable through `mdeep`'s transcript index.",
    );
  } else {
    if (truncated > 0) out.push(`_(showing the most recent ${kept.length} of ${messages.length} messages)_`, "");
    out.push(`## Window (${kept.length} messages)`, "");
    for (const m of kept) {
      const t = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + " …" : m.text;
      out.push(`**${m.role}:** ${t}`, "");
    }
  }
  return out.join("\n");
}

// Lighter INDEXED reference stub, written when smart-cache-pro already holds the VERBATIM window (see
// findSmartCacheSnapshot). Carries the same parseMeta-compatible frontmatter as a full snapshot (so the
// indexer treats it identically) + a `full_verbatim:` pointer + the flagged high-signal lines — but NOT
// the whole window body, so we don't duplicate on disk what smart-cache already stored verbatim.
export function buildReferenceStubMarkdown({ messages, picked, meta, verbatim }) {
  const now = meta.capturedAt || new Date().toISOString();
  const date = now.slice(0, 10);
  const vpath = (verbatim && verbatim.path) || "unknown";
  const vformat = (verbatim && verbatim.format) || "smart-cache";
  const out = [
    "---",
    "type: compaction-snapshot",
    "status: active",
    `date: ${date}`,
    "tags: [compaction, layer2, auto-capture, smart-cache-ref]",
    "source: compaction-capture",
    `trigger: ${meta.trigger || "unknown"}`,
    `origin: ${meta.source || "hook"}`,
    `messages: ${messages.length}`,
    `captured: ${now}`,
    "smart_cache: true",
    `full_verbatim: ${vpath}`,
    "---",
    "",
    `# Compaction snapshot (reference) — ${now}`,
    "",
    "smart-cache-pro already keeps a **verbatim** copy of this pre-compaction window, so this is the",
    "lighter half of Layer 2: an **indexed reference** (high-signal lines below for `msem`/`mdeep` recall +",
    "curation) plus a pointer to the full window — WITHOUT re-storing the whole verbatim copy on disk.",
    "",
    `- **Full verbatim window:** \`${vpath}\` (${vformat}, smart-cache-pro)`,
    `- **Messages in window:** ${messages.length}`,
    "",
    "> The pointer may age out if smart-cache-pro prunes its cache (its `retentionDays`, default 14d); the",
    "> high-signal lines below are kept here regardless, and `mdeep`'s transcript index still backstops the",
    "> raw window.",
    "",
  ];
  if (picked && picked.length) {
    out.push(`## High-signal lines (${picked.length})`, "");
    for (const p of picked) out.push(`- **${p.role}** _(${p.tags.join(",")})_: ${p.text}`);
    out.push("");
  } else {
    out.push("_No high-signal lines flagged in this window; the full verbatim copy is linked above._", "");
  }
  return out.join("\n");
}

export function buildQueueBlock(picked, meta, snapshotRel) {
  if (!picked.length) return "";
  const now = meta.capturedAt || new Date().toISOString();
  const lines = [
    `### From compaction ${now} (${meta.trigger || "unknown"} · ${meta.source || "hook"})`,
    `_Snapshot: ${snapshotRel}. Promote keepers via \`scripts/save.sh\`, then delete the line._`,
    "",
  ];
  for (const p of picked) lines.push(`- [ ] (${p.role} · ${p.tags.join(",")}) ${p.text}`);
  lines.push("");
  return lines.join("\n");
}

const QUEUE_HEADER = `# Compaction curation queue

High-signal lines flagged (pure-code heuristic) from context windows that were compacted. **You**, the
agent, are the judge: promote the real keepers into curated memory with \`scripts/save.sh\` (it dedups via
reconcile), then delete the checkbox. Everything here already snapshotted alongside it and stays
recoverable via \`mdeep\` — this queue is a worklist, not the source of truth.
`;

// ── shared write helpers ─────────────────────────────────────────────────────────────────────────
// content-derived 8-hex digest → same window ⇒ same filename (idempotent on retries); distinct windows differ.
function windowDigest(messages, meta) {
  const basis = messages.map((m) => m.role + ":" + m.text).join("\n") || `${meta.capturedAt}:${meta.trigger || ""}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 8);
}
// Append the flagged high-signal lines to the curation queue (creating it with its header once). Shared by
// the self-snapshot and the reference-stub paths so the agent's worklist is identical either way.
function appendQueue(dir, picked, meta, snapRel) {
  const block = buildQueueBlock(picked, meta, snapRel);
  if (!block) return;
  const queuePath = path.join(dir, "curation-queue.md");
  if (!fs.existsSync(queuePath)) fs.writeFileSync(queuePath, QUEUE_HEADER + "\n");
  fs.appendFileSync(queuePath, "\n" + block);
}

// Write the FULL self-snapshot + append the queue block. Returns { mode, snapshotPath, snapshotRel, messages, queued }.
// The provider-free DEFAULT (used when smart-cache-pro is absent). Best-effort by contract — callers wrap it.
export function writeCapture({ ws, messages, meta }) {
  ws = resolveWs(ws);
  meta = meta || {};
  messages = Array.isArray(messages) ? messages : [];
  const dir = path.join(ws, "memory", ".compaction");
  fs.mkdirSync(dir, { recursive: true });

  const at = new Date(meta.capturedAt || Date.now());
  meta.capturedAt = meta.capturedAt || at.toISOString();
  const snapName = `snapshot-${fileStamp(at)}-${windowDigest(messages, meta)}.md`;
  const snapPath = path.join(dir, snapName);
  const snapRel = `${CAPTURE_DIR_REL}/${snapName}`;
  fs.writeFileSync(snapPath, buildSnapshotMarkdown({ messages, meta }));

  const picked = selectHighSignal(messages);
  appendQueue(dir, picked, meta, snapRel);
  return { mode: "self", snapshotPath: snapPath, snapshotRel: snapRel, messages: messages.length, queued: picked.length };
}

// ── smart-cache-pro awareness (ONE-WAY: we only READ smart-cache's output; never write/modify it) ──
export const SMART_CACHE_MAX_AGE_MS = 120000; // 2 min — both hooks fire on the SAME compaction event
const SC_FILE_RX = /^(?:snapshot|transcript)-.*\.(?:jsonl|json)$/i; // smart-cache snapshot filenames, both platforms
function scFormat(name) {
  if (/\.jsonl$/i.test(name)) return "cc-transcript";       // Claude Code port: verbatim transcript copy
  if (/\.json$/i.test(name)) return "openclaw-messages";    // OpenClaw plugin: { at, messageCount, messages }
  return "smart-cache";
}

// Locate a FRESH smart-cache-pro pre-compaction snapshot for THIS compaction, if that plugin is also
// installed. Priority of locations (as discovered from its source):
//   1. SMART_CACHE_DIR env override — the dir itself + its known `compaction`/`.compaction` subdirs.
//   2. Claude Code port  (~/.claude/hooks/snapshot-before-compact.mjs): ~/.claude/cache/compaction/transcript-*.jsonl
//   3. OpenClaw plugin   (smart-cache-pro Engine B): <ws>/memory/cache/.compaction/snapshot-*.json
// "Fresh" = mtime within maxAgeMs of now; anything older is a snapshot from a PREVIOUS compaction and is
// ignored. Returns { path, dir, mtimeMs, format } for the newest match, else null. Any error ⇒ null (the
// caller then self-snapshots). Purely reads the filesystem — no model, no network, no writes to it.
export function findSmartCacheSnapshot(opts = {}) {
  try {
    const ws = resolveWs(opts.ws);
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const envAge = Number(process.env.SMART_CACHE_MAX_AGE_MS);
    const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : (envAge > 0 ? envAge : SMART_CACHE_MAX_AGE_MS);
    const dirs = [];
    const envDir = process.env.SMART_CACHE_DIR;
    if (envDir) dirs.push(envDir, path.join(envDir, "compaction"), path.join(envDir, ".compaction"));
    dirs.push(path.join(os.homedir(), ".claude", "cache", "compaction"));  // Claude Code port default
    dirs.push(path.join(ws, "memory", "cache", ".compaction"));            // OpenClaw plugin default
    let best = null;
    for (const dir of dirs) {
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; } // dir absent ⇒ smart-cache not writing here
      for (const name of names) {
        if (!SC_FILE_RX.test(name)) continue;
        const full = path.join(dir, name);
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (!st.isFile() || now - st.mtimeMs > maxAge) continue; // stale ⇒ not this compaction
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, dir, mtimeMs: st.mtimeMs, format: scFormat(name) };
      }
    }
    return best;
  } catch {
    return null; // detection must never throw — absence just means "self-snapshot"
  }
}

// Write the lighter reference STUB (pointer to smart-cache's verbatim copy + flagged lines) + queue block.
// Returns { mode:"reference", snapshotPath, snapshotRel, messages, queued, verbatim }.
export function writeReferenceCapture({ ws, messages, meta, verbatim }) {
  ws = resolveWs(ws);
  meta = meta || {};
  messages = Array.isArray(messages) ? messages : [];
  const dir = path.join(ws, "memory", ".compaction");
  fs.mkdirSync(dir, { recursive: true });

  const at = new Date(meta.capturedAt || Date.now());
  meta.capturedAt = meta.capturedAt || at.toISOString();
  const snapName = `snapshot-${fileStamp(at)}-${windowDigest(messages, meta)}-ref.md`; // -ref ⇒ distinguishable, still indexed
  const snapPath = path.join(dir, snapName);
  const snapRel = `${CAPTURE_DIR_REL}/${snapName}`;
  const picked = selectHighSignal(messages);
  fs.writeFileSync(snapPath, buildReferenceStubMarkdown({ messages, picked, meta, verbatim }));

  appendQueue(dir, picked, meta, snapRel);
  return { mode: "reference", snapshotPath: snapPath, snapshotRel: snapRel, messages: messages.length, queued: picked.length, verbatim: verbatim && verbatim.path };
}

// Single entrypoint for both front-ends: detect a fresh smart-cache-pro snapshot and REFERENCE it (no
// duplicate verbatim copy); if none is found — or referencing fails for any reason — fall back to the full
// self-snapshot, so behavior is byte-for-byte backward-compatible when smart-cache-pro isn't installed.
export function captureWindow(opts = {}) {
  const { ws, messages, meta } = opts;
  let verbatim = null;
  try { verbatim = findSmartCacheSnapshot({ ws, now: opts.now, maxAgeMs: opts.maxAgeMs }); } catch { verbatim = null; }
  if (verbatim) {
    try { return writeReferenceCapture({ ws, messages, meta, verbatim }); }
    catch { /* referencing failed → fall through to a full self-snapshot (never break the hook) */ }
  }
  return writeCapture({ ws, messages, meta });
}

// --- CLI (only when run directly; a no-op when imported by handler.js) -------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  try {
    let messages = [];
    const transcript = get("--transcript");
    const messagesFile = get("--messages");
    if (transcript) messages = messagesFromTranscript(fs.readFileSync(transcript, "utf8"));
    else if (messagesFile) messages = normalizeMessages(JSON.parse(fs.readFileSync(messagesFile, "utf8")));
    const res = captureWindow({
      ws: get("--ws"),
      messages,
      meta: { trigger: get("--trigger") || "auto", source: get("--source") || "cli", capturedAt: new Date().toISOString() },
    });
    process.stdout.write(`compaction-capture: ${res.mode} snapshot ${res.snapshotRel} (${res.messages} msgs, ${res.queued} queued)${res.verbatim ? ` → refs ${res.verbatim}` : ""}\n`);
  } catch (e) {
    process.stderr.write(`compaction-capture: ${e && e.message ? e.message : e}\n`);
  }
  process.exit(0); // best-effort — never fail the caller
}
