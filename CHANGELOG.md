# Changelog — memory-suite

All notable changes to the packaged **bundle**. The bundle version (`suite.json`) moves
independently of the individual skills' own `SKILL.md` versions.

## 1.8.1 (2026-07-04)

Install fixes surfaced by re-running `install.sh` end-to-end against a Claude Code target.

- **fix (install-breaking):** step 2 copied the semantic stack with `cp -f`, which **fails on the `eval/` subdirectory** (added in 1.4.0) — aborting every fresh `install.sh` at "installing semantic stack". Now copies directories recursively (`cp -Rf`, rm-first so re-runs stay idempotent). This had broken every clean install since 1.4.0 (undetected because updates went via file-sync, not a full install).
- **fix (claude-code transcript cron):** the transcript-reindex cron used `--src all` with no `--cc-dir`, so on a Claude Code install it matched no sources and indexed zero CC sessions. The cron is now target-aware — `--cc-dir "$HOME/.claude/projects"` for claude-code, `--src all` for openclaw.

## 1.8.0 (2026-07-04)

Proactive upgrade advisor — the agent offers the right optional flag when it would actually help (approval-gated, never auto-installs).

- **feat:** `proactive-partner/scripts/upgrade-advisor.sh` — provider-free detection of when the optional install flags would help, folded into `proactive-partner`'s scan as an "Engine upgrades available" section:
  - `--with-cron` when new memories are unindexed or no reindex cron is scheduled (staleness);
  - `--with-sqlite-vec` when the index passes ~8000 chunks and the deps aren't installed (scale);
  - `--with-reranker` (softer suggestion) when the corpus is large (~2000+) and the reranker model is absent (precision).
  Each recommendation carries the reason, measured-vs-threshold, and the exact command; thresholds are env-tunable; every check is guarded (no index/crontab/deps ⇒ skip). **Approval-gated:** the agent proposes, the user approves, then it runs `install.sh --with-…` — nothing is ever auto-installed. New `test-upgrade-advisor.mjs` (36 assertions). proactive-partner → 1.1.0.

## 1.7.1 (2026-07-04)

