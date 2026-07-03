// test-vecstore.mjs — tests for the OPTIONAL sqlite-vec read-acceleration backend (vecstore.mjs).
//
// TWO layers:
//   (A) PURE (always runs; NO native dep, NO model): the opt-in/threshold decision (vecStoreMode /
//       isVecStoreEnabled), the fallback-to-JSON decisions (hard opt-out, missing db), db-path + pool-size
//       resolution, the metadata filter predicate, and the candidate → chunk/semScore contract via a MOCK
//       topK. Importing vecstore.mjs must NOT load better-sqlite3/sqlite-vec (they're dynamic-imported).
//   (B) REAL round-trip (gated behind availability; SKIPPED cleanly when the deps aren't installed):
//       build a tiny db from a mock index.json, query it, and assert the sqlite-vec KNN order EQUALS the
//       brute-force cosine order over the same vectors — plus filters, scores, and incremental upsert.
//
// Run: node test-vecstore.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cosine } from "./store.mjs";
import {
  VECSTORE, vecStoreMode, isVecStoreEnabled, vecDbPath, vecPoolSize,
  applyFilters, openVecStore, buildVecStore,
} from "./vecstore.mjs";

// --- tiny inline runner (async-aware; mirrors test-rerank/test-decay style) ---
let passed = 0, failed = 0, skipped = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  deepEqual: (x, y, m) => { assertCount++; assert.deepEqual(x, y, m); },
  close: (x, y, m, eps = 1e-4) => { assertCount++; assert.ok(Math.abs(x - y) <= eps, `${m || ""} — got ${x}, want ≈${y}`); },
};
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ============================================================================
// (A) PURE — decision layer, filters, and the candidate contract
// ============================================================================

// ---- opt-in mode classification -------------------------------------------
test("vecStoreMode: off | on | auto from the VECSTORE env toggle", () => {
  a.equal(vecStoreMode({}), "auto", "unset ⇒ auto (threshold decides)");
  a.equal(vecStoreMode({ VECSTORE: "json" }), "off", "json ⇒ hard opt-out");
  a.equal(vecStoreMode({ VECSTORE: "off" }), "off");
  a.equal(vecStoreMode({ VECSTORE: "0" }), "off");
  a.equal(vecStoreMode({ VECSTORE: "sqlite" }), "on", "sqlite ⇒ explicit opt-in");
  a.equal(vecStoreMode({ VECSTORE: "1" }), "on");
  a.equal(vecStoreMode({ VECSTORE: "SQLite" }), "on", "case-insensitive");
});

// ---- enable/threshold logic (the heart of the opt-in decision) ------------
test("isVecStoreEnabled: default JSON below threshold; auto-enable above it", () => {
  a.equal(isVecStoreEnabled(10, {}), false, "small corpus, unset ⇒ JSON (default)");
  a.equal(isVecStoreEnabled(VECSTORE.THRESHOLD - 1, {}), false, "just under threshold ⇒ JSON");
  a.equal(isVecStoreEnabled(VECSTORE.THRESHOLD, {}), true, "at threshold ⇒ auto-enable");
  a.equal(isVecStoreEnabled(50000, {}), true, "large corpus ⇒ auto-enable");
});
test("isVecStoreEnabled: explicit opt-in/out overrides the count", () => {
  a.equal(isVecStoreEnabled(1, { VECSTORE: "sqlite" }), true, "explicit on wins even for a tiny corpus");
  a.equal(isVecStoreEnabled(1e9, { VECSTORE: "json" }), false, "explicit off wins even for a huge corpus");
});
test("isVecStoreEnabled: VECSTORE_THRESHOLD overrides the default; bad counts ⇒ false", () => {
  a.equal(isVecStoreEnabled(100, { VECSTORE_THRESHOLD: "50" }), true, "custom threshold met");
  a.equal(isVecStoreEnabled(40, { VECSTORE_THRESHOLD: "50" }), false, "custom threshold not met");
  a.equal(isVecStoreEnabled(NaN, {}), false, "non-finite count ⇒ safe false");
});

