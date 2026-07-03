#!/usr/bin/env bash
# ============================================================================
#  Memory Suite — installer  (part of Rin's Runbook)
#  Installs the shared semantic stack (local embedding model + msem/mdeep search)
#  that all five Memory-Suite components build on, and lays down the numbered
#  memory store the skills use.
#
#  Usage:
#    ./install.sh [WORKSPACE] [--with-cron] [--model-only] [--skip-model]
#
#    WORKSPACE     target OpenClaw workspace (default: $OPENCLAW_WORKSPACE,
#                  else $HOME/.openclaw/workspace). May also be given as $1.
#    --with-cron   ALSO install daily reindex crons in your LOCAL timezone
#                  (OFF by default — nothing is scheduled unless you pass this).
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
SKIP_MODEL=false
MODEL_ONLY=false
FORCE=false          # refresh installed skill code even when it already exists (update path)
WS_ARG=""
for arg in "$@"; do
  case "$arg" in
    --with-cron)  WITH_CRON=true ;;
    --skip-model) SKIP_MODEL=true ;;
    --model-only) MODEL_ONLY=true ;;
    --force)      FORCE=true ;;
    --*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)   WS_ARG="$arg" ;;
  esac
done

# Workspace precedence: positional arg > $OPENCLAW_WORKSPACE > $HOME/.openclaw/workspace
WORKSPACE="${WS_ARG:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"

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
MODEL_SHA256="a88849f37c28790a29495d14d9ea0d391a51611daf47fa30316abf34d772a281"

NLC_VERSION="^3.18.1"   # node-llama-cpp — the native embedding runtime

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
say "   workspace : $WORKSPACE"
say "   skills    : $(printf '%s ' $SUITE_SKILLS)"
say "   model     : $MODEL_FILE  (downloaded, ~1.1GB — not bundled)"
say "   cron      : $([ "$WITH_CRON" = true ] && echo 'will install (local TZ)' || echo 'skipped (pass --with-cron to enable)')"
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
  # copy every stack file (code only — there are no data files in _semantic-stack/)
  for f in "$STACK_SRC"/*; do
    bn="$(basename "$f")"
    cp -f "$f" "$DEST/$bn"
  done
  # executables: launchers + indexers
  chmod +x "$DEST/msem" "$DEST/mdeep" 2>/dev/null || true
  chmod +x "$DEST/index.mjs" "$DEST/index-transcripts.mjs" 2>/dev/null || true
  info "installed: $(ls "$STACK_SRC" | wc -l | tr -d ' ') files; launchers/indexers marked executable"
  say ""

  # -------------------------------------------------------------------------
  # 2b. Install the five skills (code) → $WORKSPACE/skills/<name>/
  #     Skill dirs are pure code (SKILL.md + references + scripts) — no user data
  #     lives inside them (that's in $WORKSPACE/memory/). Absent → installed;
  #     present → left as-is unless --force refreshes the code (the update path).
  # -------------------------------------------------------------------------
  say "2b) Installing the five skills → $WORKSPACE/skills/"
  SKILLS_DEST="$WORKSPACE/skills"
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
# 6. Optional: daily reindex crons (LOCAL timezone)  [--with-cron]
# ---------------------------------------------------------------------------
if [ "$WITH_CRON" = true ]; then
  say "6) Installing daily reindex crons (local timezone)"
  if ! command -v crontab >/dev/null 2>&1; then
    warn "crontab not found — skipping cron install (set up scheduling with your platform's tool)."
  else
    NODE_BIN="$(command -v node)"   # resolved from PATH, never a hardcoded absolute
    SEM="$WORKSPACE/scripts/semantic"
    TZ_NAME="$(cat /etc/timezone 2>/dev/null || date +%Z 2>/dev/null || echo 'system-local')"
    # 03:30 local — curated incremental reindex;  04:00 local — transcript incremental reindex.
    CRON_CURATED="30 3 * * * cd $SEM && $NODE_BIN index.mjs --incremental >> $WORKSPACE/memory/.semantic/reindex.log 2>&1"
    CRON_TRANSCRIPTS="0 4 * * * cd $SEM && $NODE_BIN index-transcripts.mjs --incremental --src all --max 150 >> $WORKSPACE/memory/.semantic/transcripts/reindex.log 2>&1"
    TAG="# memory-suite-reindex"
    EXISTING="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$EXISTING" | grep -qF "$TAG"; then
      info "memory-suite cron entries already present — leaving as-is (idempotent)"
    else
      {
        printf '%s\n' "$EXISTING"
        printf '%s %s\n' "$CRON_CURATED" "$TAG"
        printf '%s %s\n' "$CRON_TRANSCRIPTS" "$TAG"
      } | crontab -
      info "installed 2 crons (curated 03:30, transcripts 04:00 — your local time, $TZ_NAME)"
      info "note: cron runs in the system's local timezone; adjust the hours if you want a different off-peak window."
    fi
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
say ""
say "Memory store + skills layout reference: cognitive-memory/SKILL.md · PORTABILITY.md"
