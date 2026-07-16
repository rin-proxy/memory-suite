#!/usr/bin/env bash
# save.sh — LAYER 1 real-time "save-by-default" capture (provider-free, agent-driven).
#
# The RUNNING AGENT — not a cron, not an LLM/provider call — decides an item is high-signal (a decision,
# a preference, a milestone, a correction, an explicit "remember this") and calls this to land it in the
# CURATED, numbered memory store with YAML frontmatter. This complements mdeep's raw-transcript safety net:
# transcripts catch EVERYTHING said (noisy, deep recall); save-by-default puts the items the agent judged
# worth keeping into clean, fast msem-recallable memory — so they reliably survive, not just linger in a log.
#
# Usage:
#   save.sh --text '<content>' [--type decision|preference|fact|correction|milestone] [--tags a,b] [--ws PATH]
#           [--no-reconcile] [-h|--help]
#
# Before writing it runs a best-effort, PROVIDER-FREE write-time reconcile — the SAME reconcile.mjs the
# distill path uses (embedding dedup + conflict pre-filter over the already-indexed memory):
#   skip   (cosine ≥ RECONCILE_HIGH) → near-duplicate  → NOT written (logged).
#   review (RECONCILE_MID..HIGH)     → similar/ambiguous → written WITH a `reconcile: review` flag to judge.
#   new / unavailable                → written normally.
# Best-effort & NON-BLOCKING: missing node / semantic stack / model / index ⇒ treated as "new" ⇒ the item is
# still saved. Reconcile can drop a confident dup or flag a review — it can NEVER lose a memory you meant to keep.
#
# Type → numbered store (aligns with references/routing-prompt.md; full protocol: references/save-by-default.md):
#   preference           → memory/00-core       (never-decay: honor it forever)
#   decision | milestone → memory/01-episodic    (happened at a time / with people)
#   fact | correction    → memory/02-semantic    (durable knowledge; a correction revises it)
#   (no --type)          → memory/01-episodic    (timestamped general capture)
set -uo pipefail

# Portable sha256 over stdin (GNU 'sha256sum' or BSD/macOS 'shasum -a 256') — bash-3.2 safe.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }

TEXT=""; TYPE=""; TAGS=""; WS_ARG=""; RECONCILE_ON=true
while [ $# -gt 0 ]; do
  case "$1" in
    --text) shift; TEXT="${1:-}" ;;
    --type) shift; TYPE="${1:-}" ;;
    --tags) shift; TAGS="${1:-}" ;;
    --ws)   shift; WS_ARG="${1:-}" ;;
    --no-reconcile) RECONCILE_ON=false ;;
    -h|--help)
      cat <<'EOF'
save.sh — LAYER 1 real-time "save-by-default" capture (provider-free, agent-driven).
Write a high-signal item into the curated numbered memory store, after a best-effort write-time reconcile
(embedding dedup + conflict pre-filter — the same reconcile.mjs the distill path uses).

Usage:
  save.sh --text '<content>' [--type decision|preference|fact|correction|milestone] [--tags a,b] [--ws PATH] [--no-reconcile]

Type → store:  preference→00-core · decision|milestone→01-episodic · fact|correction→02-semantic · (none)→01-episodic
Reconcile:     skip = near-dup (not written) · review = written with a `reconcile: review` flag · new/unavailable = written normally.
Never blocks:  missing node / semantic stack / model / index ⇒ treated as "new" ⇒ the item is still saved.
EOF
      exit 0 ;;
    *) echo "save.sh: unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

[ -z "$TEXT" ] && { echo "save.sh: --text '<content>' is required (see --help)" >&2; exit 1; }

WS="${WS_ARG:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"

# --- best-effort secret redaction (provider-free) BEFORE hashing/title/store --------------------------
# Closes the gap where redact() ran on raw transcripts only, not curated saves. Non-blocking: if node /
# redact.mjs is unavailable we write as before. Runs before the hash so an identical secret redacts stably.
REDACT_SCRIPT="$WS/scripts/semantic/redact.mjs"
if command -v node >/dev/null 2>&1 && [ -f "$REDACT_SCRIPT" ]; then
  REDACTED=$(printf '%s' "$TEXT" | node "$REDACT_SCRIPT" 2>/dev/null || true)
  [ -n "$REDACTED" ] && TEXT="$REDACTED"
fi

