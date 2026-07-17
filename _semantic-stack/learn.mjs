// learn.mjs — PROVIDER-FREE learning layer over the memory link graph (memory-suite's answer to
// dinomem-neuron's L2/L3/L4, done LOCAL + DETERMINISTIC + TOKEN-FREE).
//
// WHY THIS EXISTS: buildLinks() (links.mjs) makes a fresh graph each run — it has no MEMORY of which
// connections keep recurring. Real "learning" is the signal that a link seen ONCE is noise, but a link
// that keeps re-appearing across rebuilds is a genuine pattern (the Hebbian principle: edges that fire
// together, wire together). This module persists the graph across runs, reinforces recurring edges,
// clusters the durable ones, and PROMOTES stable clusters into insights that can be injected every turn.
//
// THE COMPETITIVE POINT: dinomem-neuron gets this by running an LLM over a Docker/ChromaDB stack on a
// daily cron (continuous token burn, dies when the provider is down). memory-suite gets the SAME learning
// outcome from PURE CODE over the vectors already in index.json — no LLM, no Docker, no network, and it
// keeps working during a provider outage. An LLM is used ONLY (optionally) to phrase a promoted cluster
// into one polished sentence; the graph → recurrence → cluster → promotion MACHINERY needs no model.
//
// FIVE PURE PRIMITIVES (model-free, deterministic — synthetic graphs/timestamps in tests):
//   • reinforceGraph(prevGraph, links, nowMs, opts)     → persistable graph w/ Hebbian recurrence per edge
//   • clusterGraph(graph, opts)                          → connected components over durable edges
//   • promotableClusters(clusters, graph, opts)          → clusters that pass the promotion gate
//   • promoteInsights(prevInsights, candidates, nowMs)   → persistent insight store w/ its own recurrence
//   • detectContradictions(insight, textOf)              → lightweight provider-free contradiction flags
//
// PURITY: imports only `cosine` from store.mjs and `buildLinks` from links.mjs (both pure). The CLI reads
// vectors straight from memory/.semantic/index.json — so `learn rebuild` runs with NO embedding model.
import { cosine } from "./store.mjs";
import { buildLinks } from "./links.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// --- tunables (all overridable via opts) -----------------------------------------------------------
export const LEARN = {
  EDGE_HALF_LIFE_ROUNDS: 6,   // an edge not re-seen for this many rounds decays to ~half strength
  EDGE_DROP_ROUNDS: 12,       // an edge unseen this many rounds is forgotten (pruned)
  WEIGHT_EMA_ALPHA: 0.5,      // smoothing for an edge's weight across rounds (0..1; higher = trust latest more)
  RECURRENCE_SAT: 5,          // recurrence count at which the reinforcement factor saturates toward its cap
  RECURRENCE_CAP: 1.5,        // max reinforcement multiplier a fully-recurrent edge earns
  PROMOTE_EDGE_FLOOR: 0.30,   // only edges with neuralScore ≥ this participate in clustering
  MIN_CLUSTER_SIZE: 3,        // a promotable insight needs ≥ this many member notes (convergence)
  MAX_CLUSTER_SIZE: 12,       // …and ≤ this: a real pattern is a handful of notes, not the whole memory
  MIN_DENSITY: 0.34,          // internal-edge density (edges / possible) — rejects diffuse chains/blobs
  MIN_EDGE_RECURRENCE: 3,     // its internal edges must have recurred ≥ this many rounds (durability)
  MIN_CLUSTER_STRENGTH: 0.90, // sum of member-edge neuralScores must reach this (aggregate signal)
  INSIGHT_DEDUP_JACCARD: 0.6, // two insights sharing ≥ this member overlap are the same insight
  DAY_MS: 24 * 60 * 60 * 1000,
};

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d) => (Number.isFinite(v) ? v : d);
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ============================== reinforceGraph ==============================
// PURE. Merge a freshly-built link set into the persisted graph, applying Hebbian recurrence.
//   prevGraph : { round, edges: { key: {a,b,recurrence,firstRound,lastRound,weightEMA,signals} } } | null
//   links     : output of buildLinks() — [{ a, b, weight, signals, ... }]
//   nowMs     : timestamp (caller supplies; keeps this pure/resumable)
// Returns a NEW graph (prev is not mutated). Each edge gains:
//   recurrence  — how many rounds it has appeared (the learning signal)
//   weightEMA   — smoothed weight across rounds (robust to a single noisy build)
//   neuralScore — weightEMA × recurrenceFactor, decayed by rounds-since-last-seen (the composite strength)
// Edges unseen for > EDGE_DROP_ROUNDS are pruned (forgotten).
export function reinforceGraph(prevGraph, links, nowMs, opts = {}) {
  const half = num(opts.edgeHalfLifeRounds, LEARN.EDGE_HALF_LIFE_ROUNDS);
  const drop = num(opts.edgeDropRounds, LEARN.EDGE_DROP_ROUNDS);
  const alpha = clamp(num(opts.weightEmaAlpha, LEARN.WEIGHT_EMA_ALPHA), 0, 1);
  const recSat = num(opts.recurrenceSat, LEARN.RECURRENCE_SAT);
  const recCap = num(opts.recurrenceCap, LEARN.RECURRENCE_CAP);

  const prev = (prevGraph && typeof prevGraph === "object" && prevGraph.edges) ? prevGraph.edges : {};
  const round = (Number.isInteger(prevGraph && prevGraph.round) ? prevGraph.round : 0) + 1;
  const next = Object.create(null);

  // 1) carry forward existing edges (decayed), 2) reinforce the ones seen this round.
  const seen = new Set();
  for (const l of (Array.isArray(links) ? links : [])) {
    if (l == null || l.a == null || l.b == null || l.a === l.b) continue;
    const k = edgeKey(String(l.a), String(l.b));
    seen.add(k);
    const p = prev[k];
    const w = clamp(num(l.weight, 0), 0, 1);
    const e = p
      ? { a: p.a, b: p.b, recurrence: p.recurrence + 1, firstRound: p.firstRound, lastRound: round,
          weightEMA: alpha * w + (1 - alpha) * num(p.weightEMA, w), signals: l.signals || p.signals || [] }
      : { a: String(l.a), b: String(l.b), recurrence: 1, firstRound: round, lastRound: round,
          weightEMA: w, signals: l.signals || [] };
    next[k] = e;
  }
  // carry forward edges NOT seen this round (aged), prune the truly stale.
  for (const [k, p] of Object.entries(prev)) {
    if (seen.has(k)) continue;
    const missed = round - p.lastRound;
    if (missed > drop) continue; // forgotten
    next[k] = { ...p }; // kept, but lastRound stays → its neuralScore decays via age below
  }

  // finalize neuralScore for every edge: weightEMA × recurrenceFactor × ageDecay
  for (const k of Object.keys(next)) {
    const e = next[k];
    const recFactor = 1 + (recCap - 1) * clamp(e.recurrence / recSat, 0, 1);
    const age = round - e.lastRound;                      // rounds since last seen (0 if seen now)
    const ageDecay = Math.pow(0.5, age / (half || 1));    // half-life decay
    e.neuralScore = clamp(e.weightEMA * recFactor * ageDecay, 0, recCap);
  }
  return { round, updatedMs: nowMs, edges: next };
}

