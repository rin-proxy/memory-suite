#!/usr/bin/env bash
# find-connections.sh — surface CANDIDATE cross-domain connections for the agent to synthesize.
# It does NOT write the insight. It pulls the most related notes from DIFFERENT domains than the
# seed (via msem, the semantic engine) and prints them as candidate pairs/clusters + a synthesis
# prompt. You (the LLM) judge which links are real and write the connection note.
# Usage:  ./find-connections.sh "<seed note/topic>" [k]      (k = how many candidates, default 12)
set -euo pipefail

usage() { sed -n '2,8p' "$0"; }
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }
SEED="${1:-}"
[[ -z "$SEED" ]] && { echo "Error: a seed note/topic is required." >&2; usage; exit 1; }
K="${2:-12}"

WS="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MSEM="$WS/scripts/semantic/msem"
[[ -x "$MSEM" ]] || { echo "Error: semantic stack not found at $MSEM (the semantic helper 'msem' must be present)." >&2; exit 1; }

# Pull related notes by MEANING. Drop the node/runtime banner lines; keep result + snippet lines.
RAW=$("$MSEM" "$SEED" "$K" 2>/dev/null | grep -vE '^\[node-llama-cpp\]')

# Parse each result line:  "  rrf X | sem Y | kw Z | [TYPE]  path:line"
#   -> TYPE = domain bucket,  PATH = note.  We group candidates by domain and EXCLUDE the seed's
#   own domain so what's left is genuinely cross-domain raw material.
mapfile -t HITS < <(printf '%s\n' "$RAW" | grep -oE '\[[a-z0-9-]+\][[:space:]]+[A-Za-z0-9_./-]+\.md' \
                    | sed -E 's/\][[:space:]]+/]\t/' | awk -F'\t' '!seen[$2]++{print $1"\t"$2}')

[[ ${#HITS[@]} -eq 0 ]] && { echo "No related notes found for: \"$SEED\". Try a broader theme or raise k."; exit 0; }

# The top hit's domain is treated as the seed's home domain (most-related = where the seed lives).
HOME_DOMAIN=$(printf '%s\n' "${HITS[0]}" | cut -f1)

echo "🔗 Connection candidates for seed: \"$SEED\""
echo "   engine: msem (semantic) · k=$K · home domain ≈ $HOME_DOMAIN  (cross-domain links are the interesting ones)"
echo

cross=0; home=0
echo "── Cross-domain candidates (different domain than the seed — synthesize THESE) ──"
for h in "${HITS[@]}"; do
  dom=$(printf '%s\n' "$h" | cut -f1); path=$(printf '%s\n' "$h" | cut -f2)
  if [[ "$dom" != "$HOME_DOMAIN" ]]; then echo "   • $dom  ${path#"$WS"/}"; cross=$((cross+1)); fi
done
[[ $cross -eq 0 ]] && echo "   (none — every related note shares the seed's domain; broaden the seed or raise k)"

echo
echo "── Same-domain (context only — usually 'both mention X', not a strong link) ──"
for h in "${HITS[@]}"; do
  dom=$(printf '%s\n' "$h" | cut -f1); path=$(printf '%s\n' "$h" | cut -f2)
  if [[ "$dom" == "$HOME_DOMAIN" ]]; then echo "   • $dom  ${path#"$WS"/}"; home=$((home+1)); fi
done

echo
echo "── Now synthesize (the agent's job) ──"
echo "Read the cross-domain candidates above. Look for ONE of the four strong connection types:"
echo "   A·Principle      same underlying principle in two different domains"
echo "   B·Contradiction  two notes in genuine tension (interesting, not trivial)"
echo "   C·Pattern        3+ notes that together form one unnamed insight"
echo "   D·Answered-Q     a question in one note another note accidentally answers"
echo "Surface only what would genuinely SURPRISE — min 3, max 5. The insight lives BETWEEN the notes,"
echo "not inside any one of them. Restating what a note already says is NOT a connection."
echo
echo "Then write each real insight to the connections store:  memory/05-connections/YYYY-MM-DD-connection-<slug>.md"
echo "(type · one-sentence bridge · [[real source notes]] · why it matters). See references/synthesis-guide.md."
