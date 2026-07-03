#!/usr/bin/env bash
# heartbeat.sh — LAYER 3 (light periodic sweep) · autonomous maintenance, PROVIDER-FREE.
#
# The fast, best-effort pulse of the autonomous-maintenance loop (Layer 3). It runs the cheap,
# DETERMINISTIC housekeeping that keeps recall fresh between the heavier nightly consolidate.sh —
# NO LLM, NO cloud, NO provider. Three passes, each independently guarded (any failure is swallowed
# so a degraded environment never breaks the heartbeat):
#
#   1. incremental reindex — `index.mjs --incremental` re-embeds only changed curated files so
#      msem/mdeep recall reflects recent saves without waiting for the daily reindex cron. (Skipped
#      cleanly if node / the semantic stack / the model isn't installed — best-effort.)
#   2. decay refresh — ensure the retrieval-time decay store exists + is valid JSON, and drop
#      decay entries whose file no longer exists (orphans). Never clobbers a good store.
#   3. flag recent un-curated activity — append pointers (recently-touched capture files, notes
#      still carrying a `reconcile: review` flag) to memory/.consolidation/queue-<date>.md so the
#      running agent (or the nightly consolidate) can curate/resolve them. This LEAVES WORK for a
#      human/agent to do — it does not itself judge or rewrite memory.
#
# HONEST SCOPE: this is scaffolding, not a daemon that "thinks". Every pass here is pure code. The
# JUDGMENT (merge, summarize, resolve conflicts) is deferred to consolidate.sh's opt-in LLM step or
# to the agent processing the queue. Nothing is ever hard-deleted here.
#
# Usage:  heartbeat.sh [--ws PATH] [--window-min N] [-h|--help]
#   --ws          workspace root (default: $OPENCLAW_WORKSPACE, else ~/.openclaw/workspace)
#   --window-min  "recent" activity window in minutes (default: 60; env HEARTBEAT_WINDOW_MIN)
# Meant to run ~every 30 min (opt-in cron via install.sh --with-cron). Safe to run by hand anytime.
set -uo pipefail

WS_ARG=""; WINDOW_MIN="${HEARTBEAT_WINDOW_MIN:-60}"
while [ $# -gt 0 ]; do
  case "$1" in
    --ws)         shift; WS_ARG="${1:-}" ;;
    --window-min) shift; WINDOW_MIN="${1:-60}" ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "heartbeat.sh: unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

WS="${WS_ARG:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
MEM="$WS/memory"
SEM="$WS/scripts/semantic"
[ -d "$MEM" ] || { echo "heartbeat: no memory store at $MEM (nothing to sweep)"; exit 0; }

TAB="$(printf '\t')"
DATE="$(date -u +%Y-%m-%d)"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HHMM="$(date -u +%H:%MZ)"
INDEX_JSON="$MEM/.semantic/index.json"
DECAY_JSON="$MEM/.semantic/decay-scores.json"
QUEUE_DIR="$MEM/.consolidation"
QUEUE="$QUEUE_DIR/queue-$DATE.md"
mkdir -p "$QUEUE_DIR" 2>/dev/null || true

echo "💓 heartbeat $TS  ws=$WS"

# --- ensure today's queue exists with a header (shared shape with consolidate.sh) --------------------
if [ ! -f "$QUEUE" ]; then
  {
    echo "# Consolidation queue — $DATE"
    echo "_Layer 3 · deterministic scaffolding (provider-free). The running agent (or nightly consolidate) processes these, then deletes this file. Nothing here is auto-applied._"
  } > "$QUEUE" 2>/dev/null || true
fi

# --- pass 1: incremental reindex (best-effort · provider-free) ---------------------------------------
# Reuses the SAME index.mjs the daily cron uses. Only re-embeds changed files, so it's cheap. If node /
# the stack / the model is missing (or another build holds the lock) it just no-ops — never blocks.
if command -v node >/dev/null 2>&1 && [ -f "$SEM/index.mjs" ]; then
  if ( cd "$SEM" && node index.mjs --incremental ) >/dev/null 2>&1; then
    echo "  ✓ reindex: incremental curated reindex done"
  else
    echo "  · reindex: skipped/failed (model or node_modules absent, or lock held) — best-effort"
  fi
else
  echo "  · reindex: node / semantic stack not installed — skipped (best-effort)"
fi

# --- pass 2: decay refresh (ensure store valid · drop orphaned entries) -------------------------------
# The decay signal is written lazily by msem/mdeep on search. Heartbeat only makes sure the store EXISTS
# and is valid, and prunes entries whose file is gone. It NEVER clobbers a good store (a corrupt file is
# left alone — decay.mjs already treats corrupt as neutral). Also strips index.json entries for files that
# no longer exist or live in the working areas (.archive / .consolidation), so archived/queued notes stay
# out of active recall even though the reindexer doesn't exclude those paths.
if [ ! -f "$DECAY_JSON" ]; then
  mkdir -p "$MEM/.semantic" 2>/dev/null || true
  printf '%s\n' '{"version":1,"entries":{}}' > "$DECAY_JSON" 2>/dev/null || true
  echo "  ✓ decay: initialized empty decay-scores.json"