// ---- db path + pool size resolution ---------------------------------------
test("vecDbPath: VECSTORE_DB wins; else <workspace>/memory/.semantic/vec.sqlite", () => {
  a.equal(vecDbPath({ VECSTORE_DB: "/tmp/x.sqlite" }), "/tmp/x.sqlite");
  a.equal(vecDbPath({ OPENCLAW_WORKSPACE: "/ws" }), "/ws/memory/.semantic/vec.sqlite");
});
test("vecPoolSize: generous default, override, and never below k", () => {
  a.equal(vecPoolSize(8, {}), Math.max(8 * VECSTORE.POOL_MULT, VECSTORE.POOL_MIN), "default = max(k×mult, floor)");
  a.equal(vecPoolSize(8, { VECSTORE_CANDIDATES: "1000" }), 1000, "override honored");
  a.equal(vecPoolSize(5000, { VECSTORE_CANDIDATES: "10" }), 5000, "override never drops below k");
});

// ---- filter predicate (must match hybrid.mjs's index.json filter exactly) --
const CANDS = [
  { id: "a:1", path: "a.md", startLine: 1, text: "alpha", ord: 0, score: 0.9, vector: [1, 0, 0, 0], meta: { type: "note", status: "active", tags: ["x", "y"], date: "" } },
  { id: "b:1", path: "b.md", startLine: 1, text: "beta", ord: 1, score: 0.8, vector: [0, 1, 0, 0], meta: { type: "pattern", status: "active", tags: ["y"], date: "" } },
  { id: "c:1", path: "c.md", startLine: 1, text: "gamma", ord: 2, score: 0.7, vector: [0, 0, 1, 0], meta: { type: "note", status: "archived", tags: [], date: "" } },
];
test("applyFilters: type / status / tag / combined / pass-through", () => {
  a.deepEqual(applyFilters(CANDS, {}).map((c) => c.id), ["a:1", "b:1", "c:1"], "no filter ⇒ unchanged");
  a.deepEqual(applyFilters(CANDS, { type: "note" }).map((c) => c.id), ["a:1", "c:1"], "type=note");
  a.deepEqual(applyFilters(CANDS, { status: "archived" }).map((c) => c.id), ["c:1"], "status=archived");
  a.deepEqual(applyFilters(CANDS, { tag: "x" }).map((c) => c.id), ["a:1"], "tag=x (array membership)");
  a.deepEqual(applyFilters(CANDS, { type: "note", status: "active" }).map((c) => c.id), ["a:1"], "combined AND");
  a.deepEqual(applyFilters(CANDS, { type: "nope" }).map((c) => c.id), [], "no match ⇒ empty (→ callers fall back)");
});

// ---- fallback-to-JSON decisions (no native dep involved) ------------------
test("openVecStore: a missing db path ⇒ null (⇒ caller uses JSON) without loading any native dep", async () => {
  const h = await openVecStore("/definitely/not/here/vec.sqlite");
  a.equal(h, null, "missing db ⇒ null handle");
  a.equal(await openVecStore(""), null, "empty path ⇒ null");
});

