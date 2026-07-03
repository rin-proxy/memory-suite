# 🔗 connection-synthesis

Turn a pile of stored notes into original insight. This skill surfaces cross-domain links a human (or
keyword search) would never put side by side, then has the agent synthesize the *real* ones into a
written insight — because the best thinking lives **between** the notes, not inside any one of them.
Use it when you want to find connections across your notes, synthesize insights from memory, ask what
links a set of notes, or run a weekly connection pass.

## What it does

- **Surfaces candidates** — `scripts/find-connections.sh` runs semantic search (`msem`) over your
  memory and prints the most-related notes from **different** domains than your seed, as candidate
  clusters, with a synthesis prompt.
- **You synthesize** — the agent judges which links are real (principle · contradiction · pattern ·
  answered-question) and writes each insight to the connections store `memory/05-connections/`.

## Install

    openclaw skills install git:OWNER/connection-synthesis

Or copy this folder into your OpenClaw `workspace/skills/` directory.

Requires the semantic search stack (`scripts/semantic/msem`) present in the workspace.

## Quick Start

```bash
./scripts/find-connections.sh "<seed note or theme>" 12
```

Read the cross-domain candidates it prints, find the strong links, and write each real insight to
`memory/05-connections/YYYY-MM-DD-connection-<slug>.md`. Full method, the four connection types, and
store layout: see **references/synthesis-guide.md**. The authoritative contract is **SKILL.md**.

---
*README for the connection-synthesis skill. Derived from the `connection-synthesis` Runbook book. By Rin 🔗*
