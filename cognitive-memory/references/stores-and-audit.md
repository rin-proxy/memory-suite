# Cognitive Memory — Stores, Architecture & Audit

Structural reference (four-store architecture · full file tree · audit trail · key parameters) for the cognitive-memory skill — loaded on demand. The day-to-day recall/write workflow lives in SKILL.md; deep theory in architecture.md + reflection-process.md.

## Architecture — Four Memory Stores

```
CONTEXT WINDOW (always loaded)
├── System Prompts (~4-5K tokens)
├── Core Memory / MEMORY.md (~3K tokens)  ← always in context
└── Conversation + Tools (~185K+)

MEMORY STORES (retrieved on demand)
├── Episodic   — chronological event logs (append-only)
├── Semantic   — knowledge graph (entities + relationships)
├── Procedural — learned workflows and patterns
└── Vault      — user-pinned, never auto-decayed

ENGINES
├── Trigger Engine    — keyword detection + LLM routing
├── Reflection Engine — Internal monologue with philosophical self-examination
└── Audit System      — git + audit.log for all file mutations
```

### File Structure

```
workspace/
├── MEMORY.md                    # Core memory (~3K tokens)
├── IDENTITY.md                  # Facts + Self-Image + Self-Awareness Log
├── SOUL.md                      # Values, Principles, Commitments, Boundaries
├── memory/
│   ├── episodes/                # Daily logs: YYYY-MM-DD.md
│   ├── graph/                   # Knowledge graph
│   │   ├── index.md             # Entity registry + edges
│   │   ├── entities/            # One file per entity
│   │   └── relations.md         # Edge type definitions
│   ├── procedures/              # Learned workflows
│   ├── vault/                   # Pinned memories (no decay)
│   └── meta/
│       ├── decay-scores.json    # Relevance + token economy tracking
│       ├── reflection-log.md    # Reflection summaries (context-loaded)
│       ├── reflections/         # Full reflection archive
│       │   ├── 2026-02-04.md
│       │   └── dialogues/       # Post-reflection conversations
│       ├── reward-log.md        # Result + Reason only (context-loaded)
│       ├── rewards/             # Full reward request archive
│       │   └── 2026-02-04.md
│       ├── pending-reflection.md
│       ├── pending-memories.md
│       ├── evolution.md         # Reads reflection-log + reward-log
│       └── audit.log
└── .git/                        # Audit ground truth
```

---

## Audit Trail

**Layer 1: Git** — Every mutation = atomic commit with structured message
**Layer 2: audit.log** — One-line queryable summary

Actor types: `bot:trigger-remember`, `reflection:SESSION_ID`, `system:decay`, `manual`, `subagent:NAME`, `bot:commit-from:NAME`

**Critical file alerts:** SOUL.md, IDENTITY.md changes flagged ⚠️ CRITICAL

---

## Key Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| Core memory cap | 3,000 tokens | Always in context |
| Evolution.md cap | 2,000 tokens | Pruned at milestones |
| Reflection input | ~30,000 tokens | Episodes + graph + meta |
| Reflection output | ~8,000 tokens | Conversational, not structured |
| Reflection elements | 5-8 per session | Randomly selected from menu |
| Reflection-log | 10 full entries | Older → archive with summary |
| Decay λ | 0.03 | ~23 day half-life |
| Archive threshold | 0.05 | Below = hidden |
| Audit log retention | 90 days | Older → monthly digests |

---