// ============================== clusterGraph ==============================
// PURE. BOUNDED DENSE clusters over edges with neuralScore ≥ edgeFloor — NOT naive connected components.
// WHY: on a dense memory, connected components chains everything into one giant blob ("633-note insight"
// = meaningless). A real learned pattern is a SMALL, MUTUALLY-connected group. So we grow clusters
// greedily from the strongest edge, only admitting a node that is densely connected to the current
// members, and cap the size. Each cluster: { members[], edges[], strength, density, minRecurrence }.
export function clusterGraph(graph, opts = {}) {
  const floor = num(opts.edgeFloor, LEARN.PROMOTE_EDGE_FLOOR);
  const maxSize = posInt(opts.maxClusterSize, LEARN.MAX_CLUSTER_SIZE);
  const minDensity = num(opts.minDensity, LEARN.MIN_DENSITY);
  const edges = (graph && graph.edges) ? Object.values(graph.edges) : [];
  const strong = edges.filter((e) => num(e.neuralScore, 0) >= floor);
  if (!strong.length) return [];

  // adjacency: node → Map(other → {neuralScore, recurrence})
  const adj = new Map();
  const link = (x, y, e) => { if (!adj.has(x)) adj.set(x, new Map()); adj.get(x).set(y, e); };
  for (const e of strong) { link(e.a, e.b, e); link(e.b, e.a, e); }

  // seeds: strongest strong edges first (deterministic tie-break on the edge key)
  const seeds = strong.slice().sort((x, y) => (y.neuralScore - x.neuralScore) || (edgeKey(x.a, x.b) < edgeKey(y.a, y.b) ? -1 : 1));

  const assigned = new Set();
  const clusters = [];
  for (const seed of seeds) {
    if (assigned.has(seed.a) && assigned.has(seed.b)) continue;
    const members = new Set([seed.a, seed.b]);
    // grow: repeatedly add the non-member with the most strong edges INTO the cluster, if it is dense enough
    while (members.size < maxSize) {
      const into = new Map(); // candidate → count of strong edges into current members
      for (const m of members) {
        const nbrs = adj.get(m); if (!nbrs) continue;
        for (const nbr of nbrs.keys()) { if (members.has(nbr) || assigned.has(nbr)) continue; into.set(nbr, (into.get(nbr) || 0) + 1); } // disjoint: never grow into a consumed node
      }
      if (!into.size) break;
      let bestNode = null, bestInto = 0;
      for (const [nbr, cnt] of into) { if (cnt > bestInto || (cnt === bestInto && (bestNode === null || nbr < bestNode))) { bestNode = nbr; bestInto = cnt; } }
      // density-preserving admission: must connect to ≥ ceil(minDensity·|members|) current members
      if (bestInto < Math.max(1, Math.ceil(minDensity * members.size))) break;
      members.add(bestNode);
    }
    // finalize: internal edges (both endpoints in members)
    const mset = members, mlist = [...members].sort();
    const internal = strong.filter((e) => mset.has(e.a) && mset.has(e.b));
    const m = mlist.length, possible = (m * (m - 1)) / 2;
    const density = possible ? internal.length / possible : 0;
    const strength = internal.reduce((s, e) => s + e.neuralScore, 0);
    const minRecurrence = internal.reduce((r, e) => Math.min(r, e.recurrence), Infinity);
    clusters.push({ members: mlist, edges: internal.map((e) => ({ a: e.a, b: e.b, neuralScore: e.neuralScore, recurrence: e.recurrence })), strength, density, minRecurrence: minRecurrence === Infinity ? 0 : minRecurrence });
    for (const x of members) assigned.add(x); // consume this cluster's nodes (progress guaranteed)
  }
  clusters.sort((x, y) => (y.strength - x.strength) || (x.members.length - y.members.length) || (x.members[0] < y.members[0] ? -1 : 1));
  return clusters;
}