// ---- candidate → chunk/semScore contract (via a MOCK topK) ----------------
// Mirrors EXACTLY the mapping hybrid.mjs applies to store.topK() output, proving the contract the engine
// depends on: each candidate yields a chunk {rel,startLine,text,type} and a semScore (its cosine sim).
test("candidate contract: a mock topK maps into the chunk shape + semScore the engine consumes", () => {
  const store = {
    dim: 4,
    chunkCount: 3,
    topK(_qv, k, filters) { return applyFilters(CANDS, filters).slice(0, k); },
  };
  const cands = store.topK([1, 0, 0, 0], 8, { type: "note" });
  a.equal(cands.length, 2, "filtered candidate set");
  // the exact map hybrid.mjs / deep.mjs run — sort by ord (index.json order) then carry the stored vector:
  cands.sort((x, y) => x.ord - y.ord);
  const chunks = cands.map((c) => ({ rel: c.path, startLine: c.startLine, text: c.text, vector: c.vector, type: c.meta.type }));
  a.deepEqual(chunks[0], { rel: "a.md", startLine: 1, text: "alpha", vector: [1, 0, 0, 0], type: "note" }, "chunk shape matches JSON-path chunks (incl. vector)");
  // the engine re-scores with the SAME cosine() the JSON path uses (NOT sqlite's f32 score) ⇒ identical rank:
  const semScore = chunks.map((c) => cosine([1, 0, 0, 0], c.vector));
  a.close(semScore[0], 1.0, "semScore via the shared cosine() over the carried vector");
  for (const c of cands) a.ok("id" in c && "path" in c && "meta" in c && "score" in c && "vector" in c && "ord" in c, "contract keys {id,path,meta,score,vector,ord} present");
});

// ============================================================================
// (B) REAL round-trip — gated behind availability (skipped when deps absent)
// ============================================================================

// Probe: are better-sqlite3 + sqlite-vec actually installed AND loadable here? Any failure ⇒ we skip the
// real tests cleanly (they're opt-in deps, not installed by default). Never fails the suite for absence.
async function depsAvailable() {
  try {
    const bs = await import("better-sqlite3");
    const sv = await import("sqlite-vec");
    const Database = bs.default || bs;
    const load = sv.load || (sv.default && sv.default.load);
    const db = new Database(":memory:");
    load(db);
    db.exec("CREATE VIRTUAL TABLE t USING vec0(v float[3] distance_metric=cosine)");
    db.close();
    return true;
  } catch { return false; }
}

// A tiny 4-dim mock index.json (well-separated vectors ⇒ no f32/f64 tie ambiguity in the KNN order).
function mockIndex() {
  return {
    meta: { model: "mock", dim: 4, builtAt: "t" },
    files: {
      "a.md": { mtime: 100, meta: { type: "note", status: "active", tags: ["x"], date: "2026-01-01" }, chunks: [{ startLine: 1, text: "alpha apple", vector: [1, 0, 0, 0] }] },
      "b.md": { mtime: 200, meta: { type: "pattern", status: "active", tags: ["y"], date: "" }, chunks: [{ startLine: 1, text: "beta banana", vector: [0, 1, 0, 0] }, { startLine: 5, text: "beta second", vector: [0.9, 0.1, 0, 0] }] },
      "c.md": { mtime: 300, meta: { type: "note", status: "archived", tags: [], date: "" }, chunks: [{ startLine: 1, text: "gamma grape", vector: [0, 0, 1, 0] }] },
    },
  };
}
// Brute-force reference: cosine of qv against every chunk, sorted DESC → ordered ids (the JSON-path order).
function bruteForceOrder(index, qv) {
  const rows = [];
  for (const [rel, e] of Object.entries(index.files)) for (const c of e.chunks) rows.push({ id: `${rel}:${c.startLine}`, sim: cosine(qv, c.vector) });
  rows.sort((x, y) => y.sim - x.sim);
  return rows.map((r) => r.id);
}

