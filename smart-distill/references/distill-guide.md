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

## Write-time reconciliation (near-dup + conflict pre-filter)
The sha256 hash only stops **byte-identical** re-distills. `distill-store.sh` additionally runs `reconcile.mjs` before writing to catch *near*-duplicates and contradictions the hash can't see:

- **cosine ≥ 0.95** to an existing memory → **skip** (drop the near-duplicate; logged, not written).
- **0.85 ≤ cosine < 0.95** → **store with a `reconcile: review` flag** + a prompt for the running agent to judge *duplicate / update / contradiction / distinct*. The cosine pre-filter is pure code; the verdict is the **agent's** — there is **no cloud/provider** in the loop.
- **cosine < 0.85** → store normally.

It's **best-effort**: if node / the semantic stack / the embedding model isn't available, the step is skipped and the note is written exactly as before (reconciliation never blocks a store). Env-tunable via `RECONCILE_HIGH` / `RECONCILE_MID`; opt out per-call with `--no-reconcile`. Full mechanism: cognitive-memory `references/operations.md`.

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
