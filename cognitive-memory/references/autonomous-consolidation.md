# Autonomous consolidation — the maintenance loop (Layer 3)

The scheduled, mostly-hands-off pass that keeps the memory store tidy **without the human in the loop** —
incremental reindex, dedup flags, decay-prune, resurfacing, and a consolidation hand-off. It is the third
layer of the capture/maintenance design:

1. **Layer 1 — save-by-default** (`references/save-by-default.md`): the running agent writes high-signal items
   in real time. Provider-free, agent-driven.
2. **Layer 2 — compaction / lifecycle hooks**: flush pending items to curated memory at
   context-compaction / session-end boundaries (owned by the compaction hooks).
3. **Layer 3 — autonomous maintenance (this doc)**: a light **heartbeat** (~every 30 min) plus a **nightly
   consolidate**. This is the only genuinely *scheduled* layer.

> ### Honest scope — no fake autonomous "mind"
> The **deterministic** parts are pure code (no LLM, no cloud, no provider): incremental reindex, cross-file
> dedup detection, decay-prune-to-archive, resurfacing stale-but-important, and preparing a consolidation
> queue. The **judgment** — *actually* merging duplicates, resolving conflicts, summarizing, reflecting —
> needs a model, so it is **pluggable and opt-in** (`MEMORY_LLM_CMD`). With no model configured, Layer 3
> runs every deterministic pass and then **leaves a queue** for the running agent to process. There is no
> standing daemon that "thinks" on its own, and **nothing is ever hard-deleted** (prune = a reversible move
> to an archive). Autonomous-cron mode is itself **opt-in** (`install.sh --with-cron`).

---

## The two scripts

| Script | Cadence | Weight | What it does |
|---|---|---|---|
| `scripts/heartbeat.sh` | ~every 30 min | light, best-effort | incremental reindex · ensure/clean the decay store · flag recent un-curated activity into today's queue |
| `scripts/consolidate.sh` | nightly (local TZ) | heavier | the deterministic consolidation passes + the pluggable/opt-in LLM judgment step (or the queue fallback) |

Both are **bash-3.2-safe**, **guarded**, and **best-effort**: a missing `node` / semantic stack / embedding
model degrades gracefully (the passes that need them are skipped; the queue is still produced). Neither ever
blocks, and neither ever deletes a memory.

---

## Heartbeat — the light periodic sweep (`heartbeat.sh`)

Three deterministic, provider-free passes:

1. **Incremental reindex** — `index.mjs --incremental` re-embeds only *changed* curated files, so `msem` /
   `mdeep` recall reflects recent saves without waiting for the daily reindex cron. Skipped cleanly if the
   model / `node_modules` isn't installed, or another index build holds the lock.
2. **Decay refresh** — ensure `memory/.semantic/decay-scores.json` exists and is valid (create an empty store
   if missing; never clobber a good one), and drop score entries whose file is gone. Also strips index entries
   under the working areas (`.archive/`, `.consolidation/`) or pointing at now-missing files, so archived /
   queued notes stay out of active recall.
3. **Flag recent un-curated activity** — append pointers to `memory/.consolidation/queue-<date>.md`: notes
   still carrying a write-time `reconcile: review` flag (need a verdict) and capture surfaces touched within
   the window (episodic notes, `active-tasks.md` / `last-conversation.md` / `learnings.md`). De-duplicated so
   repeated heartbeats don't spam the queue. This **leaves work**; it does not judge or rewrite memory.

```bash
scripts/heartbeat.sh [--ws PATH] [--window-min N]   # N = "recent" window (default 60; env HEARTBEAT_WINDOW_MIN)
```

---

## Nightly consolidate — deterministic passes + the pluggable step (`consolidate.sh`)

### Deterministic passes (always run · provider-free · reuse the shared semantic stack)

| Pass | Reuses | What it does | Destructive? |
|---|---|---|---|
| **A. dedup sweep** | `reconcile.mjs` thresholds (`RECONCILE.HIGH/MID`) + `store.mjs` `cosine` | cross-**file** near-duplicate detector over the index's file-lead vectors; **flags** DUP (≥HIGH) / SIM ([MID,HIGH)) pairs | no — flags only; merging is judgment |
| **B. decay-prune** | `decay.mjs` `decayFactor` | move entries whose decay factor has sunk to ~the floor (0.30) into `memory/.archive/` | **no — a reversible move, audited, never a delete** |
| **C. surface** | `surface.mjs` | resurface stale-but-important memories (importance × staleness × neglect) | no |
| **D. review scan** | `grep` | collect notes still carrying a `reconcile: review` flag | no |
| **E. reindex + strip** | `index.mjs --incremental` | refresh the index after the moves, then strip archived / queued / orphaned keys so they leave active recall | no |

**Decay-prune is conservative by design.** A note is archived only when *all* hold: its decay factor is at/near
the floor **and** it's been unseen for ≥ `CONSOLIDATE_PRUNE_AGE_DAYS` (default 90) **and** its importance is
below `CONSOLIDATE_PRUNE_IMPORTANCE` (default 0.6) **and** it is not in `00-core` (never-decay). At most
`CONSOLIDATE_MAX_PRUNE` (default 50) are moved per run. Each move is written to `memory/04-meta/audit.log`
(`ARCHIVE`) and to `memory/.archive/manifest.tsv` (original path → archive path + why), so it is auditable and
**restorable** — move the file back out of `memory/.archive/` to un-archive it.

### The pluggable, opt-in LLM step (the judgment)

The candidates from A–D are formatted into a single **consolidation brief**, then:

| `MEMORY_LLM_CMD` | Behavior |
|---|---|
| **set** | the brief is piped to that command (any local LLM / OpenClaw model-run); its output is **appended** as a dated record under `memory/04-meta/consolidations/consolidation-<date>.md` — a reviewable **proposal/summary**, not a silent destructive rewrite of your notes. If the command fails or returns nothing, it **falls back to the queue** (the work is never lost). |
| **unset** (default) | the same brief is written to `memory/.consolidation/queue-<date>.md` for the **running agent** to process later. |

`MEMORY_LLM_CMD` is a shell command the script **pipes the prompt to on stdin**. Examples:

```bash
# any local model that reads a prompt on stdin and writes the answer to stdout
export MEMORY_LLM_CMD='ollama run llama3.2'
export MEMORY_LLM_CMD='llama-cli -m /models/qwen.gguf -p "$(cat)" --no-display-prompt'
export MEMORY_LLM_CMD='openclaw model run --model local-consolidator'   # or any OpenClaw model-run
```

Even with the LLM step enabled, structural changes (actual merges, restores, edits) are left to the agent /
human reviewing the record — Layer 3 produces the **brief and the record**, it does not mutate curated notes
behind your back.

```bash
scripts/consolidate.sh [--ws PATH] [--top N] [--dry-run]
#   --top N    how many stale-but-important items to surface (default 8)
#   --dry-run  compute + report + write the queue, but do NOT move anything into the archive
```

---

## Enabling the crons

Nothing is scheduled unless you ask. Install the loop with:

```bash
./install.sh --with-cron            # (plus your usual target/workspace flags)
```

That installs two independently-tagged, idempotent cron groups **in your local timezone**:

| Tag | Entries |
|---|---|
| `# memory-suite-reindex` | curated reindex 03:30 · transcript reindex 04:00 (unchanged) |
| `# memory-suite-consolidate` | **heartbeat every 30 min** · **consolidate 03:45** (after the reindex) |

Re-running `--with-cron` is safe: each group is added only if its tag is absent (a workspace that already had
the reindex crons simply gains the Layer-3 crons; running again changes nothing). Cron runs in the system's
local timezone — adjust the hours for a different off-peak window. Logs go to
`memory/.consolidation/{heartbeat,consolidate}.log`.

**To enable autonomous LLM consolidation under cron**, export `MEMORY_LLM_CMD` in the cron environment (e.g. in
the crontab, a wrapper, or the user profile cron sources). Without it, the nightly run stays fully
deterministic and simply queues the judgment for the agent — which is the safe default.

---

## Artifacts & paths

| Path | Written by | Purpose |
|---|---|---|
| `memory/.consolidation/queue-<date>.md` | heartbeat + consolidate | the day's work-list / consolidation brief for the agent; **delete it once processed** |
| `memory/.archive/<original-path>` | consolidate (Pass B) | pruned memories, moved (never deleted) — restorable |
| `memory/.archive/manifest.tsv` | consolidate (Pass B) | archive audit: date · original path · archive path · why |
| `memory/04-meta/consolidations/consolidation-<date>.md` | consolidate (LLM step) | the model's consolidation record (only when `MEMORY_LLM_CMD` is set) |
| `memory/04-meta/audit.log` | consolidate | `ARCHIVE` / `CONSOLIDATE` audit lines (repo audit format) |

> **Recall hygiene.** `memory/.archive/` and `memory/.consolidation/` are *working areas*, not curated memory.
> The reindexer walks them, so Layer 3 **strips those keys (and any orphaned keys) from the search index** on
> every heartbeat and nightly run, keeping archived and queued notes out of `msem` / `mdeep` results.

---

## Environment knobs

| Var | Default | Effect |
|---|---|---|
| `MEMORY_LLM_CMD` | *(unset)* | opt-in command the nightly consolidate pipes the brief to; unset ⇒ queue for the agent |
| `HEARTBEAT_WINDOW_MIN` | `60` | "recent activity" window for heartbeat flags |
| `CONSOLIDATE_PRUNE_AGE_DAYS` | `90` | only archive memories unseen at least this long |
| `CONSOLIDATE_PRUNE_FACTOR` | `0.35` | ...and whose decay factor has sunk to ~this (floor is 0.30) |
| `CONSOLIDATE_PRUNE_IMPORTANCE` | `0.6` | ...and whose importance is below this (never prune important) |
| `CONSOLIDATE_MAX_PRUNE` | `50` | hard cap on archives per run |
| `CONSOLIDATE_DEDUP_MAX` | `40` | cap on dedup pairs reported |
| `CONSOLIDATE_SURFACE_TOP` | `8` | how many stale-but-important items to surface (also `--top`) |
| `RECONCILE_HIGH` / `RECONCILE_MID` | `0.95` / `0.85` | dedup-sweep cosine thresholds (shared with `reconcile.mjs`) |

---

## Safety contract

- **Non-destructive.** Prune = a move to `memory/.archive/`, audited and restorable. No pass hard-deletes a
  memory; `00-core` is never pruned.
- **Guarded / best-effort.** Missing `node` / stack / model ⇒ the affected pass is skipped, the rest continue,
  and a queue is still produced. Locks and atomic writes protect the shared index / decay stores.
- **Provider-free by default.** No network or LLM is required for any deterministic pass. The only place a
  model is ever consulted is the explicitly opt-in `MEMORY_LLM_CMD` step.
- **Reviewable.** The autonomous loop prepares work and records; a human/agent decides. Even the LLM step
  emits a record to review, not a silent rewrite.

See also: `references/operations.md` (decay · write-time reconciliation), `references/save-by-default.md`
(Layer 1), `references/reflection-process.md` (the human-in-the-loop reflection flow the LLM step's judgment
mirrors).
