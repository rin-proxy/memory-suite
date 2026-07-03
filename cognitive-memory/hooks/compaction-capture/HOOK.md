---
name: compaction-capture
description: "Observe-only session:compact:before hook — snapshots the about-to-be-trimmed context window into the indexed memory store and queues high-signal lines for the agent to curate. Never blocks compaction."
metadata:
  openclaw:
    emoji: "🧠"
    events: ["session:compact:before"]
---

# Compaction Capture (Layer 2)

Fires on `session:compact:before`. Compaction **cannot be stopped** — file-hooks are observe-only — so this
hook does the next best thing: it **snapshots** the window that is about to be trimmed into
`memory/.compaction/snapshot-<ts>.md` (which `msem`/`mdeep` then index) and appends flagged high-signal
lines to `memory/.compaction/curation-queue.md`.

**Provider-free split.** The snapshot and the flagging are **pure code** (no model, no network — see the
sibling `capture.mjs`). Deciding what is worth *permanently* curating is **agent-driven**: you later drain
the queue and promote the keepers with `scripts/save.sh` (Layer 1), which dedups via reconcile.

**Honest scope.** Where the runtime hands the hook real message content it snapshots it; where it exposes
metadata only (the documented file-hook contract), it writes an indexed breadcrumb + nudges you, and the
raw window stays recoverable through `mdeep`'s transcript index. Best-effort throughout: every error is
swallowed so compaction is never blocked or broken.

Registered in the skill's `openclaw.plugin.json`. Enable with `openclaw hooks enable compaction-capture`
(the skill's `install.sh` can do this). Full setup + the Claude Code equivalent:
`references/compaction-capture.md`.
