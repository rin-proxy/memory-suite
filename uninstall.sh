#!/usr/bin/env bash
# ============================================================================
#  Memory Suite — uninstaller  (part of Rin's Runbook)
#  Removes the installed skill + engine CODE from the workspace, but NEVER your data.
#
#  ALWAYS PRESERVED (your memory is yours):
#      • memory/                                the 5-store memory + companion flat-files
#      • memory/.semantic/                      the built semantic index + transcripts
#      • memory/.semantic/decay-scores.json     the retrieval-decay signal
#
#  REMOVED (code that install.sh laid down):
#      • skills/<name>/            the 5 installed skill dirs
#      • scripts/semantic/         the shared semantic-stack engine (+ its node_modules symlink)
#
#  KEPT BY DEFAULT (expensive to rebuild; pass --purge-runtime to also remove):
#      • node-llama-cpp/           the native runtime + the ~1.1GB embedding model
#
#  Idempotent (skips what's already gone). macOS + Linux portable (bash 3.2-safe).
#
#  Usage:  ./uninstall.sh [WORKSPACE] [--purge-runtime]
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_JSON="$HERE/suite.json"

WS_ARG=""
PURGE_RT=false
for arg in "$@"; do
  case "$arg" in
    --purge-runtime) PURGE_RT=true ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "unknown arg: $arg" >&2; exit 2 ;;
    *) WS_ARG="$arg" ;;
  esac
done
WORKSPACE="${WS_ARG:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
SKILLS="$(sed -n 's/.*"skills"[^[]*\[\([^]]*\)\].*/\1/p' "$SUITE_JSON" 2>/dev/null | head -1 | grep -oE '"[^"]+"' | tr -d '"')"
[ -n "$SKILLS" ] || SKILLS="cognitive-memory smart-distill connection-synthesis morning-briefing proactive-partner"

gone(){ printf '  \033[32m[removed]\033[0m %s\n' "$*"; }
skip(){ printf '  \033[33m[skip]\033[0m    %s\n' "$*"; }
keep(){ printf '  \033[36m[kept]\033[0m    %s\n' "$*"; }

echo "🧹 Memory Suite uninstall  (workspace: $WORKSPACE)"
echo

# 1) the five installed skills (code)
for s in $SKILLS; do
  d="$WORKSPACE/skills/$s"
  if [ -d "$d" ]; then rm -rf "$d"; gone "skills/$s"; else skip "skills/$s (absent)"; fi
done
rmdir "$WORKSPACE/skills" 2>/dev/null || true   # only if now empty (leave other skills alone)

# 2) the shared semantic engine (code + the relative node_modules symlink)
if [ -e "$WORKSPACE/scripts/semantic" ]; then rm -rf "$WORKSPACE/scripts/semantic"; gone "scripts/semantic/ (engine code)"; else skip "scripts/semantic/ (absent)"; fi
rmdir "$WORKSPACE/scripts" 2>/dev/null || true

# 3) the heavy runtime + model — kept unless --purge-runtime
if [ "$PURGE_RT" = true ]; then
  if [ -d "$WORKSPACE/node-llama-cpp" ]; then rm -rf "$WORKSPACE/node-llama-cpp"; gone "node-llama-cpp/ (runtime + embedding model)"; else skip "node-llama-cpp/ (absent)"; fi
else
  [ -d "$WORKSPACE/node-llama-cpp" ] && keep "node-llama-cpp/ (runtime + ~1.1GB model) — pass --purge-runtime to remove"
fi

echo
echo "PRESERVED — your data, never touched by uninstall:"
keep "memory/                                the 5-store memory + companion flat-files"
keep "memory/.semantic/                      the built semantic index + transcripts"
keep "memory/.semantic/decay-scores.json     the retrieval-decay signal"
echo
echo "Reinstall anytime:  bash \"$HERE/install.sh\" \"$WORKSPACE\""
