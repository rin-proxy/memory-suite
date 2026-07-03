# Distill Guide

Distillation method, provenance, and store layout for the `smart-distill` skill — loaded on demand.

## What to keep (the distillation)
Distill to the **load-bearing ideas** — what survives when space is scarce:
- Decisions + their reasoning (not the debate).
- Hard numbers, configs, exact terms.
- The one or two insights that change how you'd act.
- Drop: filler, restated context, anything reconstructable.

A good distilled note is **5–20× smaller** than the source and loses nothing that matters. If you can't compress it, you haven't found the essence yet.

## Where it's stored (and why)
`memory/02-semantic/distilled/<slug>-<hash>.md` — **inside `memory/`, so the semantic indexer walks it.** That's the whole point: the distilled note is immediately recallable by meaning via `msem`/`mdeep`, not stranded in a flat `cache/` directory the index never sees.

Frontmatter written automatically:
```yaml
---
type: distilled
status: active
date: YYYY-MM-DD
source: <url-or-tag>
provenance: sha256-<8>
tags: [...]        # if --tags given
---
```

## Provenance + dedup
The `sha256` is computed over `title + source + content`. Same content → same hash → same filename → **no duplicates** (a re-distill of identical content is a no-op). The hash is also the audit trail: it ties the distilled note back to exactly what produced it.

## Recall
```bash
msem "<topic>" 8 --type distilled     # only distilled notes
mdeep "<topic>" 8                     # distilled notes + everything else
```
`--type distilled` works because the frontmatter sets `type: distilled` and the hybrid search filters on it.

## Indexing timing
- Default: the note is picked up by the **15-minute semantic reindex cron** → searchable within ~15 min.
- `--reindex`: forces `node scripts/semantic/index.mjs --incremental` now → searchable immediately (costs the embed time, ~tens of seconds).

## When to use vs the memory stores
Use `smart-distill` for **external/long content** you want compressed + recallable (an article, a long doc, a forwarded thread). For the agent's own episodic/semantic memory, the cognitive-memory stores + reflection already handle it — don't double-store.
