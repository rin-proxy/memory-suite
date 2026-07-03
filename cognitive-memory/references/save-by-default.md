# Save-by-default — real-time high-signal capture (Layer 1)

The always-on **advisory protocol** the agent follows so that high-signal items — decisions, preferences,
milestones, corrections, an explicit "remember this" — reliably land in the **curated** memory store as they
happen, instead of only surviving as raw conversation the way `mdeep` recovers everything else.

**This is Layer 1: real-time, agent-driven, provider-free.**
- **Real-time** — captured the moment the item appears, mid-conversation.
- **Agent-driven** — *you*, the agent already in the session, decide something is worth keeping and call
  `scripts/save.sh`. There is **no cron, no heartbeat, and no LLM/provider call** doing this for you.
- **Provider-free** — the only "intelligence" is your own judgment plus a pure-code embedding dedup
  (`reconcile.mjs`). Nothing here phones a cloud model.

> **Honest scope.** Save-by-default is a *discipline backed by a tool*, not an autonomous daemon. If you
> don't call `save.sh`, nothing is captured by this layer. What makes it reliable is that the rule is
> always on and the tool is one command. The autonomous backstops are **deferred** (see *Layers* below).

## How it complements the transcript safety net

| | Curated memory (this: save-by-default) | Raw transcripts (`mdeep`) |
|---|---|---|
| Contains | The high-signal items you *judged* worth keeping | Everything that was ever said |
| Signal / noise | High signal, low noise | Total coverage, high noise |
| Recall | `msem` — fast, clean, first-choice | `mdeep` — deep, escalate when `msem` misses |
| Failure mode | Misses what the agent forgets to save | Buries a key fact in thousands of lines |

They cover each other's gaps: transcripts guarantee *nothing said is lost*; save-by-default guarantees the
*load-bearing* items are also promoted into clean, curated, fast-to-recall memory. Save-by-default is the
front line; `mdeep` is the net underneath it.

## WHAT to capture (save it)

Capture anything the user would be annoyed to have to repeat, or that changes how you should act later:

- **Decisions** — a choice was made ("we're going with Postgres", "ship the redesign this week"). `--type decision`
- **Preferences / personal info** — how the user wants things, who they are, standing constraints
  ("reply in Indonesian", "no emojis in UI", timezone, handles, accounts). `--type preference`
- **Milestones** — something shipped, launched, closed, achieved. `--type milestone`
- **Corrections** — a previously-held fact was wrong and is now fixed ("actually it's async replication, not
  logical"). `--type correction` — reconcile will usually flag this `review` against the note it supersedes,
  which is exactly what you want (resolve the conflict).
- **Explicit asks** — "remember this", "save that", "note that", "for future reference", "don't forget".
  Always honor these; when unsure of the kind, omit `--type` (routes to episodic).
- **Durable facts** — a piece of knowledge worth keeping ("the API rate limit is 100/min"). `--type fact`
- **Anything else worth keeping.** When in doubt, **save it** — reconcile drops the true duplicates, so the
  cost of an unnecessary save is near-zero, while the cost of a lost decision is high.

**Do NOT bother saving:** transient chit-chat, things already in core memory (MEMORY.md), or content you're
about to store through a more specific path (`smart-distill` for long-form, the reflection flow for
self-insight). Save-by-default is for the short, high-signal item that would otherwise slip away.

## WHEN — save first, respond second

Capture **immediately**, the moment the item lands — do not wait for the end of the turn (the turn may end
in a compaction or a crash before you get there). The habit is literally: *notice → `save.sh` → then answer
the user.* A one-line save costs you nothing and removes the "I'll write it down later" failure mode.

## HOW — one command, it dedups for you

```bash
scripts/save.sh --text '<the item, in the user’s own words where possible>' \
                [--type decision|preference|fact|correction|milestone] \
                [--tags a,b] [--ws "$OPENCLAW_WORKSPACE"]
```

`save.sh` writes a curated markdown note (YAML frontmatter: `type`, `date`, `tags`, `source: save-by-default`)
into the right numbered store, **after** running the shared write-time reconcile so you never pile up
duplicates:

| type | store | why |
|---|---|---|
| `preference` | `memory/00-core` | never-decay — a preference should be honored forever |
| `decision`, `milestone` | `memory/01-episodic` | it happened at a time / with people |
| `fact`, `correction` | `memory/02-semantic` | durable knowledge (a correction revises it) |
| *(no `--type`)* | `memory/01-episodic` | timestamped general capture |

**Reconcile outcomes** (pure-code cosine pre-filter over the already-indexed memory — see
`references/operations.md`):

- **skip** (cosine ≥ `RECONCILE_HIGH`, 0.95) — near-identical to an existing note → **not written**, just
  logged. The dedup you'd otherwise do by hand.
- **review** (0.85–0.95) — similar/ambiguous → written **with a `reconcile: review` flag**. Later, *you*
  judge it *duplicate / update / contradiction / distinct* (no external model is consulted — the running
  agent is the judge). Resolve flagged notes when you next touch memory.
- **new / unavailable** — genuinely new, or the semantic stack/model/index isn't present → **written
  normally.**

**It never blocks.** A missing node / semantic stack / model / index is treated as `new` and the item is
still saved. Reconcile can drop a confident duplicate or flag a review — it can never lose a memory you meant
to keep. Opt out per-call with `--no-reconcile`.

Saved notes become recallable via `msem "<query>"` after the next semantic reindex (the 15-min cron), and via
`mdeep` immediately as part of total recall.

## Layers — what's here vs deferred

Save-by-default is **Layer 1** of a three-layer capture design absorbed from anti-amnesia. Only Layer 1 ships
here; the rest are **future/optional** and are *not* implied by this doc:

1. **Layer 1 — real-time save-by-default (this).** Agent notices a high-signal item and calls `save.sh`
   mid-conversation. Provider-free, agent-driven, always on.
2. **Layer 2 — compaction / lifecycle hooks (deferred).** Flush pending high-signal items to curated memory
   automatically at context-compaction / session-end boundaries, so nothing is lost when the window rolls.
   Not implemented here.
3. **Layer 3 — autonomous heartbeat / nightly sweep (deferred).** A scheduled pass that re-reads recent
   activity and back-fills anything Layer 1 missed. This is the only genuinely *autonomous* layer, and it is
   **not** part of this delivery.

Until Layers 2–3 exist, reliability rests on (a) the always-on Layer 1 habit above and (b) `mdeep`'s
raw-transcript net as the backstop.