// ============================== promotableClusters ==============================
// PURE. The deterministic promotion GATE (memory-suite's local analogue of dinomem's 3-stage gate):
//   1. convergence — cluster size ≥ minSize (a pattern must span ≥N notes, not a lone pair)
//   2. durability  — every internal edge recurred ≥ minRecurrence rounds (survived across rebuilds)
//   3. strength    — aggregate neuralScore ≥ minStrength (the signal is strong, not marginal)
export function promotableClusters(clusters, graph, opts = {}) {
  const minSize = posInt(opts.minClusterSize, LEARN.MIN_CLUSTER_SIZE);
  const maxSize = posInt(opts.maxClusterSize, LEARN.MAX_CLUSTER_SIZE);
  const minDensity = num(opts.minDensity, LEARN.MIN_DENSITY);
  const minRec = posInt(opts.minEdgeRecurrence, LEARN.MIN_EDGE_RECURRENCE);
  const minStr = num(opts.minClusterStrength, LEARN.MIN_CLUSTER_STRENGTH);
  const out = [];
  for (const c of (Array.isArray(clusters) ? clusters : [])) {
    if (c.members.length < minSize || c.members.length > maxSize) continue; // convergence, bounded
    if (num(c.density, 0) < minDensity) continue;                            // dense, not a diffuse chain
    if (c.minRecurrence < minRec) continue;                                  // durability
    if (c.strength < minStr) continue;                                       // aggregate signal
    out.push({ members: c.members, strength: Number(c.strength.toFixed(4)), size: c.members.length, density: Number(num(c.density, 0).toFixed(3)), minRecurrence: c.minRecurrence, edges: c.edges });
  }
  return out;
}

