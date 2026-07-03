#!/usr/bin/env bash
# precompact-capture.sh — Claude Code PreCompact hook (LAYER 2 · provider-free).
#
# Claude Code fires PreCompact with a JSON payload on stdin BEFORE it trims the context window. This hook
# reads the transcript that payload points at and promotes that about-to-be-lost window into the INDEXED
# memory store: memory/.compaction/snapshot-<ts>.md (recallable via msem/mdeep) + a curation queue of
# high-signal lines for the agent to triage. The snapshot is pure code; judging what to permanently keep
# is agent-driven (drain the queue via scripts/save.sh).
#
# NEVER blocks compaction: it always exits 0 and swallows every error.
#
# SMART-CACHE-AWARE. The user's smart-cache-pro PreCompact hook (snapshot-before-compact.mjs) also
# snapshots the transcript — but VERBATIM to the CACHE (~/.claude/cache/compaction). This one targets the
# INDEXED MEMORY STORE. When capture.mjs (below) detects a fresh smart-cache snapshot it REFERENCES it
# (pointer + flagged lines) instead of duplicating the verbatim window; when absent it self-snapshots.
# Detection auto-checks ~/.claude/cache/compaction and <ws>/memory/cache/.compaction; export SMART_CACHE_DIR
# to override (it is inherited by the node child below). Run BOTH hooks — order-independent, best-effort.
# See references/compaction-capture.md.
#
# settings.json wiring (documented in that reference doc):
#   "PreCompact": [{ "matcher": "",
#     "hooks": [{ "type": "command",
#       "command": "bash /ABS/PATH/cognitive-memory/hooks/precompact-capture.sh" }] }]
set -uo pipefail

# --- read the PreCompact JSON payload from stdin (best-effort) ---------------------------------------
PAYLOAD="$(cat 2>/dev/null || true)"

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || dirname "$0")"
CAPTURE="$SCRIPT_DIR/compaction-capture/capture.mjs"

# --- workspace = the SAME memory root msem/mdeep index (store.mjs: OPENCLAW_WORKSPACE || ~/.openclaw/
#     workspace). Extra CC-friendly fallbacks so a standalone Claude Code user can point it at their store. --
WS="${MEMORY_SUITE_WS:-${OPENCLAW_WORKSPACE:-${CLAUDE_PROJECT_DIR:-$HOME/.openclaw/workspace}}}"

# --- pull transcript_path + trigger out of the JSON (node if present; sed fallback otherwise) --------
TRANSCRIPT=""; TRIGGER="auto"
if command -v node >/dev/null 2>&1; then
  PARSED="$(printf '%s' "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j={};try{j=JSON.parse(s||"{}")}catch{}process.stdout.write((j.transcript_path||"")+"\n"+(j.trigger||j.matcher||"auto")+"\n")})' 2>/dev/null || true)"
  TRANSCRIPT="$(printf '%s\n' "$PARSED" | sed -n '1p')"
  TRIGGER="$(printf '%s\n' "$PARSED" | sed -n '2p')"
else
  TRANSCRIPT="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  TRIGGER="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"trigger"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -z "${TRIGGER:-}" ] && TRIGGER="auto"

# --- best-effort capture: node + capture.mjs render the full snapshot; else a shell breadcrumb -------
if command -v node >/dev/null 2>&1 && [ -f "$CAPTURE" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  node "$CAPTURE" --transcript "$TRANSCRIPT" --ws "$WS" --trigger "$TRIGGER" --source "claude-code:precompact" >/dev/null 2>&1 || true
else
  # Fallback (no node / no capture.mjs / no transcript): still drop an INDEXED breadcrumb so the moment
  # isn't invisible. The raw transcript (if any) is snapshotted by smart-cache-pro and indexed by mdeep.
  DIR="$WS/memory/.compaction"
  mkdir -p "$DIR" 2>/dev/null || true
  TS="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo now)"
  {
    echo "---"
    echo "type: compaction-snapshot"
    echo "status: active"
    echo "date: $(date -u +%Y-%m-%d 2>/dev/null || echo unknown)"
    echo "tags: [compaction, layer2, auto-capture]"
    echo "source: compaction-capture"
    echo "trigger: ${TRIGGER:-auto}"
    echo "origin: claude-code:precompact (fallback)"
    echo "captured: $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
    echo "---"
    echo
    echo "# Compaction snapshot — $TS (breadcrumb)"
    echo
    echo "Claude Code context was compacted; the full renderer was unavailable (no node / capture.mjs /"
    echo "transcript), so this is a breadcrumb only. Transcript path at the time: \`${TRANSCRIPT:-unknown}\`."
    echo "The raw window remains recoverable via \`mdeep\` (transcript index)."
  } > "$DIR/snapshot-${TS}.md" 2>/dev/null || true
fi

exit 0
