// decay.mjs — retrieval-time memory-decay signal, shared by hybrid.mjs (msem) and deep.mjs (mdeep).
//
// WHAT THIS IS: a post-fusion MULTIPLIER on each candidate's RRF score. RRF ranking itself is
// unchanged; decay only nudges the final top-k selection using how a file has actually been used.
//
// BACKWARD-COMPAT CONTRACT (do not break):
//   - No scores file / empty file / corrupt file  ⇒ every factor is EXACTLY 1.0  ⇒ ranking == today.
//   - A file with no entry                         ⇒ factor EXACTLY 1.0 (decayFactor(undefined) === 1).
//   - A blank/neutral entry (access 0, importance 0.5, no lastAccess) ⇒ factor 1.0.
//
// FORMULA (per file):
//   factor = clamp(recencyBoost * accessBoost * importanceWeight, FACTOR_MIN, FACTOR_MAX)
//
//   recencyBoost — reward recent use, dampen the long-forgotten. Two exponential terms of age:
//       boost  = RECENCY_BOOST_MAX * 2^(-ageDays / RECENCY_HALF_LIFE_DAYS)   // +0.5 → 0 (half-life ~30d)
//       dampen = STALE_DAMPEN_MAX  * (1 - 2^(-ageDays / STALE_HALF_LIFE_DAYS)) // 0 → 0.7 (half-life ~180d)
//       recencyBoost = 1 + boost - dampen
//     ⇒ age 0 → 1.5 ; passes through ~1.0 after a couple months ; very-long-unused → ~0.3 floor.
//     No lastAccessMs (never recorded) ⇒ recencyBoost = 1.0 (neutral).
//
//   accessBoost — grows slowly with how often a file is recalled, capped:
//       accessBoost = min(ACCESS_CAP, 1 + ACCESS_K * log2(access + 1))
//     ⇒ access 0 → 1.0 ; 1 → 1.15 ; 3 → 1.30 ; 7 → 1.45 ; ≥15 → capped 1.5.
//
//   importanceWeight — stored 0..1 importance, scaled so the 0.5 default maps to neutral 1.0:
//       importanceWeight = importance / IMPORTANCE_DEFAULT   (0.5 → 1.0, 1.0 → 2.0, 0 → 0)
//
// Store: <workspace>/memory/.semantic/decay-scores.json
//   { "version": 1, "entries": { "<relPath>": { "access": <int>, "lastAccessMs": <int>, "importance": <0..1> } } }
import { WS, writeJsonAtomic, fs, path } from "./store.mjs";

export const DECAY_PATH = `${WS}/memory/.semantic/decay-scores.json`;

// --- tunable constants (see formula above) -----------------------------------
export const DECAY = {
  DAY_MS: 24 * 60 * 60 * 1000,
  RECENCY_HALF_LIFE_DAYS: 30,   // recency reward halves every ~30 days
  STALE_HALF_LIFE_DAYS: 180,    // long-unused dampening half-life (~6 months)
  RECENCY_BOOST_MAX: 0.5,       // max recency reward at age 0 → recencyBoost up to 1.5
  STALE_DAMPEN_MAX: 0.7,        // max staleness dampen as age→∞ → recencyBoost down to 0.3
  ACCESS_K: 0.15,               // accessBoost slope on log2(access+1)
  ACCESS_CAP: 1.5,              // accessBoost ceiling
  IMPORTANCE_DEFAULT: 0.5,      // importance 0.5 ⇒ weight 1.0
  FACTOR_MIN: 0.3,              // overall factor floor
  FACTOR_MAX: 1.5,              // overall factor ceiling
};

export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// Pure: multiplier for one file's entry. Missing/blank/invalid entry ⇒ EXACTLY 1.0.
export function decayFactor(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== "object") return 1.0;
  const D = DECAY;

  const access = Number.isFinite(entry.access) && entry.access > 0 ? entry.access : 0;
  const accessBoost = Math.min(D.ACCESS_CAP, 1 + D.ACCESS_K * Math.log2(access + 1));

  const imp = Number.isFinite(entry.importance) ? clamp(entry.importance, 0, 1) : D.IMPORTANCE_DEFAULT;
  const importanceWeight = imp / D.IMPORTANCE_DEFAULT; // 0.5 ⇒ 1.0

  let recencyBoost = 1.0;
  if (Number.isFinite(entry.lastAccessMs) && entry.lastAccessMs > 0) {
    const ageDays = Math.max(0, (nowMs - entry.lastAccessMs) / D.DAY_MS);
    const boost = D.RECENCY_BOOST_MAX * Math.pow(2, -ageDays / D.RECENCY_HALF_LIFE_DAYS);
    const dampen = D.STALE_DAMPEN_MAX * (1 - Math.pow(2, -ageDays / D.STALE_HALF_LIFE_DAYS));
    recencyBoost = 1 + boost - dampen;
  }

  return clamp(recencyBoost * accessBoost * importanceWeight, D.FACTOR_MIN, D.FACTOR_MAX);
}

// Load the score store. Absent / empty / corrupt ⇒ safe neutral { version:1, entries:{} }.
// NEVER throws — a bad file must not break search.
export function loadDecayScores(p = DECAY_PATH) {
  try {
    if (!fs.existsSync(p)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return { version: 1, entries: {} };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || !obj.entries || typeof obj.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: obj.entries };
  } catch {
    return { version: 1, entries: {} }; // corrupt ⇒ neutral, no crash
  }
}

// --- best-effort concurrent-writer guard (short-lived lock; steal if stale) ---
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;
function acquireLock(lock) {
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" }); // exclusive create
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") return false;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); return acquireLock(lock); } } catch {}
    return false; // held by a live writer → skip this update (best-effort)
  }
}

// Living signal: for each returned file bump access +1 and stamp lastAccessMs = now, then persist atomically.
// BEST-EFFORT: never throws, never blocks meaningfully. On lock contention or any error it just returns false.
// Returns true iff it persisted. `opts.path` / `opts.nowMs` are for tests.
export function recordAccess(relPaths, opts = {}) {
  const p = opts.path || DECAY_PATH;
  const nowMs = opts.nowMs || Date.now();
  const uniq = [...new Set((relPaths || []).filter((r) => typeof r === "string" && r))];
  if (!uniq.length) return false;
  const lock = `${p}.lock`;
  if (!acquireLock(lock)) return false;
  try {
    const store = loadDecayScores(p);
    for (const rel of uniq) {
      const e = store.entries[rel] && typeof store.entries[rel] === "object"
        ? store.entries[rel]
        : { access: 0, lastAccessMs: 0, importance: DECAY.IMPORTANCE_DEFAULT };
      e.access = (Number.isFinite(e.access) && e.access > 0 ? e.access : 0) + 1;
      e.lastAccessMs = nowMs;
      if (!Number.isFinite(e.importance)) e.importance = DECAY.IMPORTANCE_DEFAULT;
      store.entries[rel] = e;
    }
    writeJsonAtomic(p, { version: 1, entries: store.entries });
    return true;
  } catch {
    return false; // a failed score write must NEVER fail a search
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch {}
  }
}
