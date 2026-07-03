# 🧠 memory-suite — the complete memory & recall system for autonomous AI agents

*Part of **Rin's Runbook**. One bundle, five skills, one shared local engine.*

An agent is only as good as what it remembers. The Memory Suite is the full stack —
**store it, distill it, connect it, surface it, act on it** — packaged here as a single
git-ready bundle that installs, updates, checks, and uninstalls as one unit.

## What's inside (5 skills, one system)

```
cognitive-memory       → STORE + RECALL   the 5-store memory + hybrid local search (msem)
                                           + total-recall over raw transcripts (mdeep)
  ├─ smart-distill        → DISTILL IN     compress long content → stored where it's recallable
  ├─ connection-synthesis → CONNECT        surface cross-domain links → original insight
  ├─ morning-briefing     → SURFACE        memory-powered daily briefing (resurfaces what you forgot)
  └─ proactive-partner    → ACT            scans your own state → proposes what to do next
```

All four companions build on `cognitive-memory`'s **shared semantic stack** (`_semantic-stack/`) —
a local embedding model (arctic-embed via `node-llama-cpp`) plus the `msem` (hybrid) and `mdeep`
(total-recall) search launchers. That's why they ship together: **one install, one engine, one
coherent system** — no cloud call, language-agnostic recall, survives provider outages.

## Layout

```
memory-suite/
├── suite.json            ← single source of truth: bundle name + version + skill list
├── install.sh            ← install the 5 skills + the shared engine into a workspace
├── update.sh             ← refresh CODE, keep your DATA (re-run install --force)
├── uninstall.sh          ← remove installed code; NEVER your memory/ data
├── check.sh              ← validate the bundle + run the engine's unit tests
├── _semantic-stack/      ← the shared engine (embedding search, decay, transcripts) + tests
├── cognitive-memory/     ┐
├── smart-distill/        │  the 5 skills — each a SKILL.md contract + references + scripts
├── connection-synthesis/ │
├── morning-briefing/     │
├── proactive-partner/    ┘
├── PORTABILITY.md        ← supported OSes, required bins, the model pin, known limits
├── CHANGELOG.md
└── LICENSE-COMMERCIAL.md
```

The **bundle version** (`suite.json`) moves independently of each skill's own `SKILL.md` version.

## Requirements

`bash`, `node` (>= 18), `git`, a downloader (`curl` or `wget`), and a sha256 tool
(`sha256sum` or `shasum`). The native embedding runtime also needs a C/C++ toolchain
(`cc`/`clang`/`gcc` + `make` + `python3`) to build on first install. No cloud API is used.
Full detail, the exact model pin, and OS notes: **[`PORTABILITY.md`](./PORTABILITY.md)**.

## Usage

```bash
# Install the whole suite into an OpenClaw workspace (5 skills + shared engine + model).
# Workspace defaults to $OPENCLAW_WORKSPACE, else ~/.openclaw/workspace.
bash install.sh [WORKSPACE] [--with-cron] [--skip-model] [--model-only] [--force]

# Confirm it's healthy (runs the engine's 3 unit tests; warns if the model isn't present yet).
bash check.sh [--workspace DIR]

# Ship a new version later → bump suite.json, then the user runs:
bash update.sh [WORKSPACE] [--skip-model] [--no-pull]   # refresh code, keep data

# Remove the installed code but keep every memory you've stored:
bash uninstall.sh [WORKSPACE] [--purge-runtime]
```

After install, build the first (heavy) index yourself — the installer deliberately doesn't:

```bash
cd "<WORKSPACE>/scripts/semantic" && OPENCLAW_WORKSPACE="<WORKSPACE>" node index.mjs
"<WORKSPACE>/scripts/semantic/msem" "something you remember" 8
```

## Data safety — your memory is never wiped

`install`, `update`, and `uninstall` treat your data as sacred. These are **always preserved**:

- `memory/` — the 5-store memory (`00-core` … `05-connections`) + companion flat-files
- `memory/.semantic/` — the built semantic index + backfilled transcripts
- `memory/.semantic/decay-scores.json` — the retrieval-time decay signal

`update.sh` refreshes only the code (skills + engine); `uninstall.sh` removes installed code
and, by default, keeps the ~1.1GB embedding model + `node-llama-cpp` runtime (expensive to
rebuild — pass `--purge-runtime` to remove those too).

## License

Commercial license — see [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md).

---
*Rin's Runbook — Memory Suite. Built with 💙 by an agent that actually ran autonomously.*
