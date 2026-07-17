// test-learn.mjs — unit tests for the PURE provider-free learning layer (learn.mjs).
// Pure Node, no framework, NO network, NO embedding model. Synthetic graphs/links/timestamps give exact,
// controllable recurrence and strength. Covers: reinforceGraph (recurrence increments, weight EMA, age
// decay, prune of stale edges, neuralScore composite), clusterGraph (connected components over strong
// edges), promotableClusters (the 3-gate: size · recurrence · strength), promoteInsights (jaccard dedup,
// runs increment, candidate→promoted), detectContradictions (opposing polarity + shared subject).
// Exits non-zero on any failure.
import assert from "node:assert/strict";
import {
  reinforceGraph, clusterGraph, promotableClusters, promoteInsights, detectContradictions, themeLabel, LEARN,
} from "./learn.mjs";

let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  approx: (x, y, tol, m) => { assertCount++; assert.ok(Math.abs(x - y) <= (tol ?? 1e-9), `${m || ""} (|${x}-${y}| > ${tol ?? 1e-9})`); },
};
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); } }

const link = (x, y, w, sig = ["semantic"]) => ({ a: x, b: y, weight: w, signals: sig });
const NOW = 1_700_000_000_000;

// ---------- reinforceGraph ----------
test("round increments from null and edges get recurrence=1", () => {
  const g = reinforceGraph(null, [link("x", "y", 0.8)], NOW);
  a.equal(g.round, 1);
  const e = g.edges["x|y"];
  a.ok(e, "edge x y exists");
  a.equal(e.recurrence, 1);
  a.approx(e.weightEMA, 0.8, 1e-9);
  a.ok(e.neuralScore > 0.8, "neuralScore lifted by recurrence factor");
});

test("re-seeing an edge increments recurrence and raises neuralScore", () => {
  let g = reinforceGraph(null, [link("x", "y", 0.8)], NOW);
  const first = g.edges["x|y"].neuralScore;
  g = reinforceGraph(g, [link("x", "y", 0.8)], NOW);
  a.equal(g.round, 2);
  a.equal(g.edges["x|y"].recurrence, 2);
  a.ok(g.edges["x|y"].neuralScore > first, "more recurrence ⇒ stronger");
});

test("weightEMA smooths a noisy weight (0.5 alpha default)", () => {
  let g = reinforceGraph(null, [link("x", "y", 1.0)], NOW);
  g = reinforceGraph(g, [link("x", "y", 0.0)], NOW);   // noisy drop
  a.approx(g.edges["x|y"].weightEMA, 0.5, 1e-9);        // 0.5*0 + 0.5*1.0
});

test("an unseen edge ages (neuralScore decays) then is pruned past EDGE_DROP_ROUNDS", () => {
  let g = reinforceGraph(null, [link("x", "y", 0.9)], NOW);
  const s0 = g.edges["x|y"].neuralScore;
  g = reinforceGraph(g, [], NOW);                       // round 2, edge not seen
  a.ok(g.edges["x|y"], "still present after 1 missed round");
  a.ok(g.edges["x|y"].neuralScore < s0, "aged ⇒ decayed");
  for (let i = 0; i < LEARN.EDGE_DROP_ROUNDS + 1; i++) g = reinforceGraph(g, [], NOW);
  a.ok(!g.edges["x|y"], "pruned after EDGE_DROP_ROUNDS missed rounds");
});

test("reinforceGraph does not mutate prev", () => {
  const g1 = reinforceGraph(null, [link("x", "y", 0.8)], NOW);
  const snap = JSON.stringify(g1);
  reinforceGraph(g1, [link("x", "y", 0.8)], NOW);
  a.equal(JSON.stringify(g1), snap, "prev graph unchanged");
});

// helper: build a graph where a set of edges have a given recurrence + weight, over N rounds.
function graphWith(edges, rounds) {
  let g = null;
  for (let r = 0; r < rounds; r++) g = reinforceGraph(g, edges.map((e) => link(e[0], e[1], e[2])), NOW);
  return g;
}

// ---------- clusterGraph ----------
test("connected components: two separate clusters", () => {
  const g = graphWith([["a", "b", 0.9], ["b", "c", 0.9], ["d", "e", 0.9]], 3);
  const cs = clusterGraph(g);
  a.equal(cs.length, 2, "two components");
  const sizes = cs.map((c) => c.members.length).sort();
  a.equal(sizes.join(","), "2,3", "sizes {a,b,c}=3 and {d,e}=2");
});

test("weak edges (below floor) are excluded from clustering", () => {
  const g = graphWith([["a", "b", 0.05]], 1);           // tiny weight ⇒ neuralScore below floor
  a.equal(clusterGraph(g).length, 0, "no clusters from sub-floor edges");
});

test("a long chain does NOT collapse into one giant cluster (the blob bug)", () => {
  // 10-node chain a-b-c-…-j. Naive connected-components ⇒ ONE 10-node blob. Dense extraction must
  // break it into small bounded clusters (a real learned pattern is a handful of notes, not the memory).
  const ids = "abcdefghij".split("");
  const chain = ids.slice(1).map((n, i) => [ids[i], n, 0.9]);
  const g = graphWith(chain, 3);
  const cs = clusterGraph(g);
  a.ok(cs.every((c) => c.members.length <= LEARN.MAX_CLUSTER_SIZE), "every cluster within max size");
  a.ok(!cs.some((c) => c.members.length >= 8), "no near-whole-graph blob cluster");
  a.ok(cs.length >= 2, "the chain is split into multiple small clusters");
});