// ============================== promoteInsights ==============================
// PURE. Merge promotable clusters into the persistent insight store, tracking each insight's OWN recurrence
// across learn-runs (an insight that keeps qualifying is reinforced; deduped by member overlap).
//   prevInsights : { insights: [ {id, members, strength, runs, firstMs, lastMs, status, text?} ] } | null
// Returns { insights:[...] } (new). status: "candidate" until runs ≥ 2, then "promoted".
export function promoteInsights(prevInsights, candidates, nowMs, opts = {}) {
  const J = num(opts.dedupJaccard, LEARN.INSIGHT_DEDUP_JACCARD);
  const prev = (prevInsights && Array.isArray(prevInsights.insights)) ? prevInsights.insights.map((x) => ({ ...x })) : [];
  const jacc = (a, b) => { const A = new Set(a), B = new Set(b); let inter = 0; for (const x of A) if (B.has(x)) inter++; const uni = A.size + B.size - inter; return uni ? inter / uni : 0; };

  const matchedPrev = new Set();
  for (const cand of (Array.isArray(candidates) ? candidates : [])) {
    let best = -1, bestJ = 0;
    for (let i = 0; i < prev.length; i++) { const j = jacc(cand.members, prev[i].members); if (j >= J && j > bestJ) { best = i; bestJ = j; } }
    if (best >= 0) {
      const p = prev[best]; matchedPrev.add(best);
      p.members = cand.members; p.strength = cand.strength; p.size = cand.size;
      if (cand.text != null) p.text = cand.text; // refresh the provider-free theme label
      p.runs = (p.runs || 1) + 1; p.lastMs = nowMs; p.status = p.runs >= 2 ? "promoted" : "candidate";
    } else {
      prev.push({ id: `ins-${(prev.length + 1)}-${cand.members[0]}`, members: cand.members, strength: cand.strength,
        size: cand.size, runs: 1, firstMs: nowMs, lastMs: nowMs, status: "candidate", text: cand.text != null ? cand.text : null, phrased: false });
    }
  }
  prev.sort((x, y) => (y.runs - x.runs) || (y.strength - x.strength));
  return { updatedMs: nowMs, insights: prev };
}

