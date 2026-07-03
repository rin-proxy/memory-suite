# "Total Recall" — Deep Transcript Memory

A semantic-recall safety net **beneath** the agent's curated memory: it indexes the **raw conversation
transcripts** so no detail is ever lost just because it wasn't curated into a `.md`. Extends the agent's
existing embed infra (arctic-embed-l-v2.0, 1024-dim) — the curated index is **untouched** (additive).

## What it does
- Indexes raw transcripts → a **separate, sharded** vector store (curated `index.json` stays fast).
- Recall via **`mdeep`** = curated ∪ transcript, hybrid (semantic + keyword) via RRF, labeled by source.
- **Proven:** a detail present only in a transcript surfaces in `mdeep` but is invisible to `msem`.

## Files (in `scripts/semantic/`)
| File | Role |
|---|---|
| `transcripts.mjs` | PURE parsers (3 formats) + chunking + noise-strip + opt-out + dedup id |
| `redact.mjs` | PURE secret redaction (gh/openai/jwt/bearer/assignment/private-key) |
| `index-transcripts.mjs` | indexer: backfill/incremental, sharded, resource-guarded, fail-loud |
| `deep.mjs` + `mdeep` | deep recall (curated ∪ transcript shards) |
| `test-transcripts.mjs` | unit tests (parser + redactor + noise filter) |
| `test-cc.mjs` | unit tests for the Claude Code parser + content-detection |

## Sources indexed
- `memory/threads/*.jsonl` — OpenClaw thread (keep `user_message`/`decision`/`technical_note`)
- `memory/session-archive-*.jsonl` — archived sessions (`type:"message"`)
- `~/.openclaw/.claude/projects/**/*.jsonl` — engineer (Claude Code) sessions (`user`/`assistant`, text blocks only)
- `~/.claude/projects/**/*.jsonl` — **standalone Claude Code** sessions (opt-in via `--cc-dir` / `--src cc`).
  Detected by shape (top-level `type` `user`/`assistant` + `message`); keeps only `text` blocks
  (drops `thinking`/`tool_use`/`tool_result` + CC command wrappers). Shards per project-slug.

Stored at `memory/.semantic/transcripts/<src>-<YYYY-MM>.json` (+ `.cursor.json`); Claude Code adds the
project-slug: `cc-<slug>-<YYYY-MM>.json` (recall as `--src cc`). `.semantic/` is excluded from the
curated walk → no indexing loop.

## Usage
```bash
# recall (curated ∪ transcripts)
./mdeep "what did we decide about X" 8 [--src engineer|threads|archive] [--after 2026-05-01] [--before 2026-06-01]

# one-shot backfill (off-peak)
node index-transcripts.mjs --backfill [--src all|engineer|threads|archive|cc] [--max N] [--dry]

# index standalone Claude Code sessions (opt-in): --src cc uses ~/.claude/projects, or point --cc-dir
node index-transcripts.mjs --backfill --src cc [--cc-dir ~/.claude/projects] [--max N]

# incremental (what the daily cron runs)
node index-transcripts.mjs --incremental --src all --max 150
```
**Daily cron** (off-peak, your choice of hour) — e.g. `0 4 * * *` running `--incremental --src all --max 150` → `transcripts/reindex.log`. The installer wires this in your machine's local timezone when run with `--with-cron`.

## Design decisions
- **Additive** — never touches `index.mjs` / `index.json`; separate sharded store.
- **Same embed model** as curated (arctic-embed-l-v2.0, 1024-dim) → vectors share one space → RRF works.
- **Incremental cursor** (`{size,mtime,linesIndexed}` per file) → append-only tail; idempotent via `sha1(file:line:sub:text80)`.
- **Resource-safe (1-core/3.8GB):** entry-guard on ambient load (`>2.5` → skip) + mid-run **memory-only** guard (load mid-run is just our own embedding); batch yield; `--max` cap.
- **Privacy:** secret redaction at parse; in-band opt-out tag `<NO-RECALL>`; drops `thinking`/`tool_use`/`tool_result` + Claude Code command wrappers.
- **Fail-loud:** a changed file that yields 0 units exits non-zero (avoid silently-empty index).

## Known refinements (future)
- **Checkpointing:** shards are written once at end of a run — for very long backfills, periodic writes would reduce redo-on-crash. (Daily incremental runs are tiny, so N/A there.)
- **Scaling ceiling:** flat-JSON brute-force cosine is fine at personal scale; if transcript chunks exceed ~10k, migrate `mdeep` to sqlite-vec (episodic-memory pattern).
- **Retention:** currently keep-forever (volume small); add monthly-shard pruning if it grows.

*Deep transcript-memory layer for the Memory Suite — additive to the curated index.*
