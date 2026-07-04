# Engine-upgrade advisor

Memory Suite ships three OPTIONAL install flags. They're off by default because most workspaces don't need them — but a workspace *grows*, and users forget to add a flag when it would finally help. `scripts/upgrade-advisor.sh` closes that gap: it **detects** (pure code, provider-free) when a flag is now worth it and **recommends** it. proactive-partner then **proposes** the upgrade during a scan — and the human **approves** before anything is installed.

## The no-auto-install contract (non-negotiable)

- The advisor **only measures + prints.** It never runs `install.sh`, never downloads a model, never installs a dep, never edits the workspace.
- The **agent PROPOSES** the upgrade (surfacing the advisor's recommendation + the exact command), the **human APPROVES**, and *only then* does the agent run `install.sh --with-…`.
- This is the same guardrail as the rest of proactive-partner: **nothing external without approval.** Detection is deterministic and safe to run on every scan; the *action* is gated behind an explicit yes.

## Provider-free detection

Every signal is measured with `fs` / `stat` / `grep` + a JSON chunk count. **No embedding model, no network, no LLM call.** Safe and cheap to run on every proactive scan. Each check is independently **guarded**: a missing index, an unreadable crontab, or an absent dep just **skips that check** — it never errors, and the script prints **nothing at all** when nothing triggers (so a healthy workspace stays silent).

## The three triggers

| Flag | Trigger (severity) | Signal measured | Default threshold |
|---|---|---|---|
| `--with-cron` | **staleness** (recommend) | newest content `*.md` under `memory/` is newer than `memory/.semantic/index.json` (unindexed content), **OR** no `# memory-suite-reindex` line in `crontab -l` | — |
| `--with-sqlite-vec` | **scale** (recommend) | total chunk count in `index.json` ≥ threshold **AND** the sqlite-vec deps (`better-sqlite3` + `sqlite-vec`) are **not** installed under the runtime `node_modules` | `8000` (= vecstore `VECSTORE.THRESHOLD`) |
| `--with-reranker` | **precision** (suggest) | chunk count ≥ a softer threshold **AND** the reranker model file is absent | `2000` |

Notes:
- **Staleness** excludes non-recall trees/files: `.semantic`, `logs`, `.compaction`, `.consolidation`, `.archive`, and any `*-log.md`. Reason surfaced: *recall is missing recent memories; a scheduled reindex keeps it fresh.*
- **Scale** mirrors the engine's own auto-enable point: at/above `VECSTORE.THRESHOLD` chunks, default recall loads the whole JSON index and runs an O(n) cosine scan per query — sqlite-vec makes queries fast + light with **identical** recall (JSON stays the source of truth). Reason surfaced: *N chunks — queries getting slow/heavy.*
- **Precision** is a *softer suggestion* — default recall is unaffected either way. A cross-encoder reranker sharpens the head of the results, opt-in per query via `RERANK=1`. Reason surfaced: *large corpus — a reranker sharpens the top results.*

## Chunk counting

`index.json` is written single-line (`JSON.stringify`, no spacing) and its shape is `{ meta, files: { <rel>: { mtime, meta, chunks:[{ startLine, text, vector }] } } }`. The count = **sum of `files[*].chunks.length`**. The advisor uses `node` for an authoritative parse and falls back to counting the per-chunk `"startLine"` key with `grep -o` when `node` is unavailable — so it stays provider-free.

## Thresholds are env-tunable

| Env var | Default |
|---|---|
| `ADVISOR_SQLITE_VEC_THRESHOLD` | `$VECSTORE_THRESHOLD`, else `8000` |
| `ADVISOR_RERANKER_THRESHOLD` | `2000` |

Probe paths are overridable too (`ADVISOR_INDEX`, `ADVISOR_MEMORY_DIR`, `ADVISOR_RERANKER_MODEL`, `ADVISOR_SQLITE_VEC_DIR`, `ADVISOR_CRONTAB_FILE`, `ADVISOR_INSTALL_CMD`) — this is what keeps the logic unit-testable with synthetic inputs (`scripts/test-upgrade-advisor.mjs`).

## Output shape

For each rec the advisor prints a human-readable markdown bullet **and** one machine-readable line:

```
UPGRADE_REC<TAB>flag=--with-cron<TAB>severity=recommend<TAB>reason=staleness<TAB>measured=cron=absent,stale=yes,content_newer_secs=2343<TAB>threshold=cron=present,index=fresh<TAB>cmd=bash install.sh "<ws>" --target claude-code --with-cron
```

Fields: `flag` · `severity` (recommend | suggest) · `reason` (staleness | scale | precision) · `measured` (the live value) · `threshold` (the compare point) · `cmd` (the exact, approval-gated install command). The `cmd` is best-effort exact: it embeds the workspace and adds `--target claude-code` when the workspace lives under `~/.claude`. Re-running `install.sh` is idempotent — it installs only the new flag's extras and never touches existing memories.

## How proactive-partner uses it

`scripts/proactive-scan.sh` calls the advisor best-effort (guarded) and folds any output into an **"Engine upgrades available"** section of the scan. During the proactive loop the agent treats each rec like any other opportunity: surface it, ground it in recall if useful, **propose** it with the exact command — and wait for the human's yes before running `install.sh`.

## Run it directly

```bash
./scripts/upgrade-advisor.sh                 # scans $OPENCLAW_WORKSPACE (or the default)
./scripts/upgrade-advisor.sh /path/to/ws     # scan a specific workspace (read-only)
node scripts/test-upgrade-advisor.mjs        # pure-logic tests over synthetic inputs
```
