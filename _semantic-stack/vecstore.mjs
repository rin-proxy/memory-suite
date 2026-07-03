// vecstore.mjs — OPTIONAL sqlite-vec read-acceleration backend for semantic recall.
//
// WHAT THIS IS: a DERIVED, on-disk KNN index (built FROM index.json) that lets msem/mdeep fetch the
// semantic candidate set WITHOUT loading the entire index.json into Node and running JS cosine over
// every chunk. sqlite-vec does an exact nearest-neighbour scan in native C over a memory-mapped table,
// then we run the EXISTING keyword + RRF + decay + optional-rerank stages over just that candidate set.
// It is a SCALING upgrade for large corpora — the ranking math is unchanged; only the semantic FETCH
// backend changes.
//
// NON-NEGOTIABLE CONTRACT (this is the whole point of "optional"):
//   - JSON is the DEFAULT and the SOURCE OF TRUTH. index.json + the write path (index.mjs /
//     index-transcripts.mjs) are UNCHANGED. This db is a read-only accelerator built on the side.
//   - OPT-IN only: env VECSTORE=sqlite, and/or auto-enable above a chunk-count threshold (~8000,
//     override via VECSTORE_THRESHOLD). VECSTORE=json|off|0 hard-disables it.
//   - If the native deps (better-sqlite3 + sqlite-vec) are absent, the db doesn't exist, its dim
//     mismatches, or ANYTHING throws → callers SILENTLY fall back to the JSON path (never break search).
//   - better-sqlite3 + sqlite-vec are imported DYNAMICALLY, only inside openVecStore()/buildVecStore().
//     Importing THIS module never loads a native addon — so the pure test (test-vecstore.mjs) and the
//     model-free stack stay loadable without the opt-in deps installed.
//
// The decision helpers (vecStoreMode / isVecStoreEnabled / vecDbPath / vecPoolSize) and the pure filter
// (applyFilters) are dependency-free and unit-tested; the native round-trip is tested only when the deps
// are present.
import { WS, fs, path } from "./store.mjs";
import { pathToFileURL } from "node:url";

// --- tunables ---------------------------------------------------------------
export const VECSTORE = {
  THRESHOLD: 8000,        // auto-enable (VECSTORE unset) once the corpus has ≥ this many chunks
  POOL_MULT: 25,          // default candidate pool = max(k × this, POOL_MIN)
  POOL_MIN: 400,          // floor for the candidate pool (so small-k queries still fetch a healthy set)
  FILTER_INFLATE: 8,      // when metadata filters are active, over-fetch this× before post-filtering
  FILTER_MIN_FETCH: 1000, // …and never fetch fewer than this many pre-filter rows
  DB_BASENAME: "vec.sqlite",
};

// ---------------------------------------------------------------------------
// Decision layer — PURE, no I/O, no native deps (unit-tested)
// ---------------------------------------------------------------------------

// Classify the VECSTORE env toggle → "off" | "on" | "auto".
//   off  : VECSTORE ∈ {json, off, 0, false, no}         ⇒ hard opt-out (force the JSON path)
//   on   : VECSTORE ∈ {sqlite, vec, 1, true, on, yes}   ⇒ explicit opt-in (use it if usable)
//   auto : unset / anything else                        ⇒ decide by chunk-count threshold
export function vecStoreMode(env = process.env) {
  const v = String((env && env.VECSTORE) || "").trim().toLowerCase();
  if (["json", "off", "0", "false", "no"].includes(v)) return "off";
  if (["sqlite", "vec", "1", "true", "on", "yes"].includes(v)) return "on";
  return "auto";
}

