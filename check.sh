#!/usr/bin/env bash
# ============================================================================
#  Memory Suite — health check  (part of Rin's Runbook)
#  Validates the bundle is correctly assembled and its engine actually works.
#
#  HARD checks (any failure ⇒ non-zero exit):
#    • suite.json present with a semver version
#    • all 5 skills have a SKILL.md
#    • the shared _semantic-stack scripts are present
#    • the pure unit tests pass  (transcripts / decay / surface / rerank / vecstore —
#      no model, no network, no node_modules required; vecstore's real
#      sqlite-vec round-trip self-skips unless the opt-in deps are installed)
#
#  SOFT checks (warn only, never fail):
#    • embedding model present in the workspace runtime
#    • node available to run the tests
#
#  macOS + Linux portable (bash 3.2-safe). Run it after install, or before you ship.
#
#  Usage:  ./check.sh [--workspace DIR]
# ============================================================================
set -uo pipefail   # deliberately NOT -e: run every check, then report.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_JSON="$HERE/suite.json"
STACK="$HERE/_semantic-stack"
WS="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WS="$2"; shift 2;;
    -h|--help)   grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

PASS=0; FAIL=0
pass(){ printf '  \033[32m[pass]\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail(){ printf '  \033[31m[FAIL]\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warn(){ printf '  \033[33m[warn]\033[0m %s\n' "$*"; }

printf '\033[1m== Memory Suite check: %s ==\033[0m\n' "$HERE"

# ── suite.json + version (the single source of truth) ─────────────────────────
if [ -f "$SUITE_JSON" ]; then
  VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SUITE_JSON" | head -1)"
  case "$VER" in
    [0-9]*.[0-9]*.[0-9]*) pass "suite.json version present (v$VER)";;
    *) fail "suite.json version missing / not semver";;
  esac
else
  fail "suite.json missing (the single version source)"
fi

SKILLS="$(sed -n 's/.*"skills"[^[]*\[\([^]]*\)\].*/\1/p' "$SUITE_JSON" 2>/dev/null | head -1 | grep -oE '"[^"]+"' | tr -d '"')"
[ -n "$SKILLS" ] || SKILLS="cognitive-memory smart-distill connection-synthesis morning-briefing proactive-partner"

# ── 1) the five skills: SKILL.md present in the bundle ────────────────────────
i=0
for s in $SKILLS; do
  i=$((i+1))
  if [ -f "$HERE/$s/SKILL.md" ]; then pass "skill $i: $s/SKILL.md"; else fail "skill $s: SKILL.md missing"; fi
done

# ── 2) shared semantic stack: key scripts present ─────────────────────────────
for f in index.mjs index-transcripts.mjs hybrid.mjs deep.mjs store.mjs common.mjs \
         decay.mjs rerank.mjs vecstore.mjs surface.mjs transcripts.mjs redact.mjs \
         links.mjs learn.mjs FLYWHEEL.md embed-daemon.mjs msem mdeep memd mlearn; do
  if [ -e "$STACK/$f" ]; then pass "stack: _semantic-stack/$f"; else fail "stack: missing _semantic-stack/$f"; fi
done

# ── 3) run the pure unit tests (no model / no network / no node_modules) ──────
if command -v node >/dev/null 2>&1; then
  for t in test-transcripts test-decay test-surface test-rerank test-vecstore test-links test-learn; do
    if [ ! -f "$STACK/$t.mjs" ]; then fail "unit tests: $t.mjs missing"; continue; fi
    out="$( cd "$STACK" && node "$t.mjs" 2>&1 )"; rc=$?
    if [ "$rc" -eq 0 ]; then
      pass "unit tests: $(printf '%s' "$out" | tail -1 | sed 's/^[[:space:]]*//')"
    else
      fail "unit tests: $t FAILED"
      printf '%s\n' "$out" | tail -3 | sed 's/^/        /'
    fi
  done
else
  warn "node not on PATH — skipped the 3 unit tests (install Node >= 18 to run them)"
fi

# ── 4) soft: embedding model presence in the workspace runtime ────────────────
MODELS_DIR="$WS/node-llama-cpp/models"
if ls "$MODELS_DIR"/*.gguf >/dev/null 2>&1; then
  pass "embedding model present ($(basename "$(ls "$MODELS_DIR"/*.gguf 2>/dev/null | head -1)"))"
else
  warn "embedding model not found under $MODELS_DIR — run 'bash install.sh' (recall won't work until then)"
fi

echo
if [ "$FAIL" -gt 0 ]; then printf '\033[31m%d failed\033[0m, %d passed\n' "$FAIL" "$PASS"; exit 1; fi
printf '\033[32mall %d checks passed\033[0m\n' "$PASS"