// ============================== detectContradictions ==============================
// PURE, provider-free (heuristic). Within an insight's member notes, flag opposing-polarity pairs:
// one note asserts a preference/rule and another negates it on the same object. This is a LEXICAL
// heuristic (a review signal), NOT a semantic judge — deep contradiction is left to the optional LLM pass.
//   textOf : (memberId) => string   (caller supplies note text; missing ⇒ "")
// Stem-matching (no trailing \b) so inflections match: "prefers", "avoids", "disliked", "chooses".
const NEG_RE = /\b(not|no|never|avoid|stop|dislike|hate|against|reject|drop|remove|don'?t|doesn'?t|shouldn'?t|won'?t)/i;
const POS_RE = /\b(prefer|like|love|always|want|keep|adopt|choose|favou?r|enable|should|must)/i;
const STOPWORDS = new Set(("your this that then before after with what where there here they them from into over under only also just does have been being will yours their about which while these those first last next each every some more most much many very than when work works note notes memory session agent agents task tasks time today active date tags status type null true false connection daily pattern").split(/\s+/));
export function detectContradictions(insight, textOf) {
  const ids = (insight && Array.isArray(insight.members)) ? insight.members : [];
  const get = typeof textOf === "function" ? textOf : () => "";
  // subject keywords: ≥4 chars AND not a generic stopword (so "your/this/first" never count as a shared subject).
  const kw = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)));
  const flags = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ti = get(ids[i]), tj = get(ids[j]);
      const iNeg = NEG_RE.test(ti), jNeg = NEG_RE.test(tj);
      const iPos = POS_RE.test(ti), jPos = POS_RE.test(tj);
      const opposed = (iNeg && jPos) || (iPos && jNeg);
      if (!opposed) continue;
      const shared = [...kw(ti)].filter((w) => kw(tj).has(w));       // must be talking about the same thing
      if (shared.length >= 2) flags.push({ a: ids[i], b: ids[j], shared: shared.slice(0, 5) });
    }
  }
  return flags;
}

// ============================== themeLabel ==============================
// PURE, provider-free. Derive a short human theme for a cluster from the words its member notes share
// most (stopword-filtered). This is memory-suite's LOCAL substitute for dinomem's LLM insight phrasing —
// no model, no tokens. An LLM (via connection-synthesis) can later replace it with a polished sentence.
export function themeLabel(memberIds, textOf, k = 3) {
  const ids = Array.isArray(memberIds) ? memberIds : [];
  const get = typeof textOf === "function" ? textOf : () => "";
  const df = new Map(); // document frequency of each token across member notes
  for (const id of ids) {
    const toks = new Set(String(get(id)).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)));
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const ranked = [...df.entries()].filter(([, c]) => c >= 2).sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1));
  const top = ranked.slice(0, k).map(([w]) => w);
  return top.length ? top.join(" · ") : null;
}

// ------------------------------------- CLI ---------------------------------------------------------
// node learn.mjs rebuild [--ws PATH]   read index.json vectors → build+reinforce graph → cluster → promote
// node learn.mjs list    [--ws PATH]   print promoted insights (+ candidates)
// node learn.mjs block   [--ws PATH]   emit the compact MEMORY.md insight block
// node learn.mjs sync    [--ws PATH]   rebuild + inject the block into MEMORY.md (managed markers) — every-turn behavior
// node learn.mjs phrase  [--ws PATH]   emit promoted clusters as material for an LLM to phrase (connection-synthesis)
// node learn.mjs flywheel[--ws PATH]   drive the full learn→phrase→act loop; tells the agent exactly what to do next
// node learn.mjs phrased <id> [--ws]   mark an insight as written-up so the flywheel stops re-surfacing it
// Reads vectors already in the index → rebuild/list/block/sync NEED NO EMBEDDING MODEL (run during a provider outage).
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } }
function writeJson(p, obj) { fs.mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 0)); }