// SHOULD we use sqlite-vec, given how many chunks the corpus has? (Whether we CAN is openVecStore's job.)
//   off  ⇒ false always.   on ⇒ true always.   auto ⇒ true once chunkCount ≥ threshold.
// The threshold is VECSTORE_THRESHOLD (int) or the default. Non-finite counts ⇒ false (safe).
export function isVecStoreEnabled(chunkCount, env = process.env) {
  const mode = vecStoreMode(env);
  if (mode === "off") return false;
  if (mode === "on") return true;
  const raw = env && env.VECSTORE_THRESHOLD;
  const threshold = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : VECSTORE.THRESHOLD;
  return Number.isFinite(chunkCount) && chunkCount >= threshold;
}

// Where the derived db lives. VECSTORE_DB wins; else <workspace>/memory/.semantic/vec.sqlite.
export function vecDbPath(env = process.env) {
  if (env && env.VECSTORE_DB) return env.VECSTORE_DB;
  const ws = (env && env.OPENCLAW_WORKSPACE) || WS;
  return `${ws}/memory/.semantic/${VECSTORE.DB_BASENAME}`;
}

// Candidate-pool size to request from topK for a display-k. Big enough that the downstream keyword+RRF
// over the pool reproduces the full-scan top-k; VECSTORE_CANDIDATES overrides. Never below k.
export function vecPoolSize(k, env = process.env) {
  const kk = Number.isFinite(k) && k > 0 ? Math.floor(k) : 8;
  const override = env && Number(env.VECSTORE_CANDIDATES);
  if (Number.isFinite(override) && override > 0) return Math.max(kk, Math.floor(override));
  return Math.max(kk, kk * VECSTORE.POOL_MULT, VECSTORE.POOL_MIN);
}

// PURE metadata filter — the EXACT predicate hybrid.mjs uses over index.json, applied to vec candidates
// so a filtered vec query matches a filtered JSON query. Missing filters ⇒ pass-through.
export function applyFilters(cands, filters) {
  if (!filters || !(filters.type || filters.status || filters.tag)) return cands;
  const { type, status, tag } = filters;
  return cands.filter((c) => {
    const m = (c && c.meta) || {};
    if (type && m.type !== type) return false;
    if (status && m.status !== status) return false;
    if (tag && !(Array.isArray(m.tags) ? m.tags : []).includes(tag)) return false;
    return true;
  });
}

