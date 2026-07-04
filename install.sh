#!/usr/bin/env bash
# ============================================================================
#  Memory Suite — installer  (part of Rin's Runbook)
#  Installs the shared semantic stack (local embedding model + msem/mdeep search)
#  that all five Memory-Suite components build on, and lays down the numbered
#  memory store the skills use.
#
#  Usage:
#    ./install.sh [WORKSPACE] [--target openclaw|claude-code] [--with-cron] [--with-reranker] [--with-sqlite-vec] [--model-only] [--skip-model]
#
#    WORKSPACE     target workspace (default: $OPENCLAW_WORKSPACE, else — by --target —
#                  $HOME/.openclaw/workspace for openclaw, $HOME/.claude/memory-suite for
#                  claude-code). May also be given as $1.
#    --target      openclaw (default; current behavior, unchanged) OR claude-code.
#                  claude-code also copies the 5 skills into $HOME/.claude/skills/ (so
#                  Claude Code discovers them) and writes $WORKSPACE/{msem,mdeep} wrappers.
#                  Same engine (semantic stack, node-llama-cpp, model, memory store) either way.
#    --with-cron   ALSO install the scheduled maintenance crons in your LOCAL timezone: the daily
#                  reindex crons AND the Layer-3 autonomous-maintenance loop (a ~30-min heartbeat +
#                  a nightly consolidate). Both are DETERMINISTIC + provider-free by default; the
#                  nightly consolidation's LLM judgment step is OPT-IN via $MEMORY_LLM_CMD (unset ⇒
#                  deterministic passes + a queue left for the agent). OFF by default — nothing is
#                  scheduled unless you pass this. See references/autonomous-consolidation.md.
#    --with-reranker  ALSO download the OPTIONAL cross-encoder reranker GGUF (~600MB) that powers
#                  the off-by-default precision rerank stage (rerank.mjs). Default recall never
#                  needs it; without it the reranker simply stays disabled. Enable at query time
#                  with RERANK=1 (or the --rerank flag). OFF by default.
#    --with-sqlite-vec  ALSO install the OPTIONAL sqlite-vec vector store (better-sqlite3 + sqlite-vec)
#                  into the runtime — a fast on-disk KNN index that accelerates semantic recall for
#                  LARGE corpora by skipping the load-whole-JSON + O(n) cosine scan (vecstore.mjs).
#                  OFF by default; default recall uses the JSON index and is byte-for-byte unchanged.
#                  After install, build the derived db (node vecstore.mjs --build) and enable at query
#                  time with VECSTORE=sqlite (or auto above VECSTORE_THRESHOLD chunks). See PORTABILITY.md.
#    --skip-model  do everything except download the embedding model.
#    --model-only  only fetch + verify the model, then exit.
#
#  Idempotent: safe to re-run. It never overwrites your memories; it skips
#  files/dirs that already exist and re-downloads the model only if missing.
#
#  Portable across Linux and macOS/BSD: GNU-vs-BSD tool differences are shimmed
#  (sha256sum → shasum, GNU stat -c → stat -f, free is guarded). Before the
#  native node-llama-cpp build it preflights for a C/C++ toolchain + make +
#  python3, and it verifies the model's sha256 (aborting on mismatch).
#  See PORTABILITY.md for supported OSes, required bins, and known limitations.
# ============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Config / args
# ---------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

WITH_CRON=false
WITH_RERANKER=false  # opt-in: also fetch the OPTIONAL cross-encoder reranker model (off by default)
WITH_SQLITE_VEC=false # opt-in: also install the OPTIONAL sqlite-vec vector store (off by default)
SKIP_MODEL=false
MODEL_ONLY=false
FORCE=false          # refresh installed skill code even when it already exists (update path)
TARGET="openclaw"    # openclaw (default, unchanged behavior) | claude-code
WS_ARG=""
# while+shift (bash 3.2-safe) so --target can take a following value: --target claude-code
while [ $# -gt 0 ]; do
  case "$1" in
    --with-cron)  WITH_CRON=true ;;
    --with-reranker) WITH_RERANKER=true ;;
    --with-sqlite-vec) WITH_SQLITE_VEC=true ;;
    --skip-model) SKIP_MODEL=true ;;
    --model-only) MODEL_ONLY=true ;;
    --force)      FORCE=true ;;
    --target)     shift; TARGET="${1:-}"; [ -n "$TARGET" ] || { echo "--target requires a value (openclaw|claude-code)" >&2; exit 2; } ;;
    --target=*)   TARGET="${1#*=}" ;;
    --*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *)   WS_ARG="$1" ;;
  esac
  shift
