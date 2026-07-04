#!/usr/bin/env bash
# upgrade-advisor.sh — PROVIDER-FREE detector for memory-suite's three OPTIONAL install flags.
#
# WHAT THIS IS: a pure-code advisor that measures the live workspace and, when the numbers say an
# optional engine flag would help NOW, prints a recommendation. Detection is 100% deterministic +
# provider-free (fs/stat/grep + a JSON chunk count) — NO model, NO network, NO embedding calls.
#
# THE CONTRACT (this is the whole point):
#   • This script only DETECTS + RECOMMENDS. It NEVER installs anything, never runs install.sh,
#     never edits the workspace. The recommended command is printed for a human/agent to run
#     ONLY AFTER approval. No auto-install, ever. (See references/upgrade-advisor.md.)
#   • proactive-partner surfaces these advisories during its proactive scan; the agent PROPOSES the
#     upgrade and the user APPROVES before install.sh is ever invoked.
#
# THREE TRIGGERS (each independently GUARDED — a missing index / crontab / dep just SKIPS that check,
# never errors; prints NOTHING when nothing triggers):
#   1. --with-cron      (staleness)  newest memory file is newer than index.json (unindexed content)
#                                    OR no `# memory-suite-reindex` line in crontab.
#   2. --with-sqlite-vec(scale)      chunk count ≥ threshold (default 8000 = vecstore VECSTORE.THRESHOLD)
#                                    AND the sqlite-vec deps (better-sqlite3 + sqlite-vec) are NOT installed.
#   3. --with-reranker  (precision)  chunk count ≥ a softer threshold (default 2000) AND the reranker
#                                    model file is absent. Softer SUGGESTION.
#
# Output: a human-readable markdown section PLUS one machine-readable `UPGRADE_REC` line per rec
#   (tab-separated: flag · severity · reason · measured · threshold · cmd).
#
# Usage:  ./upgrade-advisor.sh [WORKSPACE]
#   WORKSPACE defaults to $OPENCLAW_WORKSPACE, else $HOME/.openclaw/workspace.
#
# All thresholds + probe paths are env-tunable (so the same logic is unit-testable with synthetic
# inputs and stays correct if the engine is tuned):
#   ADVISOR_SQLITE_VEC_THRESHOLD  (default: $VECSTORE_THRESHOLD, else 8000)
#   ADVISOR_RERANKER_THRESHOLD    (default: 2000)
#   ADVISOR_INDEX                 (default: <ws>/memory/.semantic/index.json)
#   ADVISOR_MEMORY_DIR            (default: <ws>/memory)
#   ADVISOR_RERANKER_MODEL        (default: <ws>/node-llama-cpp/models/bge-reranker-v2-m3-Q8_0.gguf)
#   ADVISOR_SQLITE_VEC_DIR        (default: <ws>/node-llama-cpp/node_modules)  [checks better-sqlite3 + sqlite-vec]
#   ADVISOR_CRONTAB_FILE          (default: unset ⇒ use `crontab -l`; if set, read that file as the crontab)
#   ADVISOR_INSTALL_CMD           (default: computed `bash install.sh "<ws>" [--target claude-code]`)
#
# bash-3.2-safe · macOS + Linux portable (GNU `stat -c` with BSD `stat -f` fallback).
set -uo pipefail

# ---------------------------------------------------------------------------
# 0. Workspace + probe paths (all overridable for tests / tuned installs)
# ---------------------------------------------------------------------------
WS="${1:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
MEM="${ADVISOR_MEMORY_DIR:-$WS/memory}"
INDEX="${ADVISOR_INDEX:-$MEM/.semantic/index.json}"
RERANKER_MODEL="${ADVISOR_RERANKER_MODEL:-$WS/node-llama-cpp/models/bge-reranker-v2-m3-Q8_0.gguf}"
SQLITE_VEC_DIR="${ADVISOR_SQLITE_VEC_DIR:-$WS/node-llama-cpp/node_modules}"

# Thresholds. sqlite-vec default MATCHES _semantic-stack/vecstore.mjs VECSTORE.THRESHOLD (~8000); we
# honor a tuned $VECSTORE_THRESHOLD so the advisor tracks the same auto-enable point the engine uses.
SQLITE_VEC_THRESHOLD="${ADVISOR_SQLITE_VEC_THRESHOLD:-${VECSTORE_THRESHOLD:-8000}}"
RERANKER_THRESHOLD="${ADVISOR_RERANKER_THRESHOLD:-2000}"
# sanitize (non-numeric env ⇒ fall back to the documented defaults; never let a bad value crash a compare)
case "$SQLITE_VEC_THRESHOLD" in ''|*[!0-9]*) SQLITE_VEC_THRESHOLD=8000 ;; esac
case "$RERANKER_THRESHOLD"    in ''|*[!0-9]*) RERANKER_THRESHOLD=2000 ;; esac