// Parse the stored tags column (JSON array text) back into an array — never throws.
function parseTags(s) {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Reconstruct a plain number[] from a stored float32 embedding blob (Buffer). Returns [] on anything odd.
function blobToVector(buf) {
  if (!Buffer.isBuffer(buf) || buf.length % 4 !== 0) return [];
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}

// ---------------------------------------------------------------------------
// Native-dep loader (dynamic) — the ONLY code that touches better-sqlite3 / sqlite-vec
// ---------------------------------------------------------------------------
// Returns { Database, load } or null if either dep is absent. Never throws.
async function loadDeps() {
  try {
    const bs = await import("better-sqlite3");
    const sv = await import("sqlite-vec");
    const Database = bs.default || bs;
    const load = sv.load || (sv.default && sv.default.load) || null;
    if (typeof Database !== "function" || typeof load !== "function") return null;
    return { Database, load };
  } catch {
    return null; // dep unavailable ⇒ caller falls back to JSON
  }
}

// ---------------------------------------------------------------------------
// Query side — open a read-only handle and fetch nearest chunks
// ---------------------------------------------------------------------------
// openVecStore(dbPath) → handle | null. Handle: { dim, chunkCount, topK(qv,k,filters), close() }.
// null on: db missing, deps absent, or ANY error opening/loading the extension — so callers just use JSON.
export async function openVecStore(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const deps = await loadDeps();
  if (!deps) return null;
  let db;
  try {
    db = new deps.Database(dbPath, { readonly: true, fileMustExist: true });
    deps.load(db); // sqlite-vec loadable extension via better-sqlite3 loadExtension
    const dimRow = db.prepare("SELECT value FROM vec_meta WHERE key = 'dim'").get();
    const dim = dimRow ? parseInt(dimRow.value, 10) : 0;
    const chunkCount = db.prepare("SELECT count(*) AS n FROM chunks").get().n;
    // Exact KNN: sqlite-vec brute-forces in C, returns the k nearest by cosine distance, ordered. We also
    // read back the stored embedding so the caller can RE-SCORE with the same f64 cosine() the JSON path
    // uses — the stored f32 blob is bit-identical to index.json's vector, so recall/ranking stays IDENTICAL
    // (sqlite-vec's f32 distance is used only to SELECT the candidate pool, never to rank the final top-k).
    const knn = db.prepare(`
      SELECT c.rel AS rel, c.start_line AS start_line, c.text AS text,
             c.type AS type, c.status AS status, c.tags AS tags, c.date AS date, c.ord AS ord,
             v.distance AS distance, v.embedding AS emb
      FROM vec_chunks v JOIN chunks c ON c.rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance`);

    return {
      dim,
      chunkCount,
      // topK(queryVec, k, filters) → [{ id, path, meta:{type,status,tags,date}, score, text, startLine, vector }]
      // ordered nearest-first. `score` is cosine similarity (1 − cosine distance) for display/debug; `vector`
      // is the stored embedding so callers re-score with their own cosine() for exact JSON-path parity.
      // filters (type/status/tag) use the SAME predicate hybrid.mjs applies to index.json; when present we
      // over-fetch first so the post-filter still yields a full pool.
      topK(queryVec, k, filters) {
        const wantFilter = !!(filters && (filters.type || filters.status || filters.tag));
        const want = Math.max(1, Math.floor(k) || 1);
        const fetchN = wantFilter
          ? Math.min(chunkCount || want, Math.max(want, want * VECSTORE.FILTER_INFLATE, VECSTORE.FILTER_MIN_FETCH))
          : Math.min(chunkCount || want, want);
        const blob = Buffer.from(new Float32Array(queryVec).buffer);
        const rows = knn.all(blob, fetchN);
        let cands = rows.map((r) => ({
          id: `${r.rel}:${r.start_line}`,
          path: r.rel,
          startLine: r.start_line,
          text: r.text,
          ord: r.ord, // index.json scan position — callers sort by this to match the JSON-path order
          score: 1 - r.distance, // cosine distance → cosine similarity
          vector: blobToVector(r.emb), // stored f32 embedding, bit-identical to index.json's
          meta: { type: r.type, status: r.status, tags: parseTags(r.tags), date: r.date },
        }));
        if (wantFilter) cands = applyFilters(cands, filters).slice(0, want);
        return cands;
      },
      close() { try { db.close(); } catch {} },
    };
  } catch {
    try { if (db) db.close(); } catch {}
    return null; // any open/query-prep failure ⇒ JSON fallback
  }
}

// ---------------------------------------------------------------------------
// Build side — (re)build the derived db FROM index.json (explicit, opt-in; not the write path)
// ---------------------------------------------------------------------------
function getExistingDim(db) {
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_meta'").get();
    if (!has) return 0;
    const row = db.prepare("SELECT value FROM vec_meta WHERE key='dim'").get();
    return row ? parseInt(row.value, 10) : 0;
  } catch { return 0; }
}
function dropTables(db) {
  for (const t of ["vec_chunks", "chunks", "files", "vec_meta"]) {
    try { db.exec(`DROP TABLE IF EXISTS ${t};`); } catch {}
  }
}
function createTables(db, dim) {
  db.exec(`CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS files (rel TEXT PRIMARY KEY, mtime REAL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS chunks (
     rowid INTEGER PRIMARY KEY,
     id TEXT, rel TEXT, start_line INTEGER, text TEXT,
     type TEXT, status TEXT, tags TEXT, date TEXT, mtime REAL,
     ord INTEGER,
     UNIQUE(rel, start_line));`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_rel ON chunks(rel);`);
  // vec0 virtual table; cosine metric so KNN order matches the JSON path's cosine() exactly.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine);`);
}