- **docs:** corrected the install instructions — this is a **bundle** (5 skills + a shared engine + a downloaded
  model), installed via `git clone … && bash install.sh`, **not** `openclaw skills install git:…` (that command
  only handles a single-skill repo with a root `SKILL.md`, and would skip the engine build + model download, so
  recall wouldn't work). Fixed the misleading one-liner in the "Why install it" + "Platforms" sections.

## 1.7.0 (2026-07-03)

Full anti-amnesia absorption (Layers 2 & 3) + a smart-cache-pro integration. memory-suite is now capture + recall + curation, end to end.

- **feat (Layer 2 — compaction capture):** a hook snapshots the about-to-be-compacted window into the *indexed* memory store (`memory/.compaction/`, so `msem`/`mdeep` see it) and queues high-signal lines for the agent to keep via `save.sh`. OpenClaw (`before_compaction` via `cognitive-memory/openclaw.plugin.json` + `hooks/compaction-capture/`) and Claude Code (`PreCompact` via `hooks/precompact-capture.sh`). Snapshot = pure code; curating = agent-driven. New capture test (27 assertions).
- **feat (Layer 3 — autonomous upkeep):** `scripts/heartbeat.sh` (light sweep) + `scripts/consolidate.sh` (nightly: dedup-flag, decay-prune to `memory/.archive/` — never deletes, surface, reindex) — all deterministic/provider-free — with an OPT-IN LLM step (`MEMORY_LLM_CMD`; unset ⇒ queue a brief for the agent). Optional crons via `install.sh --with-cron`. No autonomous daemon calls a provider.
- **feat (smart-cache-pro integration):** Layer 2 auto-detects Rin's smart-cache-pro pre-compaction snapshot (CC `~/.claude/cache/compaction/`, OpenClaw `<ws>/memory/cache/.compaction/`, or `SMART_CACHE_DIR`) and writes a lightweight indexed *reference* stub instead of duplicating the verbatim window; self-snapshots when absent. One-way (does not modify smart-cache-pro).
- cognitive-memory → **1.3.0** (capture Layers 1–3). All existing suites still green.

## 1.6.0 (2026-07-03)

Anti-amnesia Layer 1 (save-by-default capture) + plain-English, benefit-led descriptions.

- **feat:** absorbed anti-amnesia's **Layer 1 — real-time "save-by-default" capture** into cognitive-memory
  (provider-free, agent-driven). `cognitive-memory/scripts/save.sh` writes a high-signal item (decision, preference,
  fact, correction, milestone) straight to the curated store, running write-time **reconciliation** first (skip
  near-dups / flag review / write new) — capture + dedup in one flow. New `references/save-by-default.md` protocol +
  a SKILL.md section + the always-on rule in the AGENTS.md block template. Layers 2 (compaction hooks) and 3
  (autonomous heartbeat/nightly) are noted as future/optional — no autonomous capture is claimed.
- **docs:** rewrote all five skill `description:` lines and added README **"In plain English"** + **"Why install it"**
  sections — plain, benefit-led English that says what each skill does for a non-technical user and why to install it
  on a Claude Code or OpenClaw agent (kept honest; "use when" discovery triggers retained).

## 1.5.0 (2026-07-03)

Optional sqlite-vec vector backend — a query-time scaling upgrade for large corpora, off by default, identical recall.

- **feat:** `vecstore.mjs` — an OPT-IN sqlite-vec KNN backend that replaces the "load entire `index.json` + O(n) cosine
  scan" semantic-candidate fetch with a native on-disk KNN scan, for large stores. Enable with `VECSTORE=sqlite` or auto
  at ≥ `VECSTORE_THRESHOLD` (8000) chunks; install deps with `install.sh --with-sqlite-vec` (better-sqlite3 + sqlite-vec,
  optional/not-by-default). Derived FROM `index.json` (JSON stays the source of truth; the write path is unchanged);
  build via `node vecstore.mjs --build`. New `test-vecstore.mjs`.
- **Backward-compat (proven byte-for-byte):** with VECSTORE unset/off — or the deps/db absent — retrieval is IDENTICAL to
  today (diffed pre-edit vs edited hybrid/deep across 11 cases). And `VECSTORE=sqlite` yields byte-identical ranked output
  to JSON (same sem/kw/decay/rrf) → recall@k unchanged. It's purely a faster/lighter fetch, not a quality change.

## 1.4.0 (2026-07-03)

Cross-domain CONNECT (entity/link layer), a retrieval eval harness, and the reranker model pinned.

- **feat:** entity/link layer (`links.mjs`, A-MEM-style) for connection-synthesis — auto-links memories by
  semantic similarity (related-but-distinct band 0.35–0.85), temporal proximity (14d), and optional agent-supplied
  entities, with **MMR diversity** (λ=0.5) to surface relevant-but-DISSIMILAR (cross-domain) memories. Replaces
  `find-connections.sh`'s broken "domain = `type`" heuristic (also fixed a bash-4-only `mapfile` → bash-3.2-safe).
  New `test-links.mjs` (21 tests). Auto-linking is pure code (no provider); entity links are agent-driven/optional.
- **feat:** local **eval harness** (`_semantic-stack/eval/`) — pure IR metrics (recall@k, precision@k, MRR, nDCG@k),
  a runner mirroring the retrieval pipeline with an **A/B mode** (baseline vs decay/rerank, with Δ), synthetic fixtures
  that run model-free (keyword mode), and verified LoCoMo/LongMemEval fetch+convert recipes. New `test-metrics.mjs`
  (18 tests). Measured on the fixture: decay gives recall@2 **+0.10**.
- **feat:** the optional reranker model is now **integrity-pinned** — `RERANKER_SHA256` set
  (`bge-reranker-v2-m3-Q8_0.gguf`, verified end-to-end), so `install.sh --with-reranker` is checked like the embedder.

## 1.3.0 (2026-07-03)

Two provider-free retrieval upgrades — write-time reconciliation, and an optional cross-encoder reranker.

- **feat:** write-time **reconciliation** (dedup + conflict pre-filter). `reconcile.mjs` embeds a candidate memory and
  cosine-matches it against the existing index: `skip` (≥0.95 near-identical → deterministic dedup, no LLM), `review`
  (0.85–0.95 → the *running agent* decides duplicate/update/contradiction via a returned `verdictPrompt` — **no standing
  LLM provider**), `new` (<0.85). Wired into `smart-distill/scripts/distill-store.sh` (best-effort, `--no-reconcile`
  opt-out, never blocks a store). New `test-reconcile.mjs` (15 tests). Pattern inspired by dinomem, adapted provider-free.
- **feat:** optional local **cross-encoder reranker** (`rerank.mjs`) as a final stage after RRF+decay, via
  node-llama-cpp's `createRankingContext`/`rankAll` (bge-reranker-v2-m3 GGUF). **OFF by default, model-gated**: `RERANK=1`
  / `--rerank` enables it; absent flag/model ⇒ retrieval is byte-for-byte unchanged (empirically verified against the real
  index). Model via `install.sh --with-reranker` (~600MB; HF revision pinned, file-sha pending). New `test-rerank.mjs` (16 tests).
- **chore:** `cosine` moved to the model-free `store.mjs` (shared by the reconciler + engine; transparent to `hybrid`/`deep`).
- **docs:** README / PORTABILITY / SKILL.md updated honestly — reconciliation = code pre-filter + agent-driven verdict; reranker = optional/off-by-default.

## 1.2.0 (2026-07-03)

Genuinely dual-platform (OpenClaw **and** Claude Code), platform-neutral skill descriptions, and cruft removal.

- **feat:** `install.sh` gains `--target <openclaw|claude-code>` (default `openclaw`, unchanged).
  With `--target claude-code` the workspace defaults to `$HOME/.claude/memory-suite`, the **same**
  engine is installed (semantic stack → `<ws>/scripts/semantic/`, node-llama-cpp runtime,
  model download+verify, memory store skeleton), the 5 skills are copied into `$HOME/.claude/skills/`
  so Claude Code discovers them, and two convenience wrappers `<ws>/{msem,mdeep}` are written
  (they `exec env OPENCLAW_WORKSPACE=<ws> <ws>/scripts/semantic/{msem,mdeep}`). The final step prints
  the Claude-Code index commands — `node index.mjs` (curated) and
  `node index-transcripts.mjs --cc-dir "$HOME/.claude/projects" --incremental` (transcripts).
- **docs:** README gains a **Platforms** section documenting both install paths; notes that `mdeep`
  deep-recall indexes **both** OpenClaw and Claude Code (`~/.claude/projects/*.jsonl`) transcripts via
  `--cc-dir`/`--src cc`, all local + private + redacted-before-embedding.
- **chore:** de-branded the skill descriptions so they read right on both platforms — "for an
  OpenClaw agent" / "Turn an OpenClaw agent into" → "for your AI agent" / "Turn your AI agent into"
  (morning-briefing, proactive-partner). Genuinely OpenClaw-specific technical references untouched.
- **chore:** removed stale upgrade cruft that targeted the old `memory/meta` layout —
  `cognitive-memory/{UPGRADE.md, UPGRADE-1.0.7.md, upgrade_to_1.0.7.sh,
  scripts/upgrade_to_1.0.6.sh, scripts/upgrade_to_1.0.7.sh}`.

## 1.1.0 (2026-07-03)

Claude Code support + install-correctness fixes (surfaced while installing the bundle on macOS / Claude Code).

- **feat:** Claude Code transcript support for `mdeep` — a `claude-code` JSONL parser (extracts user +
  assistant text; drops thinking/tool_use/tool_result; strips CC system wrappers; honors `<NO-RECALL>`),
  `--cc-dir` / `--src cc` discovery, and `cc-<slug>-<YYYY-MM>` sharding (so `mdeep --src cc` works with no
  `deep.mjs` change). New `test-cc.mjs` (16 tests). The suite now indexes both OpenClaw and Claude Code history.
- **fix:** corrected the embedding-model `MODEL_SHA256` pin to the actual pinned-HF-revision file — the
  previous value came from a divergent copy, so **every clean install failed model verification**.
- **fix(macOS):** the transcript indexer's resource guards were tuned for a 1-core VPS and false-tripped on
  Macs, so transcript indexing never ran there. The memory guard is now OS-aware + env-tunable
  (`os.freemem()` underreports available RAM on macOS → `TRANSCRIPT_MIN_FREE_MB`, darwin default off), and
  the load guard scales by core count (`TRANSCRIPT_MAX_LOAD`; 1 core → 2.5, preserving old behavior).

## 1.0.0 (2026-07-03)

First release packaged as a standalone, git-ready bundle repo.

- Packages the 5-skill OpenClaw Memory Suite as **one** installable bundle sharing a single
  local semantic engine (arctic-embed via `node-llama-cpp`; `msem`/`mdeep` search).
- Bundled skills (own versions preserved): cognitive-memory 1.2.2 · smart-distill 1.0.0 ·
  connection-synthesis 1.0.0 · morning-briefing 1.1.0 · proactive-partner 1.0.0.
- Four idempotent, macOS + Linux-portable (bash 3.2-safe) lifecycle scripts at the repo root:
  `install.sh` · `update.sh` · `uninstall.sh` · `check.sh`.
- `suite.json` is the single source of truth for the bundle version + skill list; every script
  reads it (via `sed`, no `jq`/`node` dependency).
- `install.sh` (kept from the hardened original — portable sha256, native-toolchain preflight,
  pinned-model sha256 verify, seed stubs) extended to also lay down the 5 skills under
  `skills/<name>/` and to accept `--force` (refresh installed skill code on update).
- `update.sh` = re-pull + `install.sh --force`: refreshes code, preserves data.
- `uninstall.sh` removes installed skill + engine code but always preserves `memory/`,
  the built `.semantic` index, and `decay-scores.json`; keeps the ~1.1GB model + runtime
  unless `--purge-runtime` is given.
- `check.sh` validates the 5 `SKILL.md`, the `_semantic-stack` scripts, and `suite.json`,
  runs the 3 pure unit tests (transcripts / decay / surface), and soft-checks model presence.
- Workspace data (`memory/`, `decay-scores.json`, the built index, the model, the runtime)
  is never wiped by install / update / uninstall.