# ---------------------------------------------------------------------------
# 1. Helpers (all pure, all guarded)
# ---------------------------------------------------------------------------
# portable mtime (epoch): GNU `stat -c %Y` with BSD/macOS `stat -f %m` fallback. Empty on failure.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# compact human duration for a second delta.
human_dur() {
  local s="$1"
  if   [ "$s" -ge 86400 ]; then echo "$((s/86400))d"
  elif [ "$s" -ge 3600 ];  then echo "$((s/3600))h"
  elif [ "$s" -ge 60 ];    then echo "$((s/60))m"
  else echo "${s}s"; fi
}

# Total chunk count in index.json = sum of files[*].chunks.length. node is authoritative (the suite
# already requires it); a grep of the single-line JSON's per-chunk "startLine" key is the provider-free
# fallback when node is absent. Returns non-zero (⇒ SKIP scale/precision) if the index is missing/unparseable.
count_chunks() {
  local idx="$1" n=""
  [ -f "$idx" ] || return 1
  if command -v node >/dev/null 2>&1; then
    n=$(node -e 'try{const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let n=0;const f=(i&&i.files)||{};for(const k in f)n+=(((f[k]||{}).chunks)||[]).length;process.stdout.write(String(n));}catch(e){process.exit(1)}' "$idx" 2>/dev/null) || n=""
  fi
  if [ -z "$n" ]; then
    # index.json is written single-line (JSON.stringify, no spacing); each chunk carries one "startLine".
    n=$(grep -o '"startLine"' "$idx" 2>/dev/null | wc -l | tr -d ' ')
  fi
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$n"
}

# Reindex-cron state: present | absent | unavailable. `unavailable` (no crontab tool / unreadable source)
# is a GUARD ⇒ the caller skips the cron half of trigger 1 rather than false-firing.
crontab_reindex_state() {
  local content
  if [ -n "${ADVISOR_CRONTAB_FILE:-}" ]; then
    if [ -r "$ADVISOR_CRONTAB_FILE" ]; then content=$(cat "$ADVISOR_CRONTAB_FILE" 2>/dev/null || true); else echo "unavailable"; return; fi
  elif command -v crontab >/dev/null 2>&1; then
    content=$(crontab -l 2>/dev/null || true)   # no crontab for user ⇒ empty ⇒ "absent" (the intended nudge)
  else
    echo "unavailable"; return
  fi
  if printf '%s\n' "$content" | grep -qF '# memory-suite-reindex'; then echo "present"; else echo "absent"; fi
}

# ---------------------------------------------------------------------------
# 2. Build the exact (approval-gated) install command
#    Best-effort target detection: a workspace under ~/.claude ⇒ the claude-code target.
# ---------------------------------------------------------------------------
case "$WS" in
  */.claude/*|*/.claude) TARGET_ARGS=" --target claude-code" ;;
  *)                     TARGET_ARGS="" ;;
esac
if [ -n "${ADVISOR_INSTALL_CMD:-}" ]; then
  INSTALL_BASE="$ADVISOR_INSTALL_CMD"
else
  INSTALL_BASE="bash install.sh \"$WS\"$TARGET_ARGS"
fi

# ---------------------------------------------------------------------------
# 3. Accumulate recommendations (human block + machine line per rec)
# ---------------------------------------------------------------------------
REC_COUNT=0
HUMAN=""
MACHINE=""
add_rec() {
  # $1 = human markdown block   $2 = machine-readable UPGRADE_REC line
  REC_COUNT=$((REC_COUNT+1))
  HUMAN="$HUMAN$1
"
  MACHINE="$MACHINE$2
"
}

# ---- Trigger 1: --with-cron  (staleness OR missing reindex cron) -----------------------------------
cron_state=$(crontab_reindex_state)
stale="unknown"   # unknown (guarded: no index) | yes | no
idx_m=""; new_m=0
if [ -f "$INDEX" ] && [ -d "$MEM" ]; then
  idx_m=$(mtime "$INDEX")
  # newest content .md under memory/, EXCLUDING engine/log trees + *-log.md (those aren't recall content).
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    m=$(mtime "$f") || continue
    case "$m" in ''|*[!0-9]*) continue ;; esac
    [ "$m" -gt "$new_m" ] && new_m="$m"
  done <<EOF
$(find "$MEM" -type f -name '*.md' \
    ! -path '*/.semantic/*' ! -path '*/logs/*' ! -path '*/.compaction/*' \
    ! -path '*/.consolidation/*' ! -path '*/.archive/*' ! -name '*-log.md' 2>/dev/null)
EOF
  if [ -n "$idx_m" ] && [ "$new_m" -gt 0 ]; then
    if [ "$new_m" -gt "$idx_m" ]; then stale="yes"; else stale="no"; fi
  fi
fi

cron_fire=no
cron_reasons=""
if [ "$cron_state" = "absent" ]; then
  cron_fire=yes
  cron_reasons="no \`# memory-suite-reindex\` cron scheduled"