fi
if command -v node >/dev/null 2>&1; then
  # drop decay entries whose file no longer exists (orphans) — atomic, best-effort, never throws.
  dropped="$(node -e '
    const fs=require("fs");const p=process.argv[1],ws=process.argv[2];
    try{const j=JSON.parse(fs.readFileSync(p,"utf8"));if(!j||typeof j!=="object"||!j.entries){process.stdout.write("0");process.exit(0);}
      let n=0;for(const k of Object.keys(j.entries)){if(!fs.existsSync(ws+"/"+k)){delete j.entries[k];n++;}}
      if(n){const t=p+".tmp";fs.writeFileSync(t,JSON.stringify({version:1,entries:j.entries}));fs.renameSync(t,p);}
      process.stdout.write(String(n));}catch(e){process.stdout.write("0");}
  ' "$DECAY_JSON" "$WS" 2>/dev/null || echo 0)"
  [ "${dropped:-0}" != "0" ] && echo "  ✓ decay: dropped $dropped orphaned score entr(y/ies)"
  # keep working-area + orphaned keys out of the search index (see header note).
  if [ -f "$INDEX_JSON" ]; then
    stripped="$(node -e '
      const fs=require("fs");const p=process.argv[1],ws=process.argv[2];
      try{const j=JSON.parse(fs.readFileSync(p,"utf8"));const F=(j&&j.files)||{};let n=0;
        for(const k of Object.keys(F)){if(/^memory\/\.(archive|consolidation)\//.test(k)||!fs.existsSync(ws+"/"+k)){delete F[k];n++;}}
        if(n){const t=p+".tmp";fs.writeFileSync(t,JSON.stringify(j));fs.renameSync(t,p);}
        process.stdout.write(String(n));}catch(e){process.stdout.write("0");}
    ' "$INDEX_JSON" "$WS" 2>/dev/null || echo 0)"
    [ "${stripped:-0}" != "0" ] && echo "  ✓ index: stripped $stripped working-area/orphaned entr(y/ies) from recall"
  fi
else
  echo "  · decay: node not available — left decay/index stores untouched (best-effort)"
fi

# --- pass 3: flag recent un-curated activity into the queue ------------------------------------------
# Deterministic pointers only. Appends a timestamped block listing (a) capture files / episodic notes
# touched within the window and (b) notes still carrying a `reconcile: review` flag needing a verdict.
# De-duplicates against what's already in today's queue so repeated heartbeats don't spam it.
flag_block=""
add_flag() { # $1 = relpath-ish label, $2 = reason
  # skip if already flagged this run (in-memory) or already present in today's queue file
  case "$flag_block" in *"\`$1\`"*) return 0 ;; esac
  if [ -f "$QUEUE" ] && grep -qF "\`$1\`" "$QUEUE" 2>/dev/null; then return 0; fi
  flag_block="${flag_block}- [$HHMM] \`$1\` — $2"$'\n'
}

# (a) notes still awaiting a reconcile verdict (write-time flagged 'reconcile: review') — flagged FIRST so a
#     file that both changed recently AND needs a verdict shows the more important 'review' reason (once).
review_files="$(grep -rlF 'reconcile: review' "$MEM" 2>/dev/null \
                | grep -Ev '/\.consolidation/|/\.archive/' | head -20 || true)"
if [ -n "$review_files" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    add_flag "${f#$WS/}" "carries 'reconcile: review' — judge duplicate/update/contradiction/distinct"
  done <<EOF
$review_files
EOF
fi

# (b) recently-touched capture surfaces (companion flat-files + episodic notes). find -mmin is portable.
recent="$(find "$MEM" -type f -name '*.md' -mmin -"$WINDOW_MIN" 2>/dev/null \
          | grep -Ev '/\.semantic/|/\.consolidation/|/\.archive/|/04-meta/(audit|reflection-log|reward-log)' \
          | head -40 || true)"
if [ -n "$recent" ]; then
  count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rel="${f#$WS/}"
    add_flag "$rel" "touched <${WINDOW_MIN}m ago — consider curating/consolidating"
    count=$((count+1))
    [ "$count" -ge 15 ] && break
  done <<EOF
$recent
EOF
fi

# root-level capture files that morning-briefing/proactive-partner read (flat, easy to forget to curate)
for cf in active-tasks.md last-conversation.md learnings.md; do
  if [ -f "$MEM/$cf" ]; then
    fresh="$(find "$MEM/$cf" -mmin -"$WINDOW_MIN" 2>/dev/null || true)"
    [ -n "$fresh" ] && add_flag "memory/$cf" "capture file updated <${WINDOW_MIN}m ago — promote high-signal items with save.sh"
  fi
done

if [ -n "$flag_block" ]; then
  {
    echo ""
    echo "## Heartbeat flags — $TS"
    printf '%s' "$flag_block"
  } >> "$QUEUE" 2>/dev/null || true
  n_flags="$(printf '%s' "$flag_block" | grep -c '^- ' || echo 0)"
  echo "  ✓ queue: flagged $n_flags item(s) → ${QUEUE#$WS/}"
else
  echo "  · queue: nothing new to flag (all recent activity already queued/curated)"
fi

echo "💓 heartbeat done (deterministic · provider-free · nothing deleted)"
