# Changelog — memory-suite

All notable changes to the packaged **bundle**. The bundle version (`suite.json`) moves
independently of the individual skills' own `SKILL.md` versions.

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
