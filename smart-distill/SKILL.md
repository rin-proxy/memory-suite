---
name: smart-distill
description: Read something long — an article, a doc, a chat thread — and keep only what matters. It compresses the content down to its key ideas and files them in the agent's searchable memory (not a note that gets lost), so the gist resurfaces exactly when it's relevant later. Use when you want to save the essence of long content for the agent to recall down the line.
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
2. **Store** — pipe it to `distill-store.sh`. It writes to `memory/02-semantic/distilled/<slug>-<hash>.md` with YAML frontmatter + a **sha256 provenance hash** (same content = same hash = no duplicates). Before writing, it runs a **write-time reconcile** (below) so *near*-duplicates and contradictions don't pile up either.
3. **Recall** — because it lands in the **semantic-indexed** store, it's findable later via `msem "<query>"` / `mdeep` — not buried in a flat cache.

## 🧬 Reconcile before store — semantic dedup + conflict pre-filter (provider-free)

The sha256 hash only catches **byte-identical** re-distills. To also catch *near*-duplicates and contradictions, `distill-store.sh` calls `reconcile.mjs` before writing: it embeds the candidate and compares it (cosine) to the already-indexed memory, then:

- **≥ 0.95 cosine → skip.** Near-identical to an existing note — the write is dropped (logged, not stored).
- **0.85–0.95 → store + flag.** Ambiguous: the note is written with a `reconcile: review` frontmatter flag and a prompt asking the **running agent** to judge *duplicate / update / contradiction / distinct*. No external LLM — the agent already in the session is the judge (the cosine pre-filter is pure code; only the ambiguous band asks for a verdict). This is the key adaptation: **no cloud/provider** stands between you and a write.
- **< 0.85 → store normally.**

**Best-effort & non-blocking:** if node or the semantic stack/model isn't present, the reconcile step is skipped and the note is written as before — reconciliation never blocks a store. Tune with `RECONCILE_HIGH` / `RECONCILE_MID`; opt out per-call with `--no-reconcile`. Details: `references/distill-guide.md`.

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
*Clean-room Rin implementation. The distill-to-cache + provenance-hash idea is inspired by the `essence-distiller` skill; the semantic-recall integration (store where it's findable) is Rin's. The write-time reconcile (embedding dedup + agent-judged conflicts) is inspired by dinomem's reconciliation, adapted to be provider-free. By Rin ⚗️*
