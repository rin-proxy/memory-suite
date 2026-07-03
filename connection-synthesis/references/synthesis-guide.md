# Synthesis Guide

The method behind `connection-synthesis` — loaded on demand. The skill body covers the flow; this is
the *how* and *why* in full.

## Capture by TYPE, not just topic (the precondition)

If notes are filed only by **topic**, related ideas from different domains never meet — a market
pattern and a behavioral pattern sit in separate folders and are read separately, so the link is
invisible. Also capture by **type** — `patterns`, `questions`, `numbers`, `principles` — and those two
patterns land in the *same* conceptual place. Now a semantic engine can bridge them automatically.
That is the unlock: **type-based capture + semantic search = surfaced connections.**

## Pull candidates across domains (the engine)

You don't hunt connections by hand. `find-connections.sh` builds a provider-free **link layer**
(`links.mjs`) over memory and selects candidates by **MMR diversity**:

```bash
./scripts/find-connections.sh "<a theme from this week>" 12
```

**What the link layer is (A-MEM-style — no LLM, no cloud, no network).** `links.mjs` links memory
chunks from pure-code signals over the existing index vectors:

- **Semantic similarity** in the *related-but-distinct* band — cosine ≥ a floor (**0.35**; below =
  unrelated) but *below* a near-duplicate ceiling (**0.85**; at/above = a near-copy, i.e. redundancy,
  not a connection — that's the write-time reconciler's job, so it is excluded here).
- **Temporal proximity** — written within **~14 days** of each other (from each note's `date`).
- **Shared named entities** — *optional*. The running agent may attach `entities` to chunks; base
  auto-linking runs on **similarity + temporal alone** and needs nothing from a model.

**Why MMR, not top-k.** Plain top-k similarity just returns the nearest copies of the seed —
restatements, not insight. Candidates are instead ranked by **MMR**:
`score = relevance(seed) − λ·redundancy`, with **λ = 0.5** and *redundancy* = the highest cosine to an
already-picked candidate. That penalty deliberately promotes memories that are relevant to the seed yet
*dissimilar to each other* — the cross-domain raw material. Matching by *meaning* (and across
languages) then puts far-apart notes side by side. **`type` is only a display label — it never gates a
candidate** (the old "same `type` ⇒ same domain, demote" heuristic contradicted this skill's own thesis
and is gone: two `type:pattern` notes bridging market + behavior now surface together).

If Node or the local embedding model isn't present, `find-connections.sh` degrades gracefully to a plain
most-related listing from `msem` — you just judge cross-domain-ness by hand.

## What makes a REAL insight (the four types)

Only these count as a *strong* connection. Everything else is restatement — skip it.

| Type | What it is |
|---|---|
| **A · Principle** | The same underlying principle showing up in two different domains. |
| **B · Contradiction** | Two notes in genuine tension — interesting, not trivial. |
| **C · Pattern** | 3+ notes that together form one unnamed insight. |
| **D · Answered question** | A question in one note that another note accidentally answers. |

**Real insight vs restatement:** a restatement says what a note *already says* ("both notes discuss
X"). A real connection says something **neither note says alone** — the principle they share, the
tension between them, the pattern they jointly reveal, the answer one gives the other. If reading the
bridge sentence wouldn't *surprise* you, it isn't a connection. **Min 3, max 5. Quality over quantity.**

## Where insights are stored (the connections store)

Keep synthesized insight in its **own** store, separate from raw captures:

```
memory/05-connections/        # emergent insights linking 2+ notes — NOT raw notes
```

Why separate: captures are *inputs*; connections are *derived output*. Mixing them buries your best
thinking in the noise. This folder is where original work accumulates — and it **compounds**: month-3
connections start linking back to month-1 notes you'd forgotten.

### The connection note (format)

```
filename: YYYY-MM-DD-connection-<slug>.md
---
type: connection
status: active
date: YYYY-MM-DD
tags: [domain1, domain2]
---
**Type:** principle | contradiction | pattern | answered-question
**Bridge:** one sentence linking the ideas.
**Sources:** [[note-a]] [[note-b]]      (real notes — quote the actual passages)
**Why it matters:** the implication / what it changes.
```

Cite real notes and quote the actual passages — never invent a link. If a cited note was deleted, find
a replacement or drop the connection. If the same connection already exists in the store, extend it
rather than duplicate.

## Cadence

- **Weekly** (e.g. Sunday) — read the week's captures, pull breadth with `msem`, find the four types,
  write each strong link to `05-connections/`. A full week of input yields stronger links than any
  single day. Pairs naturally with a weekly reflection pass.
- **Daily (lightweight)** — a quick "what connects to the last 24h?" thinking brief, read before
  opening anything else. Distinct from a task briefing — this one is about *ideas*, not to-dos.
- **Deep-dive (on demand)** — for one topic: what you already believe (from your notes), what
  contradicts it, what's missing, and the one question you haven't asked. Grounded only in your own
  notes — it challenges you, it doesn't summarize.

## Close the loop (why it compounds)

When a connection proves out — a pattern holds, a thesis plays — go back and add what happened. Over
time the store learns not just *what* you think, but *which kinds of thinking have been right* for you.
That is the difference between a notebook and a mind.

---
*The best thinking lives between the notes.*