# --- type → numbered store dir (bash-3.2: case, not an associative array) ------------------------------
case "$TYPE" in
  preference)            STORE="00-core" ;;
  decision|milestone)    STORE="01-episodic" ;;
  fact|correction)       STORE="02-semantic" ;;
  "")                    TYPE="note"; STORE="01-episodic" ;;
  *)                     echo "save.sh: unrecognized --type '$TYPE' → routing to 01-episodic" >&2; STORE="01-episodic" ;;
esac
DIR="$WS/memory/$STORE"
mkdir -p "$DIR" 2>/dev/null || true

DATE=$(date -u +%Y-%m-%d)

# First line → human title (capped); slug from the title drives the filename.
TITLE=$(printf '%s\n' "$TEXT" | head -1 | cut -c1-80)
SLUG=$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-\{1,\}/-/g; s/^-//; s/-$//' | cut -c1-50)
[ -z "$SLUG" ] && SLUG="note"
# Hash type+text (NOT date) so an identical capture maps to the same filename → idempotent across days.
HASH=$( printf '%s\n%s\n' "$TYPE" "$TEXT" | sha256 | head -c 8 )
FILE="$DIR/${SLUG}-${HASH}.md"

if [ -f "$FILE" ]; then
  echo "↺ already saved (same content) → ${FILE/$WS\//}"
  exit 0
fi

# --- write-time reconciliation (best-effort · provider-free) ------------------------------------------
# Reuses the SAME reconcile.mjs the distill path uses. The cosine bucketing is pure code; a genuinely-
# ambiguous "similar" case is handed to the RUNNING agent via the `reconcile: review` flag (no external
# LLM/provider). Fully best-effort: if node / the stack / the model / the index is unavailable we fall
# through and write normally. Reconcile can drop a dup or flag a review — it must NEVER block a save.
REVIEW=false
RECON_WHY=""
RECON_SCRIPT="$WS/scripts/semantic/reconcile.mjs"
if $RECONCILE_ON && command -v node >/dev/null 2>&1 && [ -f "$RECON_SCRIPT" ]; then
  RECON_IN=$(mktemp "${TMPDIR:-/tmp}/save-recon.XXXXXX" 2>/dev/null || echo "")
  if [ -n "$RECON_IN" ]; then
    RECON_ERR=$(mktemp "${TMPDIR:-/tmp}/save-recon-err.XXXXXX" 2>/dev/null || echo "/dev/null")
    { printf '# %s\n\n' "$TITLE"; printf '%s\n' "$TEXT"; } > "$RECON_IN"
    # --action-only prints just new|skip|review on stdout; the reason line goes to stderr.
    ACTION=$(node "$RECON_SCRIPT" --file "$RECON_IN" --ws "$WS" --action-only 2>"$RECON_ERR" || echo new)
    RECON_WHY=$(grep '^# reconcile:' "$RECON_ERR" 2>/dev/null | head -1 | sed 's/^# reconcile: //' || true)
    rm -f "$RECON_IN"; [ "$RECON_ERR" != "/dev/null" ] && rm -f "$RECON_ERR"
    case "$ACTION" in
      skip)
        echo "⏭  save-by-default: NOT storing (semantic near-duplicate) — ${RECON_WHY:-matches an existing memory}"
        exit 0 ;;
      review)
        REVIEW=true
        echo "⚠  save-by-default: ${RECON_WHY:-similar memory exists} — storing with a 'reconcile: review' flag for the agent to judge (duplicate / update / contradiction / distinct)." ;;
    esac
  fi
fi

# --- write the curated memory note --------------------------------------------------------------------
{
  echo "---"
  echo "type: $TYPE"
  echo "status: active"
  echo "date: $DATE"
  [ -n "$TAGS" ] && echo "tags: [$TAGS]"
  echo "source: save-by-default"
  [ "$REVIEW" = true ] && echo "reconcile: review"
  echo "---"
  echo
  echo "# ${TYPE}: ${TITLE}"
  echo
  printf '%s\n' "$TEXT"
  echo
  echo "_Saved $DATE · source: save-by-default (Layer 1 · real-time · agent-driven)_"
} > "$FILE.tmp.$$" && mv -f "$FILE.tmp.$$" "$FILE"

echo "✓ saved → ${FILE/$WS\//}  (type:$TYPE, store:$STORE, source:save-by-default)"
echo "  → recallable via  msem \"<query>\"  after the next semantic reindex (15-min cron)."
