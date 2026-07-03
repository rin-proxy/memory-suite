---
name: cognitive-memory
description: Battle-tested multi-store memory for AI agents with human-like encoding, consolidation, retrieval-time decay re-ranking, and hybrid (semantic + keyword) recall. Use when setting up agent memory, configuring remember/forget triggers, enabling sleep-time reflection, building knowledge graphs, or adding audit trails. Wires into local semantic search (msem) so recall stays language-agnostic and cloud-free.
version: 1.2.2
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["cat", "grep", "date", "bash"]
triggers:
  - "remember this"
  - "forget that"
  - "recall memory"
  - "memory system"
  - "reflect"
  - "consolidate memory"
  - "search memory"
  - "total recall"
  - "dig deeper"
author: Rin
license: UNLICENSED
lastUpdated: 2026-07-02
---

# Cognitive Memory System

Multi-store memory with natural-language triggers, knowledge graphs, retrieval-time decay re-ranking, reflection consolidation, hybrid local recall, and full audit trail. Battle-tested across 40+ days of continuous autonomous agent operation.

## 🗂️ 5-Store Layout (the battle-tested shape)

```
memory/
├── 00-core/         core facts that never decay (identity, hard preferences)
├── 01-episodic/     daily logs — what happened, when, with whom
├── 02-semantic/     knowledge: patterns/, questions/, numbers/
├── 03-procedural/   how-to / runbooks / playbooks
├── 04-meta/         system-level: about-the-agent, conventions
└── 05-connections/  synthesized insights — cross-note discoveries
```

This is the layout the skill installs. See the companion book **`runbook/cognitive-memory-architecture.md`** for the deep theory and **`runbook/connection-synthesis.md`** for how `05-connections/` accumulates original insight over time. Full four-store architecture, file tree, audit trail + key parameters: **`references/stores-and-audit.md`**.

## 🔍 Read side — hybrid local semantic search (msem)

This skill **writes**; recall is owned by a companion script `msem` that does **hybrid local search** (vector embeddings + keyword fusion via Reciprocal Rank Fusion):

```bash
# Companion script — install separately, not bundled here
./scripts/semantic/msem "what did I decide about the migration" 8
./msem "auth bug" --type pattern --status resolved          # filters
./msem "trading" --tag crypto
```

Key properties: **local** (embedding model on the agent host, no cloud call) · **language-agnostic** with a multilingual model (ID / EN / mixed) · **survives provider outages** (keeps working when Gemini / OpenAI quota dies) · **hybrid** (exact-term matches for names / tickers / SSH plus semantic similarity) · **decay-aware** (a bounded recency/access multiplier re-ranks the fused results, so recently- and often-recalled notes float up and stale ones sink — see below). See **`runbook/local-semantic-search.md`** for the implementation — hybrid vector + keyword recall (RRF) that folds in the keyword-only fallback.

**Retrieval-time decay** (`references/operations.md`): after RRF, each hit is multiplied by a `clamp(recency × access × importance, 0.3–1.5)` factor stored in `memory/.semantic/decay-scores.json`, and each returned file's access count / last-access time is bumped (best-effort, atomic). Fully **backward-compatible**: with no scores file the factor is exactly 1.0 and ranking is unchanged — the signal only kicks in once real usage accumulates.

### 🔭 Tier 2 — total recall (`mdeep`)

`msem` searches **curated** memory (high-signal, fast). When that isn't enough, escalate to **`mdeep`** — the *same* hybrid search run over **curated memory PLUS the raw conversation transcripts** (engineer sessions, channel threads, archived chats). So even a detail that was never written into a `.md` is still recoverable — nothing said is truly lost.

```bash
./scripts/semantic/mdeep "what did we decide about X" 8          # curated ∪ raw transcripts
./scripts/semantic/mdeep "that thing the user mentioned" --src archive --after 2026-05-01
```

**Escalate `msem` → `mdeep` when:**
- `msem` returns nothing relevant / only low scores, but you're sure it came up before.
- The user references a **specific past detail** — "remember when…", "what was that thing I said about…", "kita pernah bahas…".
- You need an exact quote / number / snippet from an old conversation, not a distilled summary.

**Order matters:** always try `msem` first (curated = cleaner, less noise); fall back to `mdeep` only when you need total coverage — it's a superset, but raw transcripts add noise. The transcript index is **auto-maintained** (daily cron); details in `scripts/semantic/transcripts-README.md`.

## ✍️ Write side — Quick Setup

1. **Init:** `bash scripts/init_memory.sh /path/to/workspace` — creates the dir structure, inits git for audit tracking, copies all templates.
2. **Config (native-search deployments only):** add a `memorySearch` block to `~/.clawdbot/clawdbot.json`. ⚠️ On Rin / 1-core VPS this is **OFF by design** — recall is **`msem`-only** (native embeddings in the gateway hot-path are slow + cloud-dependent). Skip if you run msem-only. Generic config block: `references/stores-and-audit.md`.
3. **Agent instructions:** append `assets/templates/agents-memory-block.md` to your AGENTS.md.
4. **Verify:** `"Remember that I prefer TypeScript"` → agent classifies → writes to semantic + core, logs audit. `"What do you know about my preferences?"` → searches core first, then semantic graph.

## Trigger System

**Remember:** "remember", "don't forget", "keep in mind", "note that", "important:", "for future reference", "save this"
→ Classify via routing prompt, write to appropriate store, update decay scores

**Forget:** "forget about", "never mind", "disregard", "scratch that", "remove from memory"
→ Confirm target, soft-archive (decay=0), log in audit

**Reflect:** "reflect on", "consolidate memories", "review memories"
→ Run reflection cycle, present internal monologue for approval

## Reference Materials

- `references/stores-and-audit.md` — Four-store architecture, full file tree, audit trail, key parameters
- `references/operations.md` — Decay · Reflection · Identity · Multi-agent access (full procedures)
- `references/architecture.md` — Full design document (1200+ lines) · `references/routing-prompt.md` — LLM memory classifier · `references/reflection-process.md` — Reflection philosophy + internal-monologue format

## Troubleshooting

**Memory not persisting?** *Native-search deployments:* check `memorySearch.enabled: true` + restart gateway. *msem-only (Rin):* verify MEMORY.md exists and the `msem` index is fresh — `node scripts/semantic/index.mjs --incremental`.

**Reflection not running?** Ensure previous reflection was approved/rejected. **Audit trail not working?** Check `.git/` exists, verify `audit.log` is writable.
