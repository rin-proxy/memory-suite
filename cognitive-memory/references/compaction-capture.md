# Compaction capture — snapshot the trimmed window into memory (Layer 2)

When an agent's context window is about to be **compacted** (trimmed), this layer captures the
about-to-be-lost content so it is **preserved + indexable**, and queues the high-signal items for the
agent to curate. It is the capture-at-a-lifecycle-boundary half of **Layer 2**, the counterpart to Layer 1's
real-time `save.sh`.

**This is Layer 2: boundary-triggered, provider-free snapshot + agent-driven curation.**
- **Boundary-triggered** — fires on the compaction event (a hook), not mid-conversation and not on a cron.
- **Provider-free** — the snapshot and the high-signal flagging are **pure code** (`hooks/compaction-capture/capture.mjs`): no embedding model, no network, no LLM/provider call in the hook.
- **Agent-driven curation** — the hook *nominates*; **you**, the agent, later decide what's worth keeping and promote it with `scripts/save.sh` (Layer 1), which dedups via reconcile.

> **Why capture at all if `mdeep` already indexes raw transcripts?** Because compaction **cannot be
> stopped** — hooks are observe-only; you can snapshot the content, not save the window from trimming.
> `mdeep` already means *nothing said is truly lost* (it searches the raw transcript index). Layer 2's
> **added value** is narrower and honest: it **promotes** the exact window that's rolling off into the
> **curated, high-signal** store (so `msem` — the fast first-choice recall — sees it, not just deep
> `mdeep`), and it **queues** the load-bearing lines so they get a deliberate keep/drop decision instead
> of silently aging out.

## What it writes, and where

Both front-ends write the same two artifacts into `memory/.compaction/` (inside the same workspace
`msem`/`mdeep` index — resolved exactly like `store.mjs`: `OPENCLAW_WORKSPACE`, else `~/.openclaw/workspace`):

| File | What | Indexed? |
|---|---|---|
| `snapshot-<ts>-<hash>.md` | The trimmed window, rendered readable (`**role:** text`), with `parseMeta`-compatible frontmatter (`type: compaction-snapshot`, `date`, `tags`, `source`, `trigger`, `messages`, `captured`). | **Yes** — under `memory/`, and *not* matched by the indexer's EXCLUDE list, so `msem`/`mdeep` pick it up on the next reindex. |
| `snapshot-<ts>-<hash>-ref.md` | The **reference stub** written *instead* of the full snapshot when smart-cache-pro already holds the verbatim window (see below): same frontmatter (plus `smart_cache: true` + a `full_verbatim: <path>` pointer) and the flagged high-signal lines, but **not** the full window body. | Yes (same as above). |
| `curation-queue.md` | Append-only worklist of flagged high-signal lines: `- [ ] (role · tags) line`, grouped per compaction with a back-link to the snapshot (full or `-ref`). | Yes (a bonus — flagged lines become searchable even before you curate). |

The snapshot filename carries a **content hash**, so re-firing on the identical window is idempotent
(same file), while distinct windows never collide. Tool-call / thinking blocks and system wrappers are
stripped — the snapshot is prose, not XML. If the runtime exposes only metadata (no content), the snapshot
is written as a **breadcrumb** (counts + a pointer) and the raw window remains reachable via `mdeep`.

### High-signal flagging (pure-code heuristic)

`capture.mjs` splits each turn into sentence-ish lines and tags any that match a fixed marker set —
`remember` · `decision` · `preference` · `correction` · `milestone` · `todo` (mirrors the save-by-default
"what to capture" list). It's a **nominator**, not a judge: deduped, capped per compaction, and every line
lands in the queue as an unchecked box for **you** to resolve. No model is consulted at flag time.

## How it complements Layer 1 and `mdeep`

| | Layer 1 `save.sh` | **Layer 2 compaction-capture (this)** | `mdeep` transcripts |
|---|---|---|---|
| Trigger | Agent, mid-conversation | Compaction boundary (hook) | Daily transcript index cron |
| Writes | One curated note (reconciled) | Whole-window snapshot + curation queue | Nothing (reads raw logs) |
| Provider | Free (agent + reconcile) | **Free (pure code)** | Free (local embed) |
| Failure mode | Misses what you forget to save | Snapshot is code; keeping is still your call | Buries a fact in noise |

Layer 2 is the **safety net at the window boundary**: the moment the context is about to roll off, the
window is promoted into `msem`-visible memory and its load-bearing lines are teed up for a decision — so a
decision/preference stated late in a long session isn't lost just because you never got to `save.sh` it.

---

## Setup — OpenClaw (file-hook)

The skill ships `openclaw.plugin.json`, which registers an **observe-only** hook on `session:compact:before`
→ `hooks/compaction-capture/` (`handler.js` + the shared `capture.mjs`):

```jsonc
// cognitive-memory/openclaw.plugin.json (already shipped)
"hooks": [
  { "id": "compaction-capture", "path": "hooks/compaction-capture", "events": ["session:compact:before"] }
]
```

