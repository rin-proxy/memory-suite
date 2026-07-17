# The Memory Flywheel — how the agent gets sharper on its own

This is the loop that turns memory-suite's separate parts into ONE compounding system. Each turn of
the wheel makes the agent a little smarter, and the output of each turn becomes the input of the next.

```
        ┌─────────────────────────────────────────────────────────┐
        ▼                                                         │
   1. LEARN            2. PHRASE            3. STORE          4. ACT
   mlearn rebuild  →   agent writes    →   memory/05-      →  proactive-
   (graph +           one grounded         connections/       partner
   recurrence →       insight per          (indexed →         proposes an
   promoted           durable cluster       becomes new        action from
   patterns)          (connection-          memory)            the fresh
        ▲             synthesis)                 │             insight
        └─────────────────────────────────────────┘
         the new connection notes are learned from NEXT round
```

## Why it works
- **1 LEARN is deterministic and free** (`mlearn rebuild` reads vectors already in the index — no model,
  no tokens, runs even when the provider is down). It finds patterns that keep *recurring* across notes.
- **2 PHRASE is the only step that needs judgment.** The agent turns a promoted cluster into ONE real
  sentence — the actual link between the notes — grounded in them (`connection-synthesis` rules).
- **3 STORE** writes that sentence to `memory/05-connections/`. Because it's a note, it gets indexed and
  becomes memory the agent can recall — and that the NEXT `mlearn rebuild` learns from.
- **4 ACT** lets `proactive-partner` read the fresh insight and propose something concrete to do.

The compounding: today's phrased insight is tomorrow's learned input. Patterns build on patterns.

## How the agent runs it (clear procedure)

```bash
mlearn flywheel          # 1 LEARN (auto) + 2 shows exactly which patterns to phrase, with their notes
```
Then, for each insight it prints:
1. Read the member notes it lists.
2. Write **one grounded sentence** — the genuine connection between them — to
   `memory/05-connections/YYYY-MM-DD-connection-<slug>.md` (follow `connection-synthesis`'s format).
   If the notes don't really connect, say **"unclear"** and skip — never invent a pattern.
3. Close it so it never resurfaces:
   ```bash
   mlearn phrased <id>
   ```
4. When done phrasing, run **proactive-partner** — it now sees the new insights and can propose actions.

## The one rule
**Honesty over volume.** A cluster is a statistical hint, not a truth. The agent's job in step 2 is to
find the *real* link or say there isn't one. A wrong "insight" written to memory poisons every future
turn of the wheel; an honest "unclear" costs nothing. Ground every sentence in the cited notes.

## Cadence
`mlearn rebuild`/`sync` already runs daily on cron (keeps the graph + MEMORY.md block fresh with zero
tokens). Run `mlearn flywheel` when you want to actually *close the loop* — turn what was learned into
written insights and actions. Daily or weekly is plenty; the wheel rewards patience, not speed.
