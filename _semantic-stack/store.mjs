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

export { fs, path };