// NOTE-LEVEL nodes: collapse each file's chunks to ONE mean-pooled vector. This makes a learned
// "pattern" span distinct NOTES (not just chunks of the same document — which would be a fake pattern),
// and shrinks the O(n²) link build from #chunks to #files (≈20× fewer on a real memory). The display
// text is the file's first chunk (usually its title/summary).
function meanPool(vectors) {
  const dim = vectors[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of vectors) { if (v.length !== dim) continue; for (let i = 0; i < dim; i++) acc[i] += v[i]; }
  let norm = 0; for (let i = 0; i < dim; i++) { acc[i] /= vectors.length; norm += acc[i] * acc[i]; }
  norm = Math.sqrt(norm) || 1; for (let i = 0; i < dim; i++) acc[i] /= norm; // re-normalize for cosine
  return acc;
}
function chunksFromIndex(index) {
  const out = []; const text = new Map();
  for (const [rel, entry] of Object.entries((index && index.files) || {})) {
    const meta = (entry && entry.meta) || {};
    const chunks = ((entry && entry.chunks) || []).filter((c) => Array.isArray(c.vector) && c.vector.length);
    if (!chunks.length) continue;
    const dim = chunks[0].vector.length;
    const vecs = chunks.filter((c) => c.vector.length === dim).map((c) => c.vector);
    if (!vecs.length) continue;
    const vector = vecs.length === 1 ? vecs[0] : meanPool(vecs);
    const first = chunks.slice().sort((x, y) => (x.startLine || 0) - (y.startLine || 0))[0];
    out.push({ id: rel, rel, path: rel, startLine: first.startLine || 1, vector, date: meta.date || "", type: meta.type || "note" });
    text.set(rel, String(first.text || ""));
  }
  return { chunks: out, text };
}

function paths(ws) {
  const base = `${ws}/memory/.semantic`;
  return { index: `${base}/index.json`, graph: `${base}/graph.json`, insights: `${base}/insights.json` };
}

function cmdRebuild(ws, nowMs) {
  const P = paths(ws);
  const index = readJson(P.index, null);
  if (!index) { process.stderr.write("# learn: no semantic index yet → nothing to learn\n"); return 0; }
  const { chunks, text } = chunksFromIndex(index);
  if (chunks.length < 2) { process.stderr.write("# learn: fewer than 2 indexed notes → nothing to link\n"); return 0; }
  const links = buildLinks(chunks, {});
  const graph = reinforceGraph(readJson(P.graph, null), links, nowMs);
  const clusters = clusterGraph(graph);
  const candidates = promotableClusters(clusters, graph).map((c) => ({ ...c, text: themeLabel(c.members, (id) => text.get(id) || "") }));
  const insights = promoteInsights(readJson(P.insights, null), candidates, nowMs);
  writeJson(P.graph, graph);
  writeJson(P.insights, insights);
  const promoted = insights.insights.filter((x) => x.status === "promoted").length;
  process.stdout.write(`🧠 learn: round ${graph.round} · ${Object.keys(graph.edges).length} edges · ${clusters.length} clusters · ${candidates.length} promotable · ${insights.insights.length} insights (${promoted} promoted)\n`);
  return 0;
}

function cmdList(ws) {
  const P = paths(ws); const store = readJson(P.insights, { insights: [] });
  const index = readJson(P.index, null); const text = index ? chunksFromIndex(index).text : new Map();
  if (!store.insights.length) { process.stdout.write("No insights learned yet — run: learn rebuild\n"); return 0; }
  for (const ins of store.insights) {
    process.stdout.write(`• [${ins.status}] runs×${ins.runs} · strength ${ins.strength} · ${ins.size} notes\n`);
    for (const m of ins.members.slice(0, 6)) { const t = (text.get(m) || "").replace(/\s+/g, " ").slice(0, 90); process.stdout.write(`    ${m}${t ? "  — " + t : ""}\n`); }
    const contra = detectContradictions(ins, (id) => text.get(id) || "");
    if (contra.length) process.stdout.write(`    ⚠️ ${contra.length} note-pair(s) may conflict — review (deep check = optional LLM pass)\n`);
    process.stdout.write("\n");
  }
  return 0;
}