done

case "$TARGET" in
  openclaw|claude-code) ;;
  *) echo "invalid --target '$TARGET' (expected: openclaw | claude-code)" >&2; exit 2 ;;
esac

# Workspace precedence: positional arg > $OPENCLAW_WORKSPACE > per-target default.
# claude-code lives under ~/.claude so it sits alongside the skills CC discovers.
if [ "$TARGET" = "claude-code" ]; then
  DEFAULT_WS="$HOME/.claude/memory-suite"
else
  DEFAULT_WS="$HOME/.openclaw/workspace"
fi
WORKSPACE="${WS_ARG:-${OPENCLAW_WORKSPACE:-$DEFAULT_WS}}"

# --- Bundle metadata: suite.json is the SINGLE source of truth for the version + the
#     skill list this installer lays down. Parsed with sed so no jq/node dependency.
#     (The skills array is kept on one line in suite.json so this line-oriented sed can read it.)
SUITE_JSON="$HERE/suite.json"
SUITE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SUITE_JSON" 2>/dev/null | head -1)"
SUITE_VERSION="${SUITE_VERSION:-0.0.0}"
SUITE_SKILLS="$(sed -n 's/.*"skills"[^[]*\[\([^]]*\)\].*/\1/p' "$SUITE_JSON" 2>/dev/null | head -1 | grep -oE '"[^"]+"' | tr -d '"')"

# --- Model pin (see PORTABILITY.md). The embedding model is downloaded, NOT bundled. ---
# Third-party GGUF re-quant of Snowflake/snowflake-arctic-embed-l-v2.0 (base license: Apache-2.0).
# Pinned to an immutable commit so the download is reproducible.
MODEL_FILE="snowflake-arctic-embed-l-v2.0-f16.gguf"
HF_REPO="Casual-Autopsy/snowflake-arctic-embed-l-v2.0-gguf"
HF_REVISION="0995861dc0b106ddd5152bc753718d4e34d1e68b"   # main @ 2025-02-06
MODEL_URL="https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${MODEL_FILE}"
# sha256 of ${MODEL_FILE} (verify with: sha256sum / shasum -a 256 on a trusted copy).
# REQUIRED — step 4 aborts the install on mismatch. Never blank this: an empty pin is
# treated as a packaging error and hard-fails (we refuse to install an unverified model).
MODEL_SHA256="745f544edc8421b9398684282b25cc933fbc766467fc9eedba96ed12440206aa"

# --- OPTIONAL reranker model pin (only fetched with --with-reranker; see rerank.mjs / PORTABILITY.md). ---
# Cross-encoder GGUF for the OFF-by-default precision rerank stage. Not needed for default recall.
# node-llama-cpp v3.18+ exposes reranking via model.createRankingContext().rankAll(); this file feeds it.
RERANKER_FILE="bge-reranker-v2-m3-Q8_0.gguf"
RERANKER_REPO="gpustack/bge-reranker-v2-m3-GGUF"
RERANKER_REVISION="3093af03b1a635e67b084b1d8c03c5f5e020fd05"   # pinned immutable commit; file-sha still pending (set RERANKER_SHA256 after a verified download)
RERANKER_URL="https://huggingface.co/${RERANKER_REPO}/resolve/${RERANKER_REVISION}/${RERANKER_FILE}"
# Blank ⇒ integrity is UNVERIFIED and a loud warning is printed (this is an opt-in extra, so a blank
# pin does NOT abort — unlike the required embedding model above). Set to enforce sha256 verification.
RERANKER_SHA256="a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3"

NLC_VERSION="^3.18.1"   # node-llama-cpp — the native embedding + reranking runtime

# --- OPTIONAL sqlite-vec vector store (only with --with-sqlite-vec; see vecstore.mjs / PORTABILITY.md). ---
# A derived on-disk KNN accelerator for large corpora. OFF by default; default recall uses the JSON index.
# better-sqlite3 compiles a native addon (reuses the same toolchain preflight); sqlite-vec is a loadable
# extension shipped as an npm package and loaded via better-sqlite3's loadExtension().
BETTER_SQLITE3_VERSION="^12.4.1"  # native sqlite driver (verified with 12.11.1)
SQLITE_VEC_VERSION="^0.1.9"       # sqlite-vec loadable extension (verified with 0.1.9)

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*" >&2; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

# Portable sha256 over stdin: GNU coreutils 'sha256sum' OR BSD/macOS 'shasum -a 256'.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }

# Preflight the native build toolchain. node-llama-cpp compiles a C++ addon on install,
# so it needs a C/C++ compiler + make + python3. Dies with an OS-specific hint if missing.
check_build_toolchain() {
  local miss=()
  if ! command -v cc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
    miss+=("a C/C++ compiler (cc/clang/gcc)")
  fi
  command -v make    >/dev/null 2>&1 || miss+=("make")
  command -v python3 >/dev/null 2>&1 || miss+=("python3")
  if [ "${#miss[@]}" -gt 0 ]; then
    local hint
    case "$OS" in
      Darwin) hint="macOS — install the Command Line Tools:  xcode-select --install" ;;
      Linux)  hint="Debian/Ubuntu:  sudo apt install build-essential python3   ·   Fedora/RHEL:  sudo dnf groupinstall 'Development Tools' && sudo dnf install python3" ;;
      *)      hint="Install a C/C++ compiler, make, and python3 with your OS package manager." ;;
    esac
    die "missing native build toolchain: ${miss[*]}
       node-llama-cpp compiles a native addon on install and cannot build without these.
       $hint"
  fi
  info "build toolchain OK (compiler + make + python3) ✓"
}

