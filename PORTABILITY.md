# 🧭 Portability & Install Requirements — Memory Suite

*Part of **Rin's Runbook**. What `install.sh` needs, on which OSes, and what to expect.*

The Memory Suite is designed to install and run on both **Linux** (the production VPS)
and **macOS** (the dev platform). GNU-vs-BSD tool differences are shimmed in the shell
scripts and installer, so the same bundle works on either without edits.

## Supported operating systems

| OS | Status | Notes |
|----|--------|-------|
| **Linux** (glibc; Debian/Ubuntu, Fedora/RHEL, etc.) | ✅ Supported / production | GNU coreutils present by default. |
| **macOS** (Apple Silicon or Intel) | ✅ Supported / dev platform | BSD tool variants handled (`shasum`, `stat -f`); `free` is unavailable and gracefully skipped. |
| Other Unix (BSD, WSL, …) | ⚠️ Best-effort | Should work if it provides `bash`, `node`, `git`, a C/C++ toolchain, and `sha256sum` or `shasum`. Untested. |
| Windows (native, non-WSL) | ❌ Not supported | POSIX shell + native build toolchain assumptions do not hold. Use WSL2. |

## Required binaries

The installer preflights for these and aborts (with the list of what's missing) if any are absent:

- **`bash`** — the scripts target bash (arrays, `[[ ]]`). Tested down to bash 3.2 (macOS system bash).
- **`node`** — **≥ 18** (node-llama-cpp v3 requires a modern Node). Older Node warns and will likely fail the native build.
- **`git`**
- **A downloader** — `curl` **or** `wget` (for fetching the embedding model).
- **A sha256 tool** — GNU coreutils **`sha256sum`** **or** BSD/macOS **`shasum`** (for model integrity verification). The installer uses whichever is present via a portable helper.

## Native build toolchain (required)

The embedding runtime is [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp),
which **compiles a native C++ addon (llama.cpp) during `npm install`**. Before that step
the installer checks for a working toolchain and dies with an OS-specific hint if it's missing:

- **A C/C++ compiler** — `cc`, `clang`, or `gcc`
- **`make`**
- **`python3`** (node-gyp needs it)

Install the toolchain up front:

- **macOS:** `xcode-select --install` (installs the Command Line Tools: `clang`, `make`, `python3`).
- **Debian/Ubuntu:** `sudo apt install build-essential python3`
- **Fedora/RHEL:** `sudo dnf groupinstall 'Development Tools' && sudo dnf install python3`

## The local embedding model

Recall is **local and private** — embeddings run on your host, with no cloud API call. The
model is **downloaded, not bundled** (it's large), then integrity-verified before use.

| Field | Value |
|-------|-------|
| File | `snowflake-arctic-embed-l-v2.0-f16.gguf` |
| Size | ~1.08 GB |
| sha256 | `745f544edc8421b9398684282b25cc933fbc766467fc9eedba96ed12440206aa` |
| Source | Hugging Face repo `Casual-Autopsy/snowflake-arctic-embed-l-v2.0-gguf`, pinned to an immutable revision |
| Base model | Snowflake `snowflake-arctic-embed-l-v2.0` (base license: Apache-2.0); third-party GGUF re-quant |
| Installed to | `<workspace>/node-llama-cpp/models/snowflake-arctic-embed-l-v2.0-f16.gguf` |

### How it's fetched + verified

1. `install.sh` downloads the file from the **pinned** HF revision (so the bytes are reproducible)
   using `curl` (or `wget`), to a `.partial` file that is renamed on completion.
2. It then computes the sha256 (`sha256sum`/`shasum`) and compares it to the pinned
   `MODEL_SHA256` above. **On mismatch the install aborts** — a corrupt or tampered download
   never gets used. A blank pin is treated as a packaging error and also aborts (the installer
   refuses to install an unverified model).
3. Re-runs skip the download if the file already exists (idempotent).

You can fetch/verify the model on its own with `./install.sh --model-only`, or skip it with
`--skip-model` (e.g. to wire the model in manually).

## The OPTIONAL reranker model (off by default)

Retrieval has an **optional** third stage — a local **cross-encoder reranker** that re-scores the top
candidates for extra precision (see `_semantic-stack/rerank.mjs`). It is **off by default and not
installed by default**: default recall (`msem`/`mdeep`) is byte-for-byte unchanged without it, and if
the model or the flag is absent the stage silently no-ops. Nothing here is required for normal use.

| Field | Value |
|-------|-------|
| Runtime | **`node-llama-cpp` v3.18+** — the *same* engine already used for embeddings. Reranking is exposed via `model.createRankingContext()` → `ctx.rankAll(query, documents)` (returns a 0–1 relevance score per document). Verified present in the installed v3.19 runtime. |
| Model | a GGUF cross-encoder, default **`bge-reranker-v2-m3-Q8_0.gguf`** (~600MB) |
| Installed to | `<workspace>/node-llama-cpp/models/bge-reranker-v2-m3-Q8_0.gguf` |
| Path override | `RERANK_MODEL=/abs/path/to/reranker.gguf` |
| Enable at query time | `RERANK=1 msem "…"` **or** `msem "…" --rerank` (also on `mdeep`) |

### How it's fetched

`./install.sh --with-reranker` downloads the GGUF into the models dir above (skipped if already
present). Because this is an **opt-in extra**, integrity is verified **only if** a `RERANKER_SHA256`
pin is set in `install.sh`; with a blank pin the installer downloads but prints a loud
**UNVERIFIED** warning (unlike the *required* embedding model, whose blank pin hard-fails). A
packager who wants enforced integrity should pin an immutable HF revision **and** the sha256. You can
also skip the installer entirely and just drop a reranker GGUF into the models dir yourself.

## macOS/BSD shims (what was made portable)

| Concern | GNU / Linux | Portable handling |
|---------|-------------|-------------------|
| sha256 | `sha256sum` | Helper: `sha256sum` if present, else `shasum -a 256` (`install.sh`, `smart-distill/scripts/distill-store.sh`). |
| File mtime | `stat -c %Y` | `stat -c %Y … 2>/dev/null || stat -f %m` (`proactive-partner/scripts/proactive-scan.sh`). |
| Memory stats | `free -m` | Guarded with `command -v free`; prints "(unavailable on this OS)" on macOS (`morning-briefing/scripts/generate-briefing.sh`). |
| Scheduling | `crontab` | Optional (only with `--with-cron`) and skipped with a warning if `crontab` is absent. |

## Known limitations

- **`--with-cron` (optional):** installs `crontab` entries in the **system local timezone**; on
  hosts without `crontab` it's skipped with a warning — schedule the reindexers with your own tool
  (e.g. `launchd` on macOS, `systemd` timers on Linux). Cron is **off by default**.
- **`free -m`** has no macOS equivalent wired in — the morning briefing's memory line reads
  "(unavailable on this OS)" there. Everything else in the briefing works.
- **Native build:** the first `npm install` compiles llama.cpp and can take several minutes and
  significant RAM/CPU. Prebuilt binaries may be fetched when available; otherwise the toolchain
  above is mandatory.
- **Disk:** budget ~1.1 GB for the model plus the compiled `node_modules`.
- **The heavy first index is not run for you** — after install, build it yourself
  (`node index.mjs` in `scripts/semantic/`), by design.

## Clean-machine checklist

1. Install the native toolchain (`xcode-select --install` on macOS; `build-essential python3` on Debian/Ubuntu).
2. Ensure `node --version` ≥ 18.
3. `./install.sh` (add `--with-cron` only if you want scheduled reindexing).
4. Confirm `sha256 OK ✓` printed during the model step.
5. Build the initial index, then try `msem "<query>"`.

See also: `README.md` (overview) and `cognitive-memory/SKILL.md` (memory store + skills layout).
