#!/usr/bin/env bash
# distill-store.sh — persist distilled content where it's instantly RECALLABLE (msem/mdeep), with provenance.
# Unlike a flat cache, this writes into the indexed semantic store with YAML frontmatter + a source hash,
# so the distilled essence becomes part of total recall. (You do the LLM distillation; this persists + indexes.)
# Usage:  ./distill-store.sh --title "Topic" --source URL_OR_TAG [--tags "a,b"] [--reindex] [--no-reconcile] < distilled.md
# Before writing it runs a best-effort, PROVIDER-FREE semantic reconcile (embedding dedup + conflict pre-filter):
# a near-identical note is skipped; an ambiguous "similar" note is stored with a review flag for the agent to judge.
set -euo pipefail
# Portable sha256 over stdin: GNU coreutils 'sha256sum' OR BSD/macOS 'shasum -a 256'.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
TITLE=""; SOURCE=""; TAGS=""; REINDEX=false; RECONCILE_ON=true
while [[ $# -gt 0 ]]; do case "$1" in
  --title)  TITLE="$2"; shift 2 ;;
  --source) SOURCE="$2"; shift 2 ;;
  --tags)   TAGS="$2"; shift 2 ;;
  --reindex) REINDEX=true; shift ;;
  --no-reconcile) RECONCILE_ON=false; shift ;;
  -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
esac; done
[[ -z "$TITLE" ]] && { echo "Error: --title required" >&2; exit 1; }
WS="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
DIR="$WS/memory/02-semantic/distilled"        # under memory/ → semantic-indexed → recallable
mkdir -p "$DIR"
CONTENT=$(cat); [[ -z "$CONTENT" ]] && { echo "Error: pipe in distilled content" >&2; exit 1; }
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-\+/-/g; s/^-//; s/-$//')
HASH=$( { echo "$TITLE"; echo "$SOURCE"; echo "$CONTENT"; } | sha256 | head -c 8 )
DATE=$(date -u +%Y-%m-%d)
FILE="$DIR/${SLUG}-${HASH}.md"
if [[ -f "$FILE" ]]; then echo "↺ already distilled (same content hash) → ${FILE/$WS\//}"; exit 0; fi

# --- write-time reconciliation (best-effort · provider-free) -----------------------------------------
# Embedding-similarity dedup/conflict PRE-FILTER before we write. The cosine bucketing is pure code; a
# genuinely-ambiguous "similar" case is handed to the RUNNING agent to judge (no external LLM/provider).
# Fully best-effort: if node / the semantic stack / the model is unavailable we just fall through and write
# normally. Reconciliation can drop a dup or flag for review — it must NEVER block a store.
REVIEW=false
RECON_SCRIPT="$WS/scripts/semantic/reconcile.mjs"
if $RECONCILE_ON && command -v node >/dev/null 2>&1 && [[ -f "$RECON_SCRIPT" ]]; then
  RECON_IN=$(mktemp "${TMPDIR:-/tmp}/distill-recon.XXXXXX" 2>/dev/null || echo "")
  if [[ -n "$RECON_IN" ]]; then
    RECON_ERR=$(mktemp "${TMPDIR:-/tmp}/distill-recon-err.XXXXXX" 2>/dev/null || echo "/dev/null")
    { printf '# %s\n\n' "$TITLE"; printf '%s\n' "$CONTENT"; } > "$RECON_IN"
    # --action-only prints just new|skip|review on stdout; the reason line goes to stderr.
    ACTION=$(node "$RECON_SCRIPT" --file "$RECON_IN" --ws "$WS" --action-only 2>"$RECON_ERR" || echo new)
    RECON_WHY=$(grep '^# reconcile:' "$RECON_ERR" 2>/dev/null | head -1 | sed 's/^# reconcile: //' || true)
    rm -f "$RECON_IN"; [[ "$RECON_ERR" != "/dev/null" ]] && rm -f "$RECON_ERR"
    case "$ACTION" in
      skip)
        echo "⏭  reconcile: not storing (semantic near-duplicate) — ${RECON_WHY:-matches an existing memory}"
        exit 0 ;;
      review)
        REVIEW=true
        echo "⚠  reconcile: ${RECON_WHY:-similar memory exists} — storing with a 'reconcile: review' flag for the agent to judge (duplicate / update / contradiction)." ;;
    esac
  fi
fi

{
  echo "---"
  echo "type: distilled"
  echo "status: active"
  echo "date: $DATE"
  echo "source: ${SOURCE:-unknown}"
  echo "provenance: sha256-$HASH"
  [[ -n "$TAGS" ]] && echo "tags: [$TAGS]"
  [[ "$REVIEW" == true ]] && echo "reconcile: review"
  echo "---"
  echo
  echo "# $TITLE"
  echo
  echo "$CONTENT"
  echo
  echo "_Distilled $DATE from ${SOURCE:-source} · provenance sha256-${HASH}_"
} > "$FILE"
echo "✓ stored → ${FILE/$WS\//}  (type:distilled, provenance sha256-$HASH)"

if $REINDEX; then
  if ( cd "$WS/scripts/semantic" && node index.mjs --incremental >/dev/null 2>&1 ); then
    echo "✓ semantic-indexed now → recallable via  msem \"<query>\"  /  mdeep"
  else echo "  (reindex skipped/failed — it'll be picked up by the 15-min reindex cron)"; fi
else
  echo "  → recallable after the next 15-min semantic reindex (or pass --reindex to index now)"
fi
