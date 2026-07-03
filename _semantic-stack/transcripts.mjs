// transcripts.mjs — parse raw conversation transcripts into normalized units for deep-recall.
// PURE (no embed/model dependency) → unit-testable anywhere.
// Unit: { src, file, line, ts, role, kind, sub, text, id }
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAXCHARS = 1100;            // arctic embed caps ~512 tok; common.mjs slices at 1200 — stay under.
const MINCHARS = 12;             // drop tiny fragments
export const OPT_OUT = /<NO-RECALL>/i;

export function mkId(file, line, sub, text) {
  return crypto.createHash("sha1").update(`${file}:${line}:${sub}:${text.slice(0, 80)}`).digest("hex").slice(0, 16);
}

// split a (whitespace-collapsed) long string into <=MAXCHARS pieces on sentence boundaries
export function splitLong(text) {
  if (text.length <= MAXCHARS) return [text];
  const out = []; let buf = "";
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    if ((buf + " " + part).length > MAXCHARS && buf) { out.push(buf.trim()); buf = ""; }
    buf += (buf ? " " : "") + part;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.flatMap((p) => (p.length <= MAXCHARS ? [p] : p.match(new RegExp(`.{1,${MAXCHARS}}`, "g")) || []));
}

// strip OpenClaw channel-metadata preamble that wraps inbound user messages
export function stripChannelMeta(text) {
  return text
    .replace(/(Conversation info|Sender)\s*\(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/^\s+/, "")
    .trim();
}

// strip Claude Code / system-injected wrappers (caveats, command echoes, reminders) — noise, not conversation
export function stripSystemNoise(text) {
  const TAGS = "local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|function_calls|function_results";
  return text
    .replace(new RegExp(`<(${TAGS})>[\\s\\S]*?</\\1>`, "gi"), " ")
    .replace(new RegExp(`</?(?:${TAGS})[^>]*>`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

// a "text" value that is itself serialized message JSON / signature blobs — not human prose
export function isSerializedDump(text) {
  return /\{"type":"(?:text|message|tool|thinking)"|"signature":"[A-Za-z0-9+/]{30,}/.test(text);
}
export function textFromContent(content) {
  if (typeof content === "string") return isSerializedDump(content) ? "" : content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === "text" && b.text && !isSerializedDump(b.text)).map((b) => b.text).join("\n").trim();
  }
  return "";
}

// flatten a structured event's data{} into readable text (decision / technical_note)
function flattenData(data) {
  const parts = [];
  for (const [k, v] of Object.entries(data || {})) {
    if (k === "channel" || k === "message_id" || k === "sender_id") continue;
    if (typeof v === "string" && v.trim()) parts.push(`${k}: ${v}`);
    else if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.filter((x) => typeof x === "string").join("; ")}`);
  }
  return parts.join(". ").trim();
}

// per-format line parsers → {ts, role, text} | null
export const PARSERS = {
  thread(o) {
    const t = o.type, d = o.data || {};
    if (t === "user_message") return { ts: o.timestamp, role: "user", text: typeof d.content === "string" ? d.content : "" };
    if (t === "decision" || t === "technical_note") return { ts: o.timestamp, role: "rin", text: flattenData(d) };
    return null;
  },
  archive(o) {
    if (o.type !== "message") return null;
    const m = o.message || {};
    let text = textFromContent(m.content);
    if (m.role === "user") text = stripChannelMeta(text);
    return text ? { ts: o.timestamp, role: m.role || "?", text } : null;
  },
  engineer(o) {
    if (o.type !== "user" && o.type !== "assistant") return null;
    const text = textFromContent((o.message || {}).content);
    return text ? { ts: o.timestamp, role: o.type, text } : null;
  },
  // Claude Code standalone sessions (~/.claude/projects/<slug>/<uuid>.jsonl) — one JSON object per line.
  // Keep only type:"user"/"assistant". message.content is a STRING (user) or an ARRAY of blocks;
  // textFromContent() keeps solely {type:"text"} blocks → thinking / tool_use / tool_result are dropped.
  // Every other line type (queue-operation, attachment, ai-title, last-prompt, summary, mode, system, …) → ignored.
  "claude-code"(o) {
    if (o.type !== "user" && o.type !== "assistant") return null;
    const text = textFromContent((o.message || {}).content);
    return text ? { ts: o.timestamp, role: o.type, text } : null;
  },
};

export function kindOf(file) {
  if (file.includes("/.claude/projects/")) return "engineer";
  if (path.basename(file).startsWith("session-archive")) return "archive";
  if (file.includes("/threads/")) return "thread";
  return null;
}

// Content-based detection (PURE — sample lines in, no fs): a .jsonl is Claude Code shaped when its
// lines carry a top-level type of "user"/"assistant" WITH a message object. This distinguishes CC from
// `archive` (type:"message") and `thread` (type:"user_message"/"decision"/…), which never match here.
export function looksLikeClaudeCode(lines, sample = 50) {
  let checked = 0;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o === "object" && (o.type === "user" || o.type === "assistant")
        && o.message && typeof o.message === "object") return true;
    if (++checked >= sample) break;
  }
  return false;
}

// parse one transcript file from `fromLine` (0-based) → { units, lineCount }.
// `kindHint` (e.g. "claude-code" from --cc-dir discovery) overrides path/content detection.
export function parseFile(file, fromLine = 0, kindHint = null) {
  let kind = kindHint || kindOf(file);
  let lines = null;
  if (!kind) {
    // content-based fallback: Claude Code shaped .jsonl not matched by any path rule
    if (!file.endsWith(".jsonl")) return { units: [], lineCount: 0 };
    lines = fs.readFileSync(file, "utf8").split("\n");
    if (looksLikeClaudeCode(lines)) kind = "claude-code";
    else return { units: [], lineCount: 0 };
  }
  const parse = PARSERS[kind];
  if (!parse) return { units: [], lineCount: 0 };
  if (lines === null) lines = fs.readFileSync(file, "utf8").split("\n");
  const units = [];
  for (let i = fromLine; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    let u; try { u = parse(o); } catch { u = null; }
    if (!u || !u.text || !u.text.trim()) continue;
    if (OPT_OUT.test(u.text)) continue;
    const collapsed = stripSystemNoise(u.text);
    if (collapsed.length < MINCHARS) continue;
    splitLong(collapsed).forEach((text, sub) => {
      if (text.length < MINCHARS) return;
      units.push({ src: kind, file, line: i + 1, ts: u.ts || "", role: u.role, kind, sub, text, id: mkId(file, i + 1, sub, text) });
    });
  }
  return { units, lineCount: lines.length };
}