Enable it (the skill's `install.sh` can do this for you):

```bash
openclaw hooks enable compaction-capture
```

On `compact:before` the handler best-effort snapshots the window and, where the runtime exposes a nudge
channel, pushes a one-line reminder to curate the queue. It **never blocks or breaks compaction** — every
error is swallowed. See `hooks/compaction-capture/HOOK.md`.

## Setup — Claude Code (PreCompact hook)

`hooks/precompact-capture.sh` is the Claude Code equivalent. Claude Code fires **PreCompact** with a JSON
payload on stdin (`transcript_path`, `trigger`); the script reads that transcript and runs the *same*
`capture.mjs`, so the snapshot + queue are byte-for-byte the same shape as the OpenClaw path. Wire it in
`settings.json`:

```jsonc
// ~/.claude/settings.json
"hooks": {
  "PreCompact": [
    { "matcher": "",
      "hooks": [
        { "type": "command",
          "command": "bash /ABS/PATH/TO/cognitive-memory/hooks/precompact-capture.sh" }
      ] }
  ]
}
```

- `matcher: ""` fires on both `auto` (context-full) and `manual` (`/compact`) triggers; use `"auto"` to skip manual.
- **Point it at your memory store.** The script resolves the workspace from `MEMORY_SUITE_WS`, then
  `OPENCLAW_WORKSPACE`, then `CLAUDE_PROJECT_DIR`, then `~/.openclaw/workspace`. For a standalone Claude
  Code user, set `MEMORY_SUITE_WS` (or `OPENCLAW_WORKSPACE`) to the dir that contains `memory/` — the same
  root `msem`/`mdeep` index — e.g. in the hook command: `MEMORY_SUITE_WS=/path/to/ws bash …/precompact-capture.sh`.
- Best-effort: if `node`/`capture.mjs`/the transcript is unavailable it still writes an indexed breadcrumb, and it always exits 0.

### smart-cache-pro integration (auto-detected — references, doesn't duplicate)

The user may also run **smart-cache-pro** (a separate OpenClaw plugin), whose own pre-compaction snapshot
already keeps a **verbatim** copy of the very same window:

| Platform | smart-cache-pro writes the verbatim window to | Format |
|---|---|---|
| Claude Code (`~/.claude/hooks/snapshot-before-compact.mjs`) | `~/.claude/cache/compaction/transcript-<ts>.jsonl` | a verbatim copy of the transcript `.jsonl` |
| OpenClaw (smart-cache-pro plugin, `before_compaction`) | `<ws>/memory/cache/.compaction/snapshot-<ts>.json` | JSON `{ at, messageCount, messages }` |

With both plugins installed, blindly self-snapshotting would store that window **twice**. So this layer is
**smart-cache-aware** (`capture.mjs` → `findSmartCacheSnapshot` → `captureWindow`, shared by *both* the
OpenClaw handler and the Claude Code `precompact-capture.sh`):

- **When a fresh smart-cache snapshot is found** for this compaction, we write a lighter **reference stub**
  (`snapshot-<ts>-<hash>-ref.md`) — same indexed frontmatter, a `full_verbatim: <path>` pointer to
  smart-cache's copy, and the flagged high-signal lines — **instead of** duplicating the full verbatim
  window. You still get recall (`msem`/`mdeep` index the stub + flagged lines) and the curation queue,
  without the second on-disk copy.
- **When smart-cache is absent** (or its snapshot isn't found in time), we **self-snapshot exactly as
  before** — fully backward-compatible.

**Detection.** `findSmartCacheSnapshot` looks, in order, at: `SMART_CACHE_DIR` (explicit override — its dir
plus `compaction`/`.compaction` subdirs), then the Claude Code default `~/.claude/cache/compaction/`, then
the OpenClaw default `<ws>/memory/cache/.compaction/`. A snapshot counts only if it's **fresh** — modified
within ~2 min of the compaction (`SMART_CACHE_MAX_AGE_MS` overrides) — so a snapshot from a *previous*
compaction is never mistaken for this one. It's **best-effort and guarded**: any detection or reference
error falls back to a full self-snapshot, so the hook never breaks. Because hook order isn't guaranteed, if
this hook happens to run *before* smart-cache writes its snapshot, we simply self-snapshot that round.

**One-way.** This is a one-way adaptation: memory-suite only **reads** smart-cache-pro's output — it never
writes to, modifies, or depends on smart-cache-pro. The pointer can age out if smart-cache prunes its cache
(its `retentionDays`, default 14d); the flagged lines live in the stub regardless, and `mdeep`'s transcript
index still backstops the raw window.

**Still complementary — run both.** smart-cache gives you the verbatim safety copy; this layer makes the
window **recallable and curatable**. On Claude Code, list both commands under the same `PreCompact` block
(two `hooks` entries in one matcher, or two matcher objects); they're order-independent and both exit 0.

---

## Curating the queue (this part is agent-driven)

The honest boundary: **the snapshot is code; deciding what to permanently keep is you.** When you next
touch memory (or when the nudge fires), open `memory/.compaction/curation-queue.md` and, for each `- [ ]`:

1. **Keep** → `scripts/save.sh --text '<the item>' --type <decision|preference|fact|correction|milestone>` — reconcile dedups against what's already stored, so promoting a line that's already saved is near-free.
2. **Drop** (noise / already known) → just delete the line.

Then trim resolved blocks. Old snapshots can be left in place (they're indexed context) or pruned
periodically — they're a superset of what you curated, and `mdeep` still covers the raw window regardless.

## Layer roadmap — honest scope

Layer 2 as delivered here is the **capture-at-compaction** boundary. What remains deferred:

1. **Layer 1 — real-time save-by-default** (shipped) — agent calls `save.sh` mid-conversation. See `references/save-by-default.md`.
2. **Layer 2 — compaction / lifecycle capture (this doc)** — snapshot the trimmed window into indexed memory + queue high-signal items at the compaction boundary. Provider-free hook; agent-driven curation. *Session-end (non-compaction) flushing is a natural extension of the same `capture.mjs` and is not wired here.*
3. **Layer 3 — autonomous heartbeat / nightly sweep (deferred)** — a scheduled pass that re-reads recent activity and back-fills anything Layers 1–2 missed. The only genuinely autonomous layer; **not** part of this delivery.

Until Layer 3 exists, reliability rests on the always-on Layer 1 habit, this Layer 2 boundary net, and
`mdeep`'s raw-transcript backstop underneath both.