async function runReal() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vecstore-test-"));
  const idxPath = path.join(tmp, "index.json");
  const dbPath = path.join(tmp, "vec.sqlite");
  const idx = mockIndex();
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  const qv = [1, 0, 0, 0]; // nearest a.md:1 (sim 1.0), then b.md:5 (sim ≈0.994), then the two zeros

  try {
    // --- build ---
    const built = await buildVecStore(idxPath, dbPath, {});
    a.equal(built.ok, true, "buildVecStore succeeds");
    a.equal(built.dim, 4, "dim inferred from index.meta");
    a.equal(built.chunksWritten, 4, "all 4 chunks inserted");

    const store = await openVecStore(dbPath);
    a.ok(store, "openVecStore returns a handle");
    a.equal(store.dim, 4, "handle reports dim");
    a.equal(store.chunkCount, 4, "handle reports chunk count");

    // --- KNN order == brute-force cosine order (the core parity guarantee) ---
    const cands = store.topK(qv, 10, {});
    const knnOrder = cands.map((c) => c.id);
    const bf = bruteForceOrder(idx, qv);
    a.deepEqual(knnOrder.slice(0, 2), bf.slice(0, 2), "sqlite-vec KNN top-2 == brute-force cosine top-2");
    a.deepEqual(knnOrder.slice(0, 2), ["a.md:1", "b.md:5"], "expected nearest order");
    a.close(cands[0].score, 1.0, "exact-match score ≈ cosine 1.0");
    a.equal(cands.length, 4, "all chunks returned when k ≥ N");
    // sorting candidates by ord must reconstruct the index.json scan order (this is what keeps the engine's
    // RRF/decay tie-breaks byte-identical to the JSON path).
    a.deepEqual(cands.slice().sort((x, y) => x.ord - y.ord).map((c) => c.id), ["a.md:1", "b.md:1", "b.md:5", "c.md:1"], "ord reconstructs index.json order");

    // --- candidate contract shape ---
    const c0 = cands[0];
    a.ok(typeof c0.id === "string" && c0.path === "a.md" && c0.startLine === 1 && typeof c0.text === "string", "contract fields present");
    a.deepEqual(c0.meta.tags, ["x"], "tags round-tripped through JSON column");
    a.equal(c0.meta.type, "note", "meta.type round-tripped");
    a.deepEqual(c0.vector, [1, 0, 0, 0], "stored embedding round-trips bit-identically (f32 blob)");
    // recompute cosine over the returned vector — the exact ranking signal the engine uses:
    a.close(cosine(qv, c0.vector), 1.0, "re-scored cosine == JSON-path cosine for the exact match");

    // --- filters through the real query path ---
    a.deepEqual(store.topK(qv, 10, { type: "note" }).map((c) => c.id).sort(), ["a.md:1", "c.md:1"], "type=note filter");
    a.deepEqual(store.topK(qv, 10, { status: "archived" }).map((c) => c.id), ["c.md:1"], "status filter");
    a.deepEqual(store.topK(qv, 10, { tag: "x" }).map((c) => c.id), ["a.md:1"], "tag filter");
    store.close();

    // --- incremental: no changes ⇒ everything reused, nothing rewritten ---
    const inc0 = await buildVecStore(idxPath, dbPath, { incremental: true });
    a.equal(inc0.chunksWritten, 0, "incremental no-op writes nothing");
    a.equal(inc0.reused, 4, "…and reuses all 4 chunks");

    // --- incremental: bump one file's mtime ⇒ only it is rewritten ---
    idx.files["a.md"].mtime = 999;
    idx.files["a.md"].chunks[0].vector = [0, 0, 0, 1];
    fs.writeFileSync(idxPath, JSON.stringify(idx));
    const inc1 = await buildVecStore(idxPath, dbPath, { incremental: true });
    a.equal(inc1.chunksWritten, 1, "only the changed file re-inserted");
    a.equal(inc1.reused, 3, "the other 3 chunks reused");
    const store2 = await openVecStore(dbPath);
    a.equal(store2.topK([0, 0, 0, 1], 1, {})[0].id, "a.md:1", "updated vector now nearest to its new direction");
    store2.close();

    console.log("  (real sqlite-vec round-trip: RAN)");
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// --- run + report ------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
  }
  if (await depsAvailable()) {
    try { await runReal(); passed++; }
    catch (e) { failed++; console.error(`  ✗ real round-trip\n    ${e && e.message}`); }
  } else {
    skipped++;
    console.log("  ⏭  real sqlite-vec round-trip SKIPPED — better-sqlite3 + sqlite-vec not installed");
    console.log("     (install the opt-in deps with: ./install.sh --with-sqlite-vec)");
  }
  console.log(`\ntest-vecstore: ${passed} passed, ${failed} failed, ${skipped} skipped  (${assertCount} assertions)`);
  process.exit(failed ? 1 : 0);
})();
