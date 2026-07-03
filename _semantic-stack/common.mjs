// Semantic memory — shared helpers (arctic-embed via node-llama-cpp)
import { getLlama } from "node-llama-cpp";
// WS + writeJsonAtomic + fs/path live in the model-free store.mjs so decay.mjs (and its tests) can load
// without pulling node-llama-cpp; re-exported here so index/hybrid/deep keep importing them from common.mjs.
import { WS, writeJsonAtomic, fs, path } from "./store.mjs";
export { WS, writeJsonAtomic, fs, path };
// Upgraded 2026-05-31: arctic-embed-s (English-leaning) → arctic-embed-l-v2.0 (multilingual, incl. Indonesian). dim 1024.
export const MODEL = `${WS}/node-llama-cpp/models/snowflake-arctic-embed-l-v2.0-f16.gguf`;
export const INDEX_PATH = `${WS}/memory/.semantic/index.json`;
// arctic-embed is asymmetric: queries get this prefix, documents do not. v2.0 uses "query: ".
export const QUERY_PREFIX = "query: ";

let _model = null, _ctx = null;
export async function getCtx() {
  if (_ctx) return _ctx;
  const llama = await getLlama();
  _model = await llama.loadModel({ modelPath: MODEL });
  _ctx = await _model.createEmbeddingContext();
  return _ctx;
}
export async function dispose() { if (_model) await _model.dispose(); }
export async function embed(text) {
  const ctx = await getCtx();
  // arctic-embed context window is 512 tokens; cap chars to stay safely under it.
  return Array.from((await ctx.getEmbeddingFor(text.slice(0, 1200))).vector);
}
export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
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