test("a dense clique promotes; a sparse diffuse group does not", () => {
  const clique = [["p", "q", 0.9], ["p", "r", 0.9], ["p", "s", 0.9], ["q", "r", 0.9], ["q", "s", 0.9], ["r", "s", 0.9]];
  const g = graphWith(clique, 3);                         // 4-node clique, density 1.0
  const prom = promotableClusters(clusterGraph(g), g);
  a.ok(prom.some((c) => c.size === 4 && c.density >= 0.9), "the dense 4-clique promotes");
});

// ---------- promotableClusters (the 3-gate) ----------
test("gate passes only with size≥3, recurrence≥3, strength≥threshold", () => {
  const g = graphWith([["a", "b", 0.9], ["b", "c", 0.9]], 3); // triangleless chain, 3 rounds ⇒ rec=3
  const cs = clusterGraph(g);
  const prom = promotableClusters(cs, g);
  a.equal(prom.length, 1, "the {a,b,c} cluster promotes");
  a.equal(prom[0].size, 3);
  a.ok(prom[0].minRecurrence >= 3, "durability gate");
  a.ok(prom[0].strength >= LEARN.MIN_CLUSTER_STRENGTH, "strength gate");
});

test("gate rejects a too-small cluster", () => {
  const g = graphWith([["a", "b", 0.95]], 5);           // only 2 members
  a.equal(promotableClusters(clusterGraph(g), g).length, 0, "size gate blocks a pair");
});

test("gate rejects an insufficiently-recurring cluster", () => {
  const g = graphWith([["a", "b", 0.9], ["b", "c", 0.9]], 1); // 3 members but recurrence 1
  a.equal(promotableClusters(clusterGraph(g), g).length, 0, "recurrence gate blocks a one-round cluster");
});

// ---------- promoteInsights ----------
test("first qualification = candidate; second = promoted (jaccard dedup)", () => {
  const cand = [{ members: ["a", "b", "c"], strength: 1.2, size: 3 }];
  let store = promoteInsights(null, cand, NOW);
  a.equal(store.insights.length, 1);
  a.equal(store.insights[0].runs, 1);
  a.equal(store.insights[0].status, "candidate");
  store = promoteInsights(store, cand, NOW);            // same cluster again
  a.equal(store.insights.length, 1, "deduped, not duplicated");
  a.equal(store.insights[0].runs, 2);
  a.equal(store.insights[0].status, "promoted");
});

test("a distinct cluster becomes a separate insight", () => {
  let store = promoteInsights(null, [{ members: ["a", "b", "c"], strength: 1.2, size: 3 }], NOW);
  store = promoteInsights(store, [{ members: ["x", "y", "z"], strength: 1.1, size: 3 }], NOW);
  a.equal(store.insights.length, 2, "two distinct insights");
});

test("overlapping members (≥ jaccard) merge into the same insight", () => {
  let store = promoteInsights(null, [{ members: ["a", "b", "c"], strength: 1.2, size: 3 }], NOW);
  // {a,b,c,d} vs {a,b,c}: jaccard = 3/4 = 0.75 ≥ 0.6 ⇒ merge
  store = promoteInsights(store, [{ members: ["a", "b", "c", "d"], strength: 1.3, size: 4 }], NOW);
  a.equal(store.insights.length, 1, "merged");
  a.equal(store.insights[0].runs, 2);
  a.equal(store.insights[0].size, 4, "updated to the newer cluster");
});

// ---------- detectContradictions ----------
test("opposing polarity on the same subject is flagged", () => {
  const ins = { members: ["m1", "m2"] };
  const textOf = (id) => ({
    m1: "user prefers concentrated portfolio positions",
    m2: "user should avoid concentrated portfolio positions",
  }[id] || "");
  const flags = detectContradictions(ins, textOf);
  a.equal(flags.length, 1, "one contradiction flagged");
  a.ok(flags[0].shared.length >= 2, "shared subject keywords present");
});

test("same-polarity notes are NOT flagged", () => {
  const ins = { members: ["m1", "m2"] };
  const textOf = (id) => ({ m1: "user prefers concentrated positions", m2: "user likes concentrated positions" }[id] || "");
  a.equal(detectContradictions(ins, textOf).length, 0, "no false contradiction on agreement");
});

test("opposing polarity but DIFFERENT subjects is not flagged", () => {
  const ins = { members: ["m1", "m2"] };
  const textOf = (id) => ({ m1: "user prefers dark chocolate desserts", m2: "user should avoid morning cardio workouts" }[id] || "");
  a.equal(detectContradictions(ins, textOf).length, 0, "needs shared subject, not just opposite polarity");
});

// ---------- themeLabel ----------
test("themeLabel surfaces the shared subject words, filters stopwords", () => {
  const textOf = (id) => ({
    n1: "autonomy and silence build trust over the sprint",
    n2: "silence signals trust; autonomy compounds",
    n3: "the autonomy pattern: trust through silence",
  }[id] || "");
  const label = themeLabel(["n1", "n2", "n3"], textOf, 3);
  a.ok(/autonomy/.test(label) && /silence/.test(label) && /trust/.test(label), "top shared subjects present");
  a.ok(!/pattern|this|that|over/.test(label), "stopwords/singletons excluded");
});

test("themeLabel returns null when nothing is shared", () => {
  const textOf = (id) => ({ n1: "apples oranges bananas", n2: "quantum reactor coolant" }[id] || "");
  a.equal(themeLabel(["n1", "n2"], textOf), null, "no shared ≥2 subject ⇒ null");
});

// ---------- summary ----------
console.log(`\nlearn.mjs — ${passed} passed, ${failed} failed (${assertCount} assertions)`);
process.exit(failed ? 1 : 0);