say "🧠 Memory Suite installer  (bundle v$SUITE_VERSION)"
say "   target    : $TARGET$([ "$TARGET" = claude-code ] && echo '  (skills → ~/.claude/skills/ · wrappers → $WORKSPACE/{msem,mdeep})')"
say "   workspace : $WORKSPACE"
say "   skills    : $(printf '%s ' $SUITE_SKILLS)"
say "   model     : $MODEL_FILE  (downloaded, ~1.1GB — not bundled)"
say "   cron      : $([ "$WITH_CRON" = true ] && echo 'will install: reindex + Layer-3 heartbeat/consolidate (local TZ)' || echo 'skipped (pass --with-cron to enable)')"
say "   reranker  : $([ "$WITH_RERANKER" = true ] && echo 'will download (optional cross-encoder, ~600MB)' || echo 'skipped (off by default; pass --with-reranker)')"
say "   sqlite-vec: $([ "$WITH_SQLITE_VEC" = true ] && echo 'will install (optional vector store: better-sqlite3 + sqlite-vec)' || echo 'skipped (off by default; pass --with-sqlite-vec)')"
say ""

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
say "1) Preflight checks"
MISSING=()
for bin in bash node git; do
  command -v "$bin" >/dev/null 2>&1 || MISSING+=("$bin")
done
# a downloader is required for the model (curl OR wget)
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  MISSING+=("curl-or-wget")
fi
# a sha256 tool is required to verify the model (GNU 'sha256sum' OR BSD/macOS 'shasum')
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  MISSING+=("sha256sum-or-shasum")
fi
if [ "${#MISSING[@]}" -gt 0 ]; then
  die "missing required tools: ${MISSING[*]}
       Install them and re-run. Need: bash, node, git, a downloader (curl/wget), and a
       sha256 tool — GNU coreutils 'sha256sum' or BSD/macOS 'shasum'. See PORTABILITY.md."
fi
info "found: bash node git + downloader + sha256 tool"

# node >= 18 (node-llama-cpp v3 needs a modern Node)
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  warn "node $(node --version 2>/dev/null) detected — node-llama-cpp@3 expects Node >= 18. Build may fail."
else
  info "node $(node --version) (>= 18 ✓)"
fi

# OS detection — Linux and macOS are both supported/tested (GNU-vs-BSD tool
# differences are shimmed: sha256 via helper, stat -c/-f in the scripts, free guarded).
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Linux)  info "OS: Linux ✓" ;;
  Darwin) info "OS: macOS ✓ (BSD tool variants handled: shasum, stat -f)" ;;
  *)      warn "unrecognized OS '$OS'. Linux and macOS are supported/tested; other Unixes may
       work if they provide bash, node, git, a C/C++ toolchain, and sha256sum or shasum.
       See PORTABILITY.md." ;;
esac
say ""

