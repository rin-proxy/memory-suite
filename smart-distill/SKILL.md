---
name: smart-distill
description: Distill long content (articles, docs, conversations) into a compact essence, then store it where it's instantly recallable — not in a flat cache, but in the agent's semantic-indexed memory with a provenance hash. Use when you read something long worth keeping, want to compress a thread into its load-bearing ideas, or need a distilled note to resurface later via memory search.
version: 1.0.0
author: Rin
license: UNLICENSED
lastUpdated: 2026-06-16
metadata:
  openclaw:
    emoji: "⚗️"
    requires:
      bins: ["bash", "sha256sum", "date"]
triggers:
  - "distill this"
  - "summarize and save"
  - "compress this"
  - "extract the essence"
  - "save the key points"
  - "distill to memory"
---

# ⚗️ Smart Distill

Compress long content into its load-bearing ideas, then **store it where it's recallable** — with provenance.

## 🚀 Quick Start

```bash
# After you (the LLM) produce the distilled essence:
echo "<distilled essence>" | ./scripts/distill-store.sh --title "Topic" --source "<url-or-tag>" --reindex
```

## ⚗️ The flow

1. **Distill** — you read the long content and write its essence (the few load-bearing ideas, decisions, numbers). Aim for what survives when space is scarce.
2. **Store** — pipe it to `distill-store.sh`. It writes to `memory/02-semantic/distilled/<slug>-<hash>.md` with YAML frontmatter + a **sha256 provenance hash** (same content = same hash = no duplicates).
3. **Recall** — because it lands in the **semantic-indexed** store, it's findable later via `msem "<query>"` / `mdeep` — not buried in a flat cache.

## 💪 Why this beats a flat distill-to-cache

| Flat cache (typical) | This |
|---|---|
| Writes to `cache/` (outside the index) | Writes into **semantic-indexed memory** |
| Findable only via a flat INDEX | **Recallable via `msem`/`mdeep`** by meaning |
| Hash for dedup | Hash for dedup **+ provenance frontmatter** (`type/source/date`) |
| Stored, then forgotten | Stored → **part of total recall** |

The distilled note isn't a dead file — it becomes searchable knowledge.

## 🔎 Recall it later

```bash
./scripts/semantic/msem "<the topic>" 8 --type distilled    # filter to distilled notes
```

Pass `--reindex` to make it searchable immediately; otherwise the 15-min reindex cron picks it up.

→ Distillation method, provenance, and store layout: [`references/distill-guide.md`](references/distill-guide.md)

---
*Clean-room Rin implementation. The distill-to-cache + provenance-hash idea is inspired by the `essence-distiller` skill; the semantic-recall integration (store where it's findable) is Rin's. By Rin ⚗️*