// buildVecStore(indexJsonPath, dbPath, { incremental, log }) → result object.
//   { ok:true, dim, filesWritten, chunksWritten, reused, removed, totalChunks, dbPath }
//   { ok:false, reason, error }   reason ∈ dependency-unavailable | index-missing | index-unparseable |
//                                  empty-index | build-error
// Incremental: skip files whose index.json mtime is unchanged; re-embed-free (vectors come straight from
// index.json). A dim change or a non-incremental run resets the db. Deleted files are pruned.
export async function buildVecStore(indexJsonPath, dbPath, opts = {}) {
  const incremental = !!opts.incremental;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const deps = await loadDeps();
  if (!deps) return { ok: false, reason: "dependency-unavailable", error: "better-sqlite3 + sqlite-vec not installed (run: ./install.sh --with-sqlite-vec)" };
  if (!fs.existsSync(indexJsonPath)) return { ok: false, reason: "index-missing", error: `no index.json at ${indexJsonPath}` };
  let index;
  try { index = JSON.parse(fs.readFileSync(indexJsonPath, "utf8")); }
  catch (e) { return { ok: false, reason: "index-unparseable", error: e && e.message }; }
  const files = (index && index.files) || {};

  // Dimension: prefer index.meta.dim; else infer from the first chunk vector.
  let dim = Number(index.meta && index.meta.dim) || 0;
  if (!dim) {
    for (const e of Object.values(files)) {
      const v = e && e.chunks && e.chunks[0] && e.chunks[0].vector;
      if (Array.isArray(v) && v.length) { dim = v.length; break; }
    }
  }
  if (!dim) return { ok: false, reason: "empty-index", error: "index.json has no vectors to index" };

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new deps.Database(dbPath);
    deps.load(db);
    db.pragma("journal_mode = WAL");

    const existingDim = getExistingDim(db);
    const reset = !incremental || (existingDim && existingDim !== dim);
    if (reset) dropTables(db);
    createTables(db, dim);

    const selRowids = db.prepare("SELECT rowid FROM chunks WHERE rel = ?");
    const delVec = db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
    const delChunks = db.prepare("DELETE FROM chunks WHERE rel = ?");
    const delFile = db.prepare("DELETE FROM files WHERE rel = ?");
    const getMtime = db.prepare("SELECT mtime FROM files WHERE rel = ?");
    const insChunk = db.prepare(`INSERT INTO chunks (id, rel, start_line, text, type, status, tags, date, mtime, ord)
                                 VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insVec = db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
    const upFile = db.prepare("INSERT INTO files (rel, mtime) VALUES (?, ?) ON CONFLICT(rel) DO UPDATE SET mtime = excluded.mtime");
    const updOrd = db.prepare("UPDATE chunks SET ord = ? WHERE rel = ? AND start_line = ?");
    const removeRel = (rel) => { for (const r of selRowids.all(rel)) delVec.run(r.rowid); delChunks.run(rel); delFile.run(rel); };

    const present = new Set(Object.keys(files));
    const dbRels = reset ? [] : db.prepare("SELECT rel FROM files").all().map((r) => r.rel);

    // `ord` = each chunk's position in the index.json scan (Object.entries(files) × chunk order). Storing it
    // lets the query side reconstruct the JSON-path chunk order, so RRF/decay TIE-BREAKS resolve identically
    // ⇒ byte-for-byte parity with the JSON path, not just the same candidate set. Reused files are realigned
    // to their current position too, so incremental content edits keep ord correct.
    let ord = 0, filesWritten = 0, chunksWritten = 0, reused = 0, removed = 0;
    const tx = db.transaction(() => {
      for (const rel of dbRels) if (!present.has(rel)) { removeRel(rel); removed++; }
      for (const [rel, e] of Object.entries(files)) {
        const chunkList = (e && e.chunks) || [];
        const mtime = Number(e && e.mtime) || 0;
        if (incremental && !reset) {
          const row = getMtime.get(rel);
          if (row && row.mtime === mtime) { for (const c of chunkList) { updOrd.run(ord, rel, c.startLine); ord++; } reused += chunkList.length; continue; }
        }
        removeRel(rel); // clear any stale rows for this file, then re-insert
        const meta = (e && e.meta) || {};
        const tags = JSON.stringify(meta.tags || []);
        for (const c of chunkList) {
          const thisOrd = ord++; // advance per JSON chunk (keeps valid chunks aligned with the JSON scan order)
          if (!Array.isArray(c.vector) || c.vector.length !== dim) continue; // skip malformed/wrong-dim
          const info = insChunk.run(
            `${rel}:${c.startLine}`, rel, c.startLine, c.text,
            meta.type || "note", meta.status || "active", tags, meta.date || "", mtime, thisOrd,
          );
          // vec0 requires an INTEGER rowid; better-sqlite3 must bind it as a BigInt (a plain JS number
          // is rejected by sqlite-vec's primary-key type check).
          insVec.run(BigInt(info.lastInsertRowid), Buffer.from(new Float32Array(c.vector).buffer));
          chunksWritten++;
        }
        upFile.run(rel, mtime);
        filesWritten++;
      }
      const setMeta = db.prepare("INSERT INTO vec_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      setMeta.run("dim", String(dim));
      setMeta.run("model", String((index.meta && index.meta.model) || ""));
      setMeta.run("source", String(indexJsonPath));
      setMeta.run("builtAt", new Date().toISOString());
    });
    tx();
    log(`  ${reset ? "rebuilt" : "updated"} ${filesWritten} files, ${chunksWritten} chunks (reused ${reused}, removed ${removed})…\n`);
    const totalChunks = db.prepare("SELECT count(*) AS n FROM chunks").get().n;
    db.close();
    return { ok: true, dbPath, dim, filesWritten, chunksWritten, reused, removed, totalChunks };
  } catch (e) {
    return { ok: false, reason: "build-error", error: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// CLI:  node vecstore.mjs --build [--ws PATH] [--index PATH] [--db PATH] [--incremental]
// Builds the derived accelerator from index.json. OPT-IN — default recall never needs this.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  if (!has("--build") && !has("--incremental")) {
    console.error(`Usage: node vecstore.mjs --build [--ws PATH] [--index PATH] [--db PATH] [--incremental]
  Builds a sqlite-vec read-acceleration index FROM index.json (OPT-IN; the default recall path uses JSON).
  Enable it at query time with:  VECSTORE=sqlite msem "…"   (or auto above VECSTORE_THRESHOLD chunks).`);
    process.exit(2);
  }
  const ws = val("--ws", process.env.OPENCLAW_WORKSPACE || WS);
  const indexPath = val("--index", `${ws}/memory/.semantic/index.json`);
  const dbPath = val("--db", null) || vecDbPath({ ...process.env, OPENCLAW_WORKSPACE: ws });
  const incremental = has("--incremental");
  console.log(`🔧 vecstore build (${incremental ? "incremental" : "full"})  index=${indexPath}  →  ${dbPath}`);
  const res = await buildVecStore(indexPath, dbPath, { incremental, log: (m) => process.stdout.write(m) });
  if (!res.ok) {
    if (res.reason === "dependency-unavailable") {
      console.error(`❌ ${res.error}`);
      process.exit(3); // distinct code: the opt-in native deps aren't installed
    }
    console.error(`❌ vecstore build failed (${res.reason}): ${res.error}`);
    process.exit(1);
  }
  console.log(`✅ vecstore: ${res.chunksWritten} chunks written · ${res.reused} reused · ${res.removed} files pruned · dim ${res.dim} · ${res.totalChunks} total → ${res.dbPath}`);
}