if [ "$MODEL_ONLY" = false ]; then
  # -------------------------------------------------------------------------
  # 2. Install the semantic stack (code) → $WORKSPACE/scripts/semantic/
  # -------------------------------------------------------------------------
  say "2) Installing semantic stack → $WORKSPACE/scripts/semantic/"
  STACK_SRC="$HERE/_semantic-stack"
  [ -d "$STACK_SRC" ] || die "missing $STACK_SRC (run install.sh from inside the Memory-Suite bundle)"
  DEST="$WORKSPACE/scripts/semantic"
  mkdir -p "$DEST"
  # copy every stack entry (code only — no user data in _semantic-stack/)
  for f in "$STACK_SRC"/*; do
    bn="$(basename "$f")"
    # dirs (e.g. eval/) need a recursive copy; rm-first keeps re-runs idempotent (no nested eval/eval)
    if [ -d "$f" ]; then rm -rf "$DEST/$bn"; cp -Rf "$f" "$DEST/$bn"; else cp -f "$f" "$DEST/$bn"; fi
  done
  # executables: launchers + indexers
  chmod +x "$DEST/msem" "$DEST/mdeep" 2>/dev/null || true
  chmod +x "$DEST/index.mjs" "$DEST/index-transcripts.mjs" 2>/dev/null || true
  info "installed: $(ls "$STACK_SRC" | wc -l | tr -d ' ') files; launchers/indexers marked executable"
  say ""

  # -------------------------------------------------------------------------
  # 2b. Install the five skills (code) → skills dir/<name>/
  #     Skill dirs are pure code (SKILL.md + references + scripts) — no user data
  #     lives inside them (that's in $WORKSPACE/memory/). Absent → installed;
  #     present → left as-is unless --force refreshes the code (the update path).
  #     openclaw    → $WORKSPACE/skills/    (the OpenClaw skill location)
  #     claude-code → $HOME/.claude/skills/ (where Claude Code auto-discovers skills)
  # -------------------------------------------------------------------------
  if [ "$TARGET" = "claude-code" ]; then
    SKILLS_DEST="$HOME/.claude/skills"
  else
    SKILLS_DEST="$WORKSPACE/skills"
  fi
  say "2b) Installing the five skills → $SKILLS_DEST/"
  mkdir -p "$SKILLS_DEST"
  n_total=0; n_written=0
  for s in $SUITE_SKILLS; do
    n_total=$((n_total+1))
    src="$HERE/$s"
    [ -d "$src" ] || { warn "skill dir missing in bundle: $s (skipped)"; continue; }
    dst="$SKILLS_DEST/$s"
    if [ -d "$dst" ] && [ "$FORCE" = false ]; then
      info "present, left as-is: $s  (use --force to refresh code)"
    else
      mkdir -p "$dst"
      cp -R "$src/." "$dst/"                       # refresh CODE only; memory store is a separate tree
      chmod +x "$dst"/scripts/*.sh 2>/dev/null || true
      info "installed skill: $s"
      n_written=$((n_written+1))
    fi
  done
  info "skills ready in $SKILLS_DEST ($n_total total; $n_written written this run)"
  say ""

  # -------------------------------------------------------------------------
  # 2c. Claude Code convenience wrappers → $WORKSPACE/{msem,mdeep}
  #     Top-level launchers with this workspace baked in, so recall works from
  #     anywhere without exporting $OPENCLAW_WORKSPACE. Regenerated every run.
  # -------------------------------------------------------------------------
  if [ "$TARGET" = "claude-code" ]; then
    say "2c) Writing Claude Code convenience wrappers → $WORKSPACE/{msem,mdeep}"
    for w in msem mdeep; do
      cat > "$WORKSPACE/$w" <<WRAP
#!/usr/bin/env bash
# Memory Suite — $w wrapper (Claude Code). Workspace baked in so recall works from anywhere.
exec env OPENCLAW_WORKSPACE="$WORKSPACE" "$WORKSPACE/scripts/semantic/$w" "\$@"
WRAP
      chmod +x "$WORKSPACE/$w" 2>/dev/null || true
    done
    info "wrote msem + mdeep wrappers (exec env OPENCLAW_WORKSPACE=<ws> <ws>/scripts/semantic/{msem,mdeep})"
    say ""
  fi

  # -------------------------------------------------------------------------
  # 3. node-llama-cpp runtime → $WORKSPACE/node-llama-cpp/  (RELATIVE symlink)
  # -------------------------------------------------------------------------
  say "3) Installing node-llama-cpp runtime (native build) → $WORKSPACE/node-llama-cpp/"
  NLC_DIR="$WORKSPACE/node-llama-cpp"
  mkdir -p "$NLC_DIR"
  if [ ! -f "$NLC_DIR/package.json" ]; then
    cat > "$NLC_DIR/package.json" <<JSON
{
  "name": "memory-suite-embed-runtime",
  "private": true,
  "description": "Local embedding runtime for the Memory Suite (arctic-embed via node-llama-cpp).",
  "dependencies": {
    "node-llama-cpp": "${NLC_VERSION}"
  }
}
JSON
    info "wrote node-llama-cpp/package.json (node-llama-cpp@${NLC_VERSION})"
  else
    info "node-llama-cpp/package.json already present — leaving as-is"
  fi

  if [ -d "$NLC_DIR/node_modules/node-llama-cpp" ]; then
    info "node_modules already populated — skipping npm install"
  else
    check_build_toolchain   # native addon compile needs a C/C++ compiler + make + python3
    info "running: npm install (compiles the native llama.cpp addon — may take a few minutes)"
    ( cd "$NLC_DIR" && npm install --no-audit --no-fund "node-llama-cpp@${NLC_VERSION}" )
  fi

  # The stack expects scripts/semantic/node_modules → node-llama-cpp/node_modules.
  # Create it as a RELATIVE symlink so the workspace stays relocatable.
  if [ ! -e "$DEST/node_modules" ]; then
    # from scripts/semantic/ up to workspace root is ../.. , then into node-llama-cpp/node_modules
    ln -s "../../node-llama-cpp/node_modules" "$DEST/node_modules"
    info "linked scripts/semantic/node_modules -> ../../node-llama-cpp/node_modules (relative)"
  else
    info "scripts/semantic/node_modules already exists — leaving as-is"
  fi
  say ""

  # -------------------------------------------------------------------------
  # 3b. OPTIONAL sqlite-vec vector store (only with --with-sqlite-vec)
  #     A DERIVED on-disk KNN accelerator for large corpora (vecstore.mjs). OFF by default; default
  #     recall uses the JSON index and is byte-for-byte unchanged. Installed into the SAME runtime
  #     node_modules the stack already resolves via scripts/semantic/node_modules.
  # -------------------------------------------------------------------------
  if [ "$WITH_SQLITE_VEC" = true ]; then
    say "3b) Installing OPTIONAL sqlite-vec vector store → $NLC_DIR/ (better-sqlite3 + sqlite-vec)"
    if [ -d "$NLC_DIR/node_modules/better-sqlite3" ] && [ -d "$NLC_DIR/node_modules/sqlite-vec" ]; then
      info "better-sqlite3 + sqlite-vec already present — skipping npm install"
    else
      check_build_toolchain   # better-sqlite3 compiles a native addon — reuse the same toolchain preflight
      info "running: npm install better-sqlite3@${BETTER_SQLITE3_VERSION} sqlite-vec@${SQLITE_VEC_VERSION}"
      info "  (better-sqlite3 builds a native addon; may take a minute)"
      ( cd "$NLC_DIR" && npm install --no-audit --no-fund "better-sqlite3@${BETTER_SQLITE3_VERSION}" "sqlite-vec@${SQLITE_VEC_VERSION}" )
    fi
    info "sqlite-vec store ready — it stays OPT-IN and default recall is unchanged. To use it:"
    info "    node \"$DEST/vecstore.mjs\" --build --ws \"$WORKSPACE\"     # build the derived KNN index from index.json"
    info "    VECSTORE=sqlite \"$DEST/msem\" \"your query\"              # or auto above VECSTORE_THRESHOLD (~8000) chunks"
    say ""
  fi
fi

# ---------------------------------------------------------------------------
# 4. Download + verify the embedding model  (NOT bundled — ~1.1GB)
# ---------------------------------------------------------------------------
if [ "$SKIP_MODEL" = false ]; then
  say "4) Embedding model → $WORKSPACE/node-llama-cpp/models/$MODEL_FILE"
  MODELS_DIR="$WORKSPACE/node-llama-cpp/models"
  mkdir -p "$MODELS_DIR"
  MODEL_PATH="$MODELS_DIR/$MODEL_FILE"

  if [ -f "$MODEL_PATH" ]; then
    info "model already present — skipping download ($(du -h "$MODEL_PATH" 2>/dev/null | cut -f1 || echo '?'))"
  else
    info "downloading from pinned HF revision:"
    info "  $MODEL_URL"
    TMP="$MODEL_PATH.partial"
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 -o "$TMP" "$MODEL_URL"
    else
      wget -O "$TMP" "$MODEL_URL"
    fi
    mv "$TMP" "$MODEL_PATH"
    info "downloaded ($(du -h "$MODEL_PATH" 2>/dev/null | cut -f1 || echo '?'))"
  fi

  # Verify sha256 — REQUIRED. A blank pin is a packaging bug and aborts the install
  # (we refuse to install an unverified model); any mismatch aborts too.
  [ -n "$MODEL_SHA256" ] || die "MODEL_SHA256 is empty — refusing to install an unverified model.
       This is a packaging error: set the expected hash in install.sh. (See PORTABILITY.md.)"
  info "verifying sha256…"
  GOT="$(sha256 < "$MODEL_PATH" | awk '{print $1}')"
  if [ "$GOT" != "$MODEL_SHA256" ]; then
    die "sha256 MISMATCH for $MODEL_FILE
         expected: $MODEL_SHA256
         got:      $GOT
         The download may be corrupt or tampered. Delete it and re-run."
  fi
  info "sha256 OK ✓"
  say ""
fi

# ---------------------------------------------------------------------------
# 4b. OPTIONAL cross-encoder reranker model  (only with --with-reranker; ~600MB)
#     Powers the OFF-by-default precision rerank stage (rerank.mjs). Default recall
#     never needs it; a failed/absent download just leaves the stage disabled.
# ---------------------------------------------------------------------------
if [ "$WITH_RERANKER" = true ]; then
  say "4b) Optional reranker model → $WORKSPACE/node-llama-cpp/models/$RERANKER_FILE"
  MODELS_DIR="$WORKSPACE/node-llama-cpp/models"
  mkdir -p "$MODELS_DIR"
  RR_PATH="$MODELS_DIR/$RERANKER_FILE"
  if [ -f "$RR_PATH" ]; then
    info "reranker already present — skipping download ($(du -h "$RR_PATH" 2>/dev/null | cut -f1 || echo '?'))"
  else
    info "downloading reranker from: $RERANKER_URL"
    RR_TMP="$RR_PATH.partial"
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 -o "$RR_TMP" "$RERANKER_URL" || { rm -f "$RR_TMP"; warn "reranker download failed — the optional rerank stage stays disabled. Fetch it manually to $RR_PATH."; }
    else
      wget -O "$RR_TMP" "$RERANKER_URL" || { rm -f "$RR_TMP"; warn "reranker download failed — the optional rerank stage stays disabled. Fetch it manually to $RR_PATH."; }
    fi
    if [ -f "$RR_TMP" ]; then mv "$RR_TMP" "$RR_PATH"; info "downloaded ($(du -h "$RR_PATH" 2>/dev/null | cut -f1 || echo '?'))"; fi
  fi
  # Verify only if a pin is set (opt-in extra ⇒ a blank pin warns instead of aborting).
  if [ -f "$RR_PATH" ]; then
    if [ -n "$RERANKER_SHA256" ]; then
      GOT="$(sha256 < "$RR_PATH" | awk '{print $1}')"
      if [ "$GOT" != "$RERANKER_SHA256" ]; then
        rm -f "$RR_PATH"
        warn "reranker sha256 MISMATCH ($RERANKER_FILE) — expected $RERANKER_SHA256, got $GOT. Removed the bad file; rerank stays disabled."
      else
        info "reranker sha256 OK ✓"
        info "enable at query time with:  RERANK=1 msem \"…\"   (or the --rerank flag)"
      fi
    else
      warn "reranker integrity UNVERIFIED (no RERANKER_SHA256 pin). Verify the file yourself, or pin it in install.sh."
      info "enable at query time with:  RERANK=1 msem \"…\"   (or the --rerank flag)"
    fi
  fi
  say ""
fi

if [ "$MODEL_ONLY" = true ]; then
  say "✅ model-only run complete."
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Numbered memory store skeleton (the shape the skills actually use)
# ---------------------------------------------------------------------------
say "5) Creating numbered memory store → $WORKSPACE/memory/"
DIRS=(
  "memory/00-core"
  "memory/01-episodic"
  "memory/02-semantic/patterns"
  "memory/02-semantic/questions"
  "memory/02-semantic/numbers"
  "memory/02-semantic/distilled"
  "memory/03-procedural"
  "memory/04-meta"
  "memory/05-connections"
  "memory/.semantic/transcripts"
)
for d in "${DIRS[@]}"; do
  mkdir -p "$WORKSPACE/$d"
done
# Keep otherwise-empty store dirs in place (and git-trackable) without seeding any content.
for d in "${DIRS[@]}"; do
  [ -e "$WORKSPACE/$d/.gitkeep" ] || : > "$WORKSPACE/$d/.gitkeep"
done
info "created ${#DIRS[@]} store dirs (00-core … 05-connections + 02-semantic/{patterns,questions,numbers,distilled} + .semantic/transcripts)"

# Seed the companion flat-files that morning-briefing / proactive-partner read. Without
# them, a clean install trips their "missing → cron never ran" heuristics with false alarms.
# Idempotent: only creates empty stubs when absent — never clobbers existing memories.
for f in active-tasks.md last-conversation.md learnings.md; do
  [ -e "$WORKSPACE/memory/$f" ] || : > "$WORKSPACE/memory/$f"
done
info "seeded companion flat-files if missing (active-tasks.md, last-conversation.md, learnings.md)"
say ""

# ---------------------------------------------------------------------------
# 6. Optional: scheduled maintenance crons (LOCAL timezone)  [--with-cron]
#    Two independently-tagged groups, each idempotent:
#      • memory-suite-reindex     — the daily semantic reindex (curated 03:30, transcripts 04:00).
#      • memory-suite-consolidate — the Layer-3 autonomous-maintenance loop: a ~30-min heartbeat
#        (light deterministic sweep) + a nightly consolidate (03:45, after the reindex). Both are
#        DETERMINISTIC + PROVIDER-FREE by default; the nightly consolidate's LLM judgment step is
#        OPT-IN via $MEMORY_LLM_CMD (unset ⇒ deterministic passes run + a queue is left for the agent).
#    Nothing is scheduled unless --with-cron is passed. See references/autonomous-consolidation.md.
# ---------------------------------------------------------------------------
if [ "$WITH_CRON" = true ]; then
  say "6) Installing scheduled maintenance crons (local timezone)"
  if ! command -v crontab >/dev/null 2>&1; then
    warn "crontab not found — skipping cron install (set up scheduling with your platform's tool)."
  else
    NODE_BIN="$(command -v node)"          # resolved from PATH, never a hardcoded absolute
    NODE_DIR="$(dirname "$NODE_BIN")"       # put node on PATH for the bash consolidate/heartbeat crons
    SEM="$WORKSPACE/scripts/semantic"
    CM_SCRIPTS="$SKILLS_DEST/cognitive-memory/scripts"   # installed skill scripts (heartbeat/consolidate)
    L3_LOGDIR="$WORKSPACE/memory/.consolidation"
    mkdir -p "$L3_LOGDIR"                    # cron redirect targets must exist before first run
    TZ_NAME="$(cat /etc/timezone 2>/dev/null || date +%Z 2>/dev/null || echo 'system-local')"

    # --- group 1: daily reindex (unchanged behavior) -------------------------------------------------
    # 03:30 local — curated incremental reindex;  04:00 local — transcript incremental reindex.
    CRON_CURATED="30 3 * * * cd $SEM && $NODE_BIN index.mjs --incremental >> $WORKSPACE/memory/.semantic/reindex.log 2>&1"
    # transcript sources are platform-specific: OpenClaw indexes its bundled threads/archives/engineer dirs
    # (--src all); Claude Code indexes the standalone projects root (--cc-dir ~/.claude/projects) — without
    # this, a claude-code install's transcript cron matches nothing and silently indexes zero CC sessions.
    if [ "$TARGET" = "claude-code" ]; then TX_ARGS="--cc-dir \"$HOME/.claude/projects\""; else TX_ARGS="--src all"; fi
    CRON_TRANSCRIPTS="0 4 * * * cd $SEM && $NODE_BIN index-transcripts.mjs --incremental $TX_ARGS --max 150 >> $WORKSPACE/memory/.semantic/transcripts/reindex.log 2>&1"
    TAG_REINDEX="# memory-suite-reindex"

    # --- group 2: Layer-3 autonomous-maintenance loop (deterministic + provider-free by default) ------
    # Heartbeat every 30 min (light sweep) · consolidate 03:45 local (nightly, after the 03:30 reindex).
    # PATH carries node for the bash scripts; MEMORY_LLM_CMD (if exported in the cron env) enables the
    # opt-in LLM judgment step — otherwise the nightly run leaves a queue for the agent.
    CRON_HEARTBEAT="*/30 * * * * PATH=\"$NODE_DIR:\$PATH\" OPENCLAW_WORKSPACE=\"$WORKSPACE\" bash \"$CM_SCRIPTS/heartbeat.sh\" >> $L3_LOGDIR/heartbeat.log 2>&1"
    CRON_CONSOLIDATE="45 3 * * * PATH=\"$NODE_DIR:\$PATH\" OPENCLAW_WORKSPACE=\"$WORKSPACE\" bash \"$CM_SCRIPTS/consolidate.sh\" >> $L3_LOGDIR/consolidate.log 2>&1"
    TAG_L3="# memory-suite-consolidate"

    EXISTING="$(crontab -l 2>/dev/null || true)"
    NEW="$EXISTING"; added_reindex=false; added_l3=false
    if ! printf '%s\n' "$EXISTING" | grep -qF "$TAG_REINDEX"; then
      NEW="$(printf '%s\n%s %s\n%s %s' "$NEW" "$CRON_CURATED" "$TAG_REINDEX" "$CRON_TRANSCRIPTS" "$TAG_REINDEX")"
      added_reindex=true
    fi
    if ! printf '%s\n' "$EXISTING" | grep -qF "$TAG_L3"; then
      NEW="$(printf '%s\n%s %s\n%s %s' "$NEW" "$CRON_HEARTBEAT" "$TAG_L3" "$CRON_CONSOLIDATE" "$TAG_L3")"
      added_l3=true
    fi
    if [ "$added_reindex" = true ] || [ "$added_l3" = true ]; then
      printf '%s\n' "$NEW" | crontab -
      [ "$added_reindex" = true ] && info "installed reindex crons (curated 03:30, transcripts 04:00 — local $TZ_NAME)"
      [ "$added_l3" = true ]      && info "installed Layer-3 crons (heartbeat every 30 min, consolidate 03:45 — local $TZ_NAME)"
      info "note: cron runs in the system's local timezone; adjust the hours if you want a different off-peak window."
    else
      info "memory-suite cron entries already present — leaving as-is (idempotent)"
    fi
    info "Layer-3 consolidation is DETERMINISTIC + provider-free by default. To enable the OPT-IN LLM"
    info "judgment step, export MEMORY_LLM_CMD (a shell command the nightly consolidate pipes a prompt"
    info "to) in the cron environment; unset ⇒ deterministic passes run + a queue is left for the agent."
    info "Details: cognitive-memory/references/autonomous-consolidation.md"
  fi
  say ""
