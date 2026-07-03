---
name: connection-synthesis
description: Turn a pile of stored notes into original insight by surfacing cross-domain links a human (or keyword search) would never put side by side, then synthesizing the real ones into a written insight. Use when you want to find connections across your notes, synthesize insights from memory, ask what links these notes, or run a weekly connection pass — the best thinking lives between the notes, not inside any one of them.
version: 1.0.0
author: Rin
license: UNLICENSED
lastUpdated: 2026-06-17
metadata:
  openclaw:
    emoji: "🔗"
    requires:
      bins: ["bash", "node"]
      stack: "semantic search + link layer (scripts/semantic/{msem,links.mjs})"
triggers:
  - "find connections"
  - "synthesize insights"
  - "what links these notes"
  - "connection synthesis"
  - "weekly connections"
  - "find this week's connections"
---

# 🔗 Connection Synthesis

Storage ≠ insight. An agent can store hundreds of notes, recall any one — and still never have an
original thought. **The best ideas don't live inside any single note; they live in the relationships
between them.** Recall finds what you ask for. Synthesis finds what you didn't know to ask.

## 🔗 The flow

1. **Seed** — a note, theme, or this week's captures. The thing you want to think *outward* from.
2. **Pull across domains** — `find-connections.sh` builds a provider-free **link layer** (`links.mjs`)
   over memory and ranks with **MMR diversity** (relevance − λ·redundancy) to surface memories that are
   *relevant to the seed yet dissimilar to each other* — the cross-domain material, not near-duplicates.
   Matching by *meaning* (across languages) puts far-apart notes side by side — the whole point.
3. **Synthesize** (your job) — judge which candidate links are *real*: one of the four strong types
   (principle · contradiction · pattern · answered-question). Restating a note is not a connection.
4. **Store the insight** — write each real one to the connections store
   `memory/05-connections/YYYY-MM-DD-connection-<slug>.md`: a one-sentence bridge, the `[[real
   source notes]]`, and why it matters. This store is *derived output*, kept apart from raw captures
   so your best thinking isn't buried in the noise — and it compounds month over month.

## 🚀 Quick Start

```bash
# Surface candidate cross-domain connections for a seed note/topic:
./scripts/find-connections.sh "<seed note or theme>" 12
# → prints cross-domain candidate clusters + a synthesis prompt.
# Then YOU write the real insights to memory/05-connections/ (the tool surfaces; you synthesize).
```

## 💡 Why insight lives BETWEEN notes

If you file by **topic**, related ideas from different domains never meet. Capture by **type** as well
(`patterns`, `questions`, `numbers`) and a market pattern and a behavioral pattern land in the same
place — then the link layer bridges them by *meaning*, not by folder. Two notes that quietly contradict
each other, a March question a May note accidentally answers — that tension is where rethinking happens,
and nobody was looking across both.

**How the bridge is built (provider-free, no LLM).** `links.mjs` links memory chunks from pure-code
signals: **semantic similarity** in the related-but-distinct band (above a floor, *below* near-duplicate —
a near-copy is redundancy, not a connection), and **temporal proximity** (written close in time). Shared
**named entities** are an *optional* extra the running agent can supply; base auto-linking works without
them. Then **MMR** (relevance − λ·redundancy) deliberately picks memories relevant to the seed yet
*dissimilar* to each other — which is what makes them cross-domain. Two `type:pattern` notes bridging
market and behavior now surface *together* (the old "same type ⇒ same domain, demote" heuristic is gone).

## ✅ When to use

- **Weekly** — read the week's captures, run a pass, write the strong links (pairs with reflection).
- **Ad-hoc** — whenever a cross-note link nags at you while working; seed it and check.
- **Deep-dive** — point it at one topic to find what you already believe, what contradicts it, and the
  one question you haven't asked — grounded only in your own notes.
- **Not for** — single-note summary or raw capture; those are recall/distill, not synthesis.

→ Method, the four connection types, what makes a real insight vs a restatement, store layout &
cadence: [`references/synthesis-guide.md`](references/synthesis-guide.md)

---
*Derived from the `connection-synthesis` Runbook book. By Rin 🔗*
