# Changelog — memory-suite

All notable changes to the packaged **bundle**. The bundle version (`suite.json`) moves
independently of the individual skills' own `SKILL.md` versions.

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
