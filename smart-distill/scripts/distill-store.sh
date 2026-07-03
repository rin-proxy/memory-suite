#!/usr/bin/env bash
# distill-store.sh — persist distilled content where it's instantly RECALLABLE (msem/mdeep), with provenance.
# Unlike a flat cache, this writes into the indexed semantic store with YAML frontmatter + a source hash,
# so the distilled essence becomes part of total recall. (You do the LLM distillation; this persists + indexes.)
# Usage:  ./distill-store.sh --title "Topic" --source URL_OR_TAG [--tags "a,b"] [--reindex] < distilled.md
set -euo pipefail
# Portable sha256 over stdin: GNU coreutils 'sha256sum' OR BSD/macOS 'shasum -a 256'.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
TITLE=""; SOURCE=""; TAGS=""; REINDEX=false
while [[ $# -gt 0 ]]; do case "$1" in
  --title)  TITLE="$2"; shift 2 ;;
  --source) SOURCE="$2"; shift 2 ;;
  --tags)   TAGS="$2"; shift 2 ;;
  --reindex) REINDEX=true; shift ;;
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
{
  echo "---"
  echo "type: distilled"
  echo "status: active"
  echo "date: $DATE"
  echo "source: ${SOURCE:-unknown}"
  echo "provenance: sha256-$HASH"
  [[ -n "$TAGS" ]] && echo "tags: [$TAGS]"
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