function cmdBlock(ws) {
  const P = paths(ws); const store = readJson(P.insights, { insights: [] });
  const promoted = store.insights.filter((x) => x.status === "promoted");
  if (!promoted.length) return 0;
  process.stdout.write("## 🧠 Learned patterns (auto-promoted from your memory — provider-free)\n");
  for (const ins of promoted.slice(0, 12)) {
    const theme = ins.text ? `theme: ${ins.text}` : "a recurring theme";
    process.stdout.write(`- ${theme} — across ${ins.size} notes (${ins.members.slice(0, 2).join(", ")}${ins.size > 2 ? ", …" : ""})  _(seen ${ins.runs}× · strength ${ins.strength})_\n`);
  }
  return 0;
}

// sync: rebuild, then inject the promoted "Learned patterns" block into MEMORY.md between managed
// markers (idempotent — replaces the fenced region, appends it if absent). This is the behavioral-
// promotion step: MEMORY.md is injected every turn, so learned patterns start influencing behavior.
function cmdSync(ws, nowMs) {
  cmdRebuild(ws, nowMs);
  const BEGIN = "<!-- BEGIN:learned-patterns (managed by memory-suite mlearn — do not edit) -->";
  const END = "<!-- END:learned-patterns -->";
  let block = "";
  { const chunks = []; const orig = process.stdout.write.bind(process.stdout); process.stdout.write = (s) => { chunks.push(s); return true; }; try { cmdBlock(ws); } finally { process.stdout.write = orig; } block = chunks.join(""); }
  const mem = `${ws}/MEMORY.md`;
  let cur = ""; try { cur = fs.readFileSync(mem, "utf8"); } catch {}
  const managed = block.trim() ? `${BEGIN}\n${block.trim()}\n${END}` : `${BEGIN}\n${END}`;
  let next;
  if (cur.includes(BEGIN) && cur.includes(END)) {
    next = cur.replace(new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), managed);
  } else {
    next = (cur.trimEnd() ? cur.trimEnd() + "\n\n" : "") + managed + "\n";
  }
  try { fs.writeFileSync(mem, next); process.stdout.write(`🧠 learn: synced learned-patterns block → ${mem}\n`); } catch (e) { process.stderr.write(`# learn: could not write MEMORY.md: ${e}\n`); return 1; }
  return 0;
}

// phrase: emit each promoted insight's theme + member note snippets as material for an LLM (via the
// connection-synthesis skill) to turn into ONE polished sentence. Provider-free itself — it only
// PREPARES the material; the optional model step happens in the agent, not here.
function cmdPhrase(ws) {
  const P = paths(ws); const store = readJson(P.insights, { insights: [] });
  const index = readJson(P.index, null); const text = index ? chunksFromIndex(index).text : new Map();
  const promoted = store.insights.filter((x) => x.status === "promoted");
  if (!promoted.length) { process.stderr.write("# learn: no promoted insights to phrase yet\n"); return 0; }
  process.stdout.write("# Phrase these learned patterns into one sentence each (ground in the notes; say 'unclear' if forced):\n\n");
  for (const ins of promoted.slice(0, 12)) {
    process.stdout.write(`## theme: ${ins.text || "(unnamed)"}  (${ins.size} notes, seen ${ins.runs}×)\n`);
    for (const m of ins.members.slice(0, 8)) { const t = (text.get(m) || "").replace(/\s+/g, " ").slice(0, 120); process.stdout.write(`- ${m}${t ? ": " + t : ""}\n`); }
    process.stdout.write("\n");
  }
  return 0;
}

