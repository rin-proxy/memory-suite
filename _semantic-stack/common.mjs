// Semantic memory — shared helpers (arctic-embed via node-llama-cpp)
import { getLlama } from "node-llama-cpp";
import net from "node:net";
import crypto from "node:crypto";
// WS + writeJsonAtomic + fs/path live in the model-free store.mjs so decay.mjs (and its tests) can load
// without pulling node-llama-cpp; re-exported here so index/hybrid/deep keep importing them from common.mjs.
import { WS, writeJsonAtomic, cosine, fs, path } from "./store.mjs";
export { WS, writeJsonAtomic, cosine, fs, path };
// Upgraded 2026-05-31: arctic-embed-s (English-leaning) → arctic-embed-l-v2.0 (multilingual, incl. Indonesian). dim 1024.
export const MODEL = `${WS}/node-llama-cpp/models/snowflake-arctic-embed-l-v2.0-f16.gguf`;
export const INDEX_PATH = `${WS}/memory/.semantic/index.json`;
// arctic-embed is asymmetric: queries get this prefix, documents do not. v2.0 uses "query: ".
export const QUERY_PREFIX = "query: ";

let _model = null, _ctx = null, _ctxPromise = null;
export async function getCtx() {
  if (_ctx) return _ctx;
  // Guard concurrent callers (e.g. the daemon's warmup racing its first request) so the ~1.1GB model
  // loads exactly ONCE per process, not twice.
  if (!_ctxPromise) _ctxPromise = (async () => {
    const llama = await getLlama();
    _model = await llama.loadModel({ modelPath: MODEL });
    _ctx = await _model.createEmbeddingContext();
    return _ctx;
  })();
  return _ctxPromise;
}
export async function dispose() { if (_model) { await _model.dispose(); } _model = null; _ctx = null; _ctxPromise = null; }

// In-process embed: cold-loads the model on first call, then reuses it (getCtx caches it). A single
// short-lived msem/mdeep process uses this when no daemon runs — and the daemon itself calls this to serve
// requests. Kept as the RAW path (never tries the daemon) so the daemon can't recurse into itself.
export async function embedInProcess(text) {
  const ctx = await getCtx();
  // arctic-embed context window is 512 tokens; cap chars to stay safely under it.
  return Array.from((await ctx.getEmbeddingFor(text.slice(0, 1200))).vector);
}

// Optional persistent embedding daemon (embed-daemon.mjs). If it's up (socket present + answering), route
// the embed there so the ~1.1GB model is loaded ONCE and shared across all concurrent msem/mdeep/reconcile/
// save calls instead of every process cold-starting it. Any miss falls back to in-process, so behaviour is
// unchanged when no daemon runs. Force off with MEM_EMBED_DAEMON=off.
// Unix socket paths are capped at ~104 bytes on macOS/BSD, so we do NOT nest the socket under a
// (possibly deep) workspace path — a too-long path silently truncates and breaks discovery. Use a short,
// deterministic /tmp path keyed by a hash of the workspace, so each workspace gets its own daemon and the
// client + daemon + memd all derive the identical path.
export const EMBED_SOCK = process.env.MEM_EMBED_SOCK || `/tmp/memsuite-embed-${crypto.createHash("sha1").update(WS).digest("hex").slice(0, 12)}.sock`;
function embedViaDaemon(text) {
  return new Promise((resolve) => {
    if (process.env.MEM_EMBED_DAEMON === "off") return resolve(null);
    // Just try to connect; a missing/stale socket errors instantly (ENOENT/ECONNREFUSED) → fall back to
    // in-process. (No existsSync stat — it disagrees with connect on truncated over-long paths.)
    const sock = net.connect(EMBED_SOCK);
    let done = false, buf = "", to;
    const finish = (v) => { if (done) return; done = true; clearTimeout(to); try { sock.destroy(); } catch {} resolve(v); };
    to = setTimeout(() => finish(null), Number(process.env.MEM_EMBED_TIMEOUT_MS || 30000));
    sock.on("connect", () => { try { sock.write(JSON.stringify({ text }) + "\n"); } catch { finish(null); } });
    sock.on("data", (d) => {
      buf += d; const nl = buf.indexOf("\n"); if (nl < 0) return;
      try { const r = JSON.parse(buf.slice(0, nl)); finish(Array.isArray(r.vector) ? r.vector : null); } catch { finish(null); }
    });
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
  });
}
// Public embed: daemon-first, in-process fallback. All model-side scripts (hybrid/deep/index/reconcile) use this.
export async function embed(text) {
  const viaDaemon = await embedViaDaemon(text);
  if (viaDaemon) return viaDaemon;
  return embedInProcess(text);
}
// cosine now lives in store.mjs (model-free) and is re-exported above, so pure code (reconcile.mjs)
// can share the exact same implementation without importing node-llama-cpp.
// Pack markdown into ~maxChars chunks on paragraph boundaries; track 1-based start line.
export function chunkText(content, maxChars = 600) {
  const lines = content.split("\n");
  const chunks = [];
  let buf = [], start = 1, len = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) chunks.push({ startLine: start, text });
    buf = []; len = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    if (buf.length === 0) start = i + 1;
    buf.push(lines[i]); len += lines[i].length + 1;
    if ((len >= maxChars && lines[i].trim() === "") || len >= maxChars + 300) flush();
  }
  flush();
  return chunks;
}
// --- metadata: parse YAML frontmatter if present, else infer type/date from path ---
function inferType(rel) {
  if (/05-connections/.test(rel)) return "connection";
  if (/02-semantic\/patterns/.test(rel)) return "pattern";
  if (/02-semantic\/questions/.test(rel)) return "question";
  if (/02-semantic\/numbers/.test(rel)) return "number";
  if (/01-episodic|\/episodes\/|\d{4}-\d{2}-\d{2}\.md$/.test(rel)) return "episodic";
  if (/02-semantic/.test(rel)) return "semantic";
  if (/03-procedural/.test(rel)) return "procedural";
  if (/00-core/.test(rel)) return "core";
  if (/04-meta|memory\/meta\//.test(rel)) return "meta";
  if (/\/cache\//.test(rel)) return "cache";
  if (/\/templates\//.test(rel)) return "template";
  if (/^(SOUL|USER|IDENTITY|MEMORY|DECISIONS|HEARTBEAT|DREAMS|AGENTS)\.md$/.test(rel)) return "core";
  return "note";
}
export function parseMeta(rel, content) {
  const dateM = rel.match(/(\d{4}-\d{2}-\d{2})/);
  const meta = { type: inferType(rel), date: dateM ? dateM[1] : "", status: "active", tags: [] };
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end > 0) {
      for (const line of content.slice(4, end).split("\n")) {
        let m;
        if ((m = line.match(/^type:\s*(.+)$/))) meta.type = m[1].trim().replace(/^[\[\]]|[\[\]]$/g, "");
        else if ((m = line.match(/^status:\s*(.+)$/))) meta.status = m[1].trim();
        else if ((m = line.match(/^date:\s*(.+)$/))) meta.date = m[1].trim();
        else if ((m = line.match(/^tags:\s*\[(.*)\]/))) meta.tags = m[1].split(",").map((s) => s.trim()).filter(Boolean);
        else if ((m = line.match(/^tags:\s*(\S.+)$/))) meta.tags = m[1].split(/[,\s]+/).filter(Boolean);
      }
    }
  }
  return meta;
}
