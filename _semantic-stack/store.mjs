// store.mjs — dependency-free shared bits (NO embedding-model import). Kept separate from common.mjs
// so decay.mjs and its tests load without node-llama-cpp (same reason transcripts.mjs stays standalone).
// common.mjs re-exports these for the model-side scripts (index/hybrid/deep), so their imports are unchanged.
import fs from "node:fs";
import path from "node:path";

export const WS = process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;

// Crash-safe JSON write: write a sidecar then atomically rename over the target (no torn/partial file).
// Shared by index.mjs (index.json) and decay.mjs (decay-scores.json). mkdir keeps first-write safe.
export function writeJsonAtomic(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj)); // write sidecar…
  fs.renameSync(tmp, target);                 // …then atomically swap over the real file
}

// Cosine similarity — model-free math, so it lives here (not common.mjs) and can be shared by the
// pure write-time reconciler (reconcile.mjs) without dragging in node-llama-cpp. common.mjs re-exports
// it, so the model-side scripts (hybrid.mjs / deep.mjs) keep importing `cosine` from common.mjs unchanged.
export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export { fs, path };