// ============================== THE FLYWHEEL ==============================
// flywheel: one command that drives the whole learn→phrase→store→act loop and tells the agent EXACTLY
// what to do next. It is the orchestration that makes the memory skills compound instead of sitting idle:
//   1. LEARN   — rebuild the graph + promote durable patterns (deterministic, no model).
//   2. PHRASE  — surface promoted insights NOT yet written up, with their source notes + a clear task.
//   3. (agent) — writes one grounded insight per cluster to memory/05-connections/ (connection-synthesis),
//                then calls `mlearn phrased <id>` to close it so it is never re-surfaced.
//   4. ACT     — points the agent at proactive-partner to turn fresh insights into proposed actions.
// The written connections become new notes → the NEXT rebuild learns from them too → the wheel turns.
function cmdFlywheel(ws, nowMs) {
  cmdRebuild(ws, nowMs);
  const P = paths(ws); const store = readJson(P.insights, { insights: [] });
  const index = readJson(P.index, null); const text = index ? chunksFromIndex(index).text : new Map();
  const promoted = store.insights.filter((x) => x.status === "promoted");
  const fresh = promoted.filter((x) => !x.phrased);
  process.stdout.write(`\n🎡 FLYWHEEL — ${promoted.length} durable pattern(s) learned, ${fresh.length} not yet written up.\n`);
  if (!fresh.length) {
    process.stdout.write("   Nothing new to phrase. Loop is caught up. (Run proactive-partner if you want fresh proposals.)\n");
    return 0;
  }
  process.stdout.write("\n## STEP 2 — PHRASE these into insights (write each to memory/05-connections/, then run `mlearn phrased <id>`):\n");
  for (const ins of fresh.slice(0, 8)) {
    process.stdout.write(`\n• id: ${ins.id}   theme: ${ins.text || "(unnamed)"}   (${ins.size} notes)\n`);
    for (const m of ins.members.slice(0, 6)) { const t = (text.get(m) || "").replace(/\s+/g, " ").slice(0, 100); process.stdout.write(`    - ${m}${t ? ": " + t : ""}\n`); }
  }
  process.stdout.write("\n   Rule (connection-synthesis): write ONE grounded sentence per cluster — the real link, cited by note.");
  process.stdout.write("\n   Say 'unclear' rather than force a pattern. Then: mlearn phrased <id>\n");
  process.stdout.write("\n## STEP 4 — ACT: after writing them, run proactive-partner to turn fresh insights into proposals.\n");
  return 0;
}

function cmdPhrased(ws, id) {
  const P = paths(ws); const store = readJson(P.insights, { insights: [] });
  const ins = store.insights.find((x) => x.id === id);
  if (!ins) { process.stderr.write(`# learn: no insight with id ${id}\n`); return 1; }
  ins.phrased = true; ins.phrasedMs = Number(process.env.LEARN_NOW_MS) || 0 || ins.lastMs;
  writeJson(P.insights, store);
  process.stdout.write(`✓ marked ${id} phrased — it won't resurface in the flywheel.\n`);
  return 0;
}

function parse(argv) { const o = { cmd: argv[0] || "rebuild", ws: null, id: null }; for (let i = 1; i < argv.length; i++) { if (argv[i] === "--ws") o.ws = argv[++i]; else if (!argv[i].startsWith("--") && o.cmd !== argv[i] && o.id == null) o.id = argv[i]; } return o; }

function main(argv) {
  const o = parse(argv);
  const ws = o.ws || process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;
  const nowMs = Number(process.env.LEARN_NOW_MS) || Date.now();
  if (o.cmd === "rebuild") return cmdRebuild(ws, nowMs);
  if (o.cmd === "list") return cmdList(ws);
  if (o.cmd === "block") return cmdBlock(ws);
  if (o.cmd === "sync") return cmdSync(ws, nowMs);
  if (o.cmd === "phrase") return cmdPhrase(ws);
  if (o.cmd === "flywheel") return cmdFlywheel(ws, nowMs);
  if (o.cmd === "phrased") { if (!o.id) { process.stderr.write("Usage: mlearn phrased <insight-id>\n"); return 2; } return cmdPhrased(ws, o.id); }
  process.stderr.write("Usage: node learn.mjs [rebuild|list|block|sync|phrase|flywheel|phrased <id>] [--ws PATH]\n"); return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exit(main(process.argv.slice(2)) || 0); } catch { process.exit(0); }
}
