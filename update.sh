#!/usr/bin/env bash
# ============================================================================
#  Memory Suite — updater  (part of Rin's Runbook)
#  Re-pull convention: refresh the bundle CODE, keep all your DATA.
#
#  Pulls the newest bundle (git pull, best-effort) and re-runs install.sh --force.
#  install.sh --force refreshes the CODE — the 5 skills + the shared semantic stack —
#  while PRESERVING every piece of your data:
#      • memory/                     the 5-store memory + companion flat-files
#      • memory/.semantic/           the built semantic index
#      • memory/.semantic/decay-scores.json   the retrieval-decay signal
#      • node-llama-cpp/models/*.gguf the embedding model (never re-downloaded if present)
#      • node-llama-cpp/node_modules the native runtime (never rebuilt if present)
#
#  Version is read from suite.json (the single source of truth).
#
#  Usage:  ./update.sh [WORKSPACE] [--skip-model] [--no-pull]
#    WORKSPACE     target workspace (default: $OPENCLAW_WORKSPACE, else
#                  $HOME/.openclaw/workspace). May be given as $1.
#    --skip-model  forward --skip-model to install.sh (don't touch the model at all).
#    --no-pull     re-apply local files without attempting `git pull`.
#
#  Idempotent + safe to run anytime. macOS + Linux portable (bash 3.2-safe).
# ============================================================================
set -euo pipefail

# Re-exec from a stable temp copy FIRST: a `git pull` can overwrite THIS file mid-run.
if [ "${MS_REEXEC:-}" != "1" ]; then
  _RD="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  t="$(mktemp)"; cp "$0" "$t"
  MS_REEXEC=1 MS_DIR_ORIG="$_RD" exec bash "$t" "$@"
fi

HERE="${MS_DIR_ORIG:?}"
SUITE_JSON="$HERE/suite.json"

DO_PULL=1
SKIP_MODEL=""
WS_ARG=""
for arg in "$@"; do
  case "$arg" in
    --no-pull)    DO_PULL=0 ;;
    --skip-model) SKIP_MODEL="--skip-model" ;;
    -h|--help)    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "unknown arg: $arg" >&2; exit 2 ;;
    *)   WS_ARG="$arg" ;;
  esac
done

ver(){ sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SUITE_JSON" 2>/dev/null | head -1; }
before="$(ver)"

echo "[1/2] pulling latest bundle  (current: v${before:-?})"
if [ "$DO_PULL" = 1 ] && [ -d "$HERE/.git" ] && command -v git >/dev/null 2>&1; then
  git -C "$HERE" pull --ff-only 2>/dev/null || echo "  (git pull skipped/failed — continuing with local files)"
else
  echo "  (skipped — not a git clone with a remote, or --no-pull given)"
fi

echo "[2/2] re-applying: install.sh --force  (refresh code, keep your data)"
bash "$HERE/install.sh" ${WS_ARG:+"$WS_ARG"} --force ${SKIP_MODEL:+"$SKIP_MODEL"}

after="$(ver)"
echo
echo "memory-suite updated: v${before:-?} -> v${after:-?}"
[ -f "$HERE/CHANGELOG.md" ] && { echo "--- latest changelog ---"; sed -n '1,16p' "$HERE/CHANGELOG.md"; }