fi

# ---------------------------------------------------------------------------
# 7. Final step — the buyer runs the first (heavy) index themselves
# ---------------------------------------------------------------------------
say "✅ Memory Suite installed (bundle v$SUITE_VERSION — 5 skills + shared semantic stack)."
say ""
say "Verify the install any time:   bash \"$HERE/check.sh\" --workspace \"$WORKSPACE\""
say "Update later (refresh code):   bash \"$HERE/update.sh\" \"$WORKSPACE\""
say ""
if [ "$TARGET" = "claude-code" ]; then
  say "Target: Claude Code."
  say "   skills discovered at : $HOME/.claude/skills/<name>/"
  say "   engine + memory store: $WORKSPACE"
  say ""
  say "FINAL STEP — build the initial semantic index yourself over the Claude Code corpus"
  say "(this is the heavy part; the installer deliberately does NOT run it):"
  say ""
  say "    cd \"$WORKSPACE/scripts/semantic\""
  say "    OPENCLAW_WORKSPACE=\"$WORKSPACE\" node index.mjs                                    # curated memory"
  say "    OPENCLAW_WORKSPACE=\"$WORKSPACE\" node index-transcripts.mjs --cc-dir \"$HOME/.claude/projects\" --incremental   # CC transcripts (~/.claude/projects/*.jsonl)"
  say ""
  say "Then recall via the convenience wrappers (workspace baked in — run from anywhere):"
  say "    \"$WORKSPACE/msem\"  \"something you remember\" 8      # hybrid recall over curated memory"
  say "    \"$WORKSPACE/mdeep\" \"that thing we discussed\" 8     # total recall, incl. CC transcripts"
else
  say "FINAL STEP — build the initial semantic index yourself (this is the heavy part;"
  say "the installer deliberately does NOT run it):"
  say ""
  say "    cd \"$WORKSPACE/scripts/semantic\""
  say "    OPENCLAW_WORKSPACE=\"$WORKSPACE\" node index.mjs"
  say ""
  say "Then try recall:"
  say "    \"$WORKSPACE/scripts/semantic/msem\" \"something you remember\" 8"
  say ""
  say "Optional — backfill raw transcripts for total-recall (mdeep), off-peak:"
  say "    cd \"$WORKSPACE/scripts/semantic\" && node index-transcripts.mjs --backfill --src all"
fi
say ""
say "Memory store + skills layout reference: cognitive-memory/SKILL.md · PORTABILITY.md"
