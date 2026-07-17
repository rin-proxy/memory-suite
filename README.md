# 🧠 memory-suite — the complete memory & recall system for autonomous AI agents

> 🔒 **Diaudit & aman** — bundle-check hijau (semua unit test lolos) · berjalan **lokal & offline**; satu-satunya akses jaringan = mengunduh model embedding saat install (dari Hugging Face, di-pin & diverifikasi SHA-256). Semua kode terbuka. _(Audit keamanan: 2026-07-17)_

*Part of **Rin's Runbook**. One bundle, five skills, one shared local engine.*

An agent is only as good as what it remembers. The Memory Suite is the full stack —
**store it, distill it, connect it, surface it, act on it** — packaged here as a single
git-ready bundle that installs, updates, checks, and uninstalls as one unit.

## In plain English

Your AI agent forgets everything between sessions — so you keep re-explaining who you are, what you already decided, and where you left off. memory-suite fixes that. It gives the agent a real memory that:

- **Remembers what matters** — decisions, preferences, facts — and saves the important things as they come up.
- **Finds them again instantly** — fast local search over everything it has stored, plus your raw conversation history, so nothing is truly lost (you can recall a detail even after the context window was trimmed, or "compacted").
- **Stays private** — the whole thing runs on your own machine with a local model. No cloud, nothing leaves your computer, works offline.
- **Gets better over time — and actually *learns*** — it de-duplicates near-identical notes, ranks what you actually use, resurfaces things you'd forgotten, connects ideas across topics, and **discovers the durable patterns across everything you've told it** (recurring themes it promotes into always-present knowledge). It does this **on your machine with zero extra AI cost** — no daily model bill, no Docker, no vector database, and it keeps learning even when your AI provider is down. (Learning memory systems that run an LLM over a Docker/vector stack burn tokens continuously and go dark in an outage; this doesn't.)

In one line: long-term memory + instant recall + provider-free learning for your agent — so it stops forgetting, gets sharper on its own, and you stop repeating yourself.

## Why install it

**If you use Claude Code** — give your local Claude Code a memory that persists across sessions: it recalls past decisions and can search your entire Claude Code history to answer questions like "what did we decide about X three weeks ago?". Everything is indexed locally, and secrets are stripped before indexing. Install with `install.sh --target claude-code`.

**If you run an OpenClaw agent** — drop in the full memory stack as five skills sharing one engine: the agent remembers across restarts, survives context compaction, keeps its own memory tidy, and can brief you each day. Install with `git clone … && bash install.sh` — it's a bundle set up by its own installer (see Platforms below).

Same engine, both platforms, all local and private.

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

**Memory that gets sharper over time — provider-free (`mlearn`).** Beyond store + recall, the engine
*learns*: `mlearn rebuild` reinforces the connections that keep recurring across your notes (Hebbian),
clusters the durable ones, and **promotes** stable patterns into themed insights — all from the vectors
already in the index, so it needs **no LLM, no tokens, no Docker, and keeps working during a provider
outage** (unlike LLM-pipeline memory systems that go dark when the model is down). `mlearn block` emits
an injectable "Learned patterns" section for `MEMORY.md`, so the patterns influence behavior every turn.
Run `mlearn rebuild` on your reindex cron; an optional LLM pass can later phrase an insight into prose.

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

## Platforms

The bundle is **dual-platform**: the *same* local engine (arctic-embed via `node-llama-cpp`; `msem` +
`mdeep` search) runs on both **OpenClaw** and **Claude Code**, and `install.sh` targets either. Recall is
always **local, private, and redacted before embedding** — secrets are scrubbed on the way into the index,
and no cloud API is called on either platform.

> **This is a bundle** (5 skills + a shared local engine + a downloaded model), **not** a single-skill repo.
> Install it with its own **`install.sh`** — **not** `openclaw skills install git:…`. That command only handles a
> single-skill repo with a root `SKILL.md`; this repo has none (5 skills live in subfolders), and it would skip
> the engine build + the ~1GB model download, so recall wouldn't work. First clone it:
>
> ```bash
> git clone https://github.com/rin-proxy/memory-suite.git && cd memory-suite
> ```

**OpenClaw** (default target):

```bash
bash install.sh [WORKSPACE]      # default workspace: $OPENCLAW_WORKSPACE, else ~/.openclaw/workspace
# then build the first index + reload the gateway:
cd "${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}/scripts/semantic" && node index.mjs
openclaw gateway restart
```

**Claude Code:**

```bash
bash install.sh --target claude-code
# Workspace defaults to ~/.claude/memory-suite (override with a positional arg or $OPENCLAW_WORKSPACE).
# Installs the same engine + model + memory store, copies the 5 skills into ~/.claude/skills/ so
# Claude Code discovers them, and writes convenience wrappers <ws>/msem and <ws>/mdeep.
```

Both targets share one **deep-recall** engine. `mdeep` runs the hybrid search over curated memory **plus raw
conversation transcripts**, and it indexes **both** OpenClaw history **and** Claude Code sessions
(`~/.claude/projects/*.jsonl`) — via `index-transcripts.mjs --cc-dir "$HOME/.claude/projects"` (or
`--src cc`). So a detail from any past session on either platform stays recoverable; nothing said is lost.

## Usage

```bash
# Install the whole suite (5 skills + shared engine + model). See "Platforms" above for OpenClaw vs Claude Code.
# Workspace defaults to $OPENCLAW_WORKSPACE, else the per-target default (~/.openclaw/workspace or ~/.claude/memory-suite).
bash install.sh [WORKSPACE] [--target openclaw|claude-code] [--with-cron] [--with-reranker] [--with-sqlite-vec] [--skip-model] [--model-only] [--force]

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

## Optional: cross-encoder reranker (precision boost, OFF by default)

Recall runs in two stages you can *opt into a third*:

1. **Hybrid** — semantic (arctic-embed) + keyword, fused with Reciprocal Rank Fusion.
2. **Decay re-rank** — a retrieval-time multiplier on how a memory has actually been used.
3. **Cross-encoder rerank** *(optional, off by default)* — re-scores the top ~50 candidates by reading
   the query and each candidate **together**, which is more precise than the bi-encoder cosine that
   produced stage 1. It only reorders that head, then the usual top-k is taken.

**Default behavior is unchanged.** With the flag off *or* the reranker model absent, `msem`/`mdeep`
return **exactly** today's ranking — byte-for-byte. The stage never fails a search: any missing
model, missing runtime, or error silently falls back to the stage-2 order.

**Turn it on** (needs the reranker model — see below):

```bash
RERANK=1 msem "your query"      # env flag
msem "your query" --rerank      # …or the CLI flag (also works on mdeep)
```

**What it needs to actually run:**

| Piece | Value |
|-------|-------|
| Runtime | `node-llama-cpp` **v3.18+** (already the suite's engine) — reranking via `model.createRankingContext().rankAll()` |
| Model | a GGUF cross-encoder, default **`bge-reranker-v2-m3-Q8_0.gguf`** (~600MB) |
| Install | `bash install.sh --with-reranker` (optional; downloads the model) — or drop the GGUF into `<workspace>/node-llama-cpp/models/` yourself |
| Override path | `RERANK_MODEL=/path/to/reranker.gguf` |

Without the model present, `--with-reranker` un-run, the flag simply no-ops. Full model/runtime
detail is in **[`PORTABILITY.md`](./PORTABILITY.md)**.

## Optional: sqlite-vec vector store (scaling, OFF by default)

At small/medium corpus sizes, `msem`/`mdeep` load the whole `index.json` and cosine-score **every** chunk
in JS. That's simple and fast enough for thousands of chunks — but it's `O(n)` per query and grows with the
corpus. For **large** stores you can opt into a **sqlite-vec** backend: a derived, on-disk KNN index that
finds the nearest chunks in native C (memory-mapped, no whole-JSON load) and hands just that candidate set
to the rest of the pipeline.

**It's a query-time *read accelerator*, and recall is IDENTICAL.** `index.json` stays the source of truth
and the write path (`index.mjs` / `index-transcripts.mjs`) is unchanged — the sqlite db is *built from*
`index.json`. Only the **semantic-candidate fetch** changes backend; the **keyword + RRF + decay + optional
rerank** stages run exactly as before. Candidates carry their stored vector (bit-identical to `index.json`'s)
and are re-scored with the *same* `cosine()`, and their original `index.json` order is preserved for
tie-breaks — so the ranking is **byte-for-byte the same** as the JSON path (verified: `VECSTORE=sqlite` vs
`VECSTORE=json` produce identical ranked rows).

**Default behavior is unchanged.** With the flag off *or* the deps absent *or* the db missing, `msem`/`mdeep`
run the exact JSON path they always have. The accelerator **never fails a search**: any missing dep, missing
db, dimension mismatch, or error silently falls back to JSON.

**Install it (opt-in — not installed by default):**

```bash
bash install.sh --with-sqlite-vec        # adds better-sqlite3 + sqlite-vec to the runtime (native build)
node vecstore.mjs --build --ws "<WORKSPACE>"   # build the derived KNN db from index.json (also --incremental)
```

**Turn it on** (per query, once the db is built):

```bash
VECSTORE=sqlite msem "your query"        # explicit opt-in
# …or it auto-enables once the corpus has ≥ VECSTORE_THRESHOLD chunks (default 8000)
```

| Knob | Meaning |
|------|---------|
| `VECSTORE=sqlite` / `json` | force the sqlite backend / force the JSON path (default is JSON, auto above the threshold) |
| `VECSTORE_THRESHOLD` | chunk count at/above which the backend auto-enables when `VECSTORE` is unset (default `8000`) |
| `VECSTORE_DB` | path to the db (default `<workspace>/memory/.semantic/vec.sqlite`) |
| `VECSTORE_CANDIDATES` | candidate-pool size fetched per query (default generous: `max(k×25, 400)`) |

Rebuild the db (or `--incremental`) whenever you rebuild `index.json`; if it's stale or absent the engine just
falls back to JSON. Full dependency/OS detail is in **[`PORTABILITY.md`](./PORTABILITY.md)**.

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