fi
if [ "$stale" = "yes" ]; then
  cron_fire=yes
  dur=$(human_dur "$((new_m - idx_m))")
  if [ -n "$cron_reasons" ]; then cron_reasons="$cron_reasons; newest memory ~$dur newer than the index (unindexed)"
  else cron_reasons="newest memory ~$dur newer than the index (unindexed content)"; fi
fi
if [ "$cron_fire" = "yes" ]; then
  cmd="$INSTALL_BASE --with-cron"
  meas="cron=$cron_state,stale=$stale"
  [ "$stale" = "yes" ] && meas="$meas,content_newer_secs=$((new_m - idx_m))"
  printf -v ml 'UPGRADE_REC\tflag=--with-cron\tseverity=recommend\treason=staleness\tmeasured=%s\tthreshold=cron=present,index=fresh\tcmd=%s' "$meas" "$cmd"
  hb=$(printf -- '- **[recommend] `--with-cron`** — recall is missing recent memories; a scheduled reindex keeps it fresh.\n    - signal: %s\n    - on approval, run: `%s`' "$cron_reasons" "$cmd")
  add_rec "$hb" "$ml"
fi

# ---- Chunk count (shared by triggers 2 & 3; missing/unparseable index ⇒ both SKIP) -----------------
chunks=""
if [ -f "$INDEX" ]; then
  chunks=$(count_chunks "$INDEX") || chunks=""
fi

# ---- Trigger 2: --with-sqlite-vec  (scale) ---------------------------------------------------------
if [ -n "$chunks" ]; then
  deps_present=no
  if [ -d "$SQLITE_VEC_DIR/better-sqlite3" ] && [ -d "$SQLITE_VEC_DIR/sqlite-vec" ]; then deps_present=yes; fi
  if [ "$chunks" -ge "$SQLITE_VEC_THRESHOLD" ] && [ "$deps_present" = "no" ]; then
    cmd="$INSTALL_BASE --with-sqlite-vec"
    printf -v ml 'UPGRADE_REC\tflag=--with-sqlite-vec\tseverity=recommend\treason=scale\tmeasured=chunks=%s,deps=absent\tthreshold=chunks>=%s\tcmd=%s' "$chunks" "$SQLITE_VEC_THRESHOLD" "$cmd"
    hb=$(printf -- '- **[recommend] `--with-sqlite-vec`** — %s chunks (≥ %s): recall is loading the whole JSON index and doing an O(n) cosine scan per query, getting slow + memory-heavy. sqlite-vec makes queries fast + light with **identical** recall (opt-in; JSON stays the source of truth).\n    - signal: chunk count %s ≥ threshold %s · sqlite-vec deps (better-sqlite3 + sqlite-vec) not installed\n    - on approval, run: `%s`  (then `node vecstore.mjs --build` once)' "$chunks" "$SQLITE_VEC_THRESHOLD" "$chunks" "$SQLITE_VEC_THRESHOLD" "$cmd")
    add_rec "$hb" "$ml"
  fi
fi

# ---- Trigger 3: --with-reranker  (precision — softer SUGGESTION) -----------------------------------
if [ -n "$chunks" ]; then
  model_present=no
  [ -f "$RERANKER_MODEL" ] && model_present=yes
  if [ "$chunks" -ge "$RERANKER_THRESHOLD" ] && [ "$model_present" = "no" ]; then
    cmd="$INSTALL_BASE --with-reranker"
    printf -v ml 'UPGRADE_REC\tflag=--with-reranker\tseverity=suggest\treason=precision\tmeasured=chunks=%s,model=absent\tthreshold=chunks>=%s\tcmd=%s' "$chunks" "$RERANKER_THRESHOLD" "$cmd"
    hb=$(printf -- '- **[suggest] `--with-reranker`** — %s chunks (≥ %s): a corpus this large benefits from a cross-encoder reranker that sharpens the top results. Off by default; opt-in per query via `RERANK=1`. Softer suggestion — default recall is unaffected either way.\n    - signal: chunk count %s ≥ threshold %s · reranker model (bge-reranker-v2-m3-Q8_0.gguf) not present\n    - on approval, run: `%s`' "$chunks" "$RERANKER_THRESHOLD" "$chunks" "$RERANKER_THRESHOLD" "$cmd")
    add_rec "$hb" "$ml"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Emit — nothing at all when nothing triggered
# ---------------------------------------------------------------------------
if [ "$REC_COUNT" -gt 0 ]; then
  printf '## 🔧 Engine upgrades available\n'
  printf '_Optional install flags that would help now. **Approval-gated:** the agent PROPOSES, you APPROVE, then `install.sh` runs — detection is provider-free but nothing is EVER auto-installed._\n\n'
  printf '%s\n' "$HUMAN"
  printf '<!-- upgrade-advisor:machine-readable — one UPGRADE_REC line per rec (flag · severity · reason · measured vs threshold · exact command) -->\n'
  printf '%s' "$MACHINE"
fi
exit 0
