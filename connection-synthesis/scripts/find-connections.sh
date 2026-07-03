#!/usr/bin/env bash
# find-connections.sh — surface CANDIDATE cross-domain connections for the agent to synthesize.
# It does NOT write the insight. It builds a PROVIDER-FREE link layer over memory (links.mjs) and ranks
# with MMR diversity (relevance − λ·redundancy) to surface memories that are RELATED-BUT-DISSIMILAR to the
# seed — the cross-domain raw material a plain top-k similarity search (or a human) would never put side by
# side. You (the LLM) judge which links are real and write the connection note.
# Usage:  ./find-connections.sh "<seed note/topic>" [k]      (k = how many candidates, default 12)
# Portable: bash 3.2-safe (no mapfile); resolves links.mjs/msem under $OPENCLAW_WORKSPACE; degrades gracefully.
set -uo pipefail   # deliberately NO -e: a soft failure should DEGRADE (fall back), not abort the pass.

usage() { sed -n '2,9p' "$0"; }
case "${1:-}" in -h|--help) usage; exit 0 ;; esac
SEED="${1:-}"
if [ -z "$SEED" ]; then echo "Error: a seed note/topic is required." >&2; usage; exit 1; fi
K="${2:-12}"

WS="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
SEM="$WS/scripts/semantic"
LINKS="$SEM/links.mjs"
MSEM="$SEM/msem"

echo "🔗 Connection candidates for seed: \"$SEED\""

# ── Preferred path: provider-free link layer + MMR diversity (links.mjs) ──────────────────────────────
# "Cross-domain" here means RELEVANT to the seed yet DISSIMILAR from the other picks (MMR selection) —
# NOT the old heuristic of "a different `type` field", which wrongly demoted two type:pattern notes that
# bridged market+behavior. links.mjs emits TSV:  path:line <TAB> type <TAB> rel <TAB> reason.
CROSS=""
if command -v node >/dev/null 2>&1 && [ -f "$LINKS" ]; then
  CROSS="$(node "$LINKS" --seed "$SEED" --k "$K" --ws "$WS" --tsv 2>/dev/null || true)"
fi

if [ -n "$CROSS" ]; then
  echo "   engine: links.mjs (semantic link layer · MMR diversity) · k=$K  (dissimilar-but-relevant = the interesting ones)"
  echo
  echo "── Diverse cross-domain candidates (relevant to the seed yet distinct from each other — synthesize THESE) ──"
  printf '%s\n' "$CROSS" | while IFS="$(printf '\t')" read -r loc typ rel reason; do
    [ -z "$loc" ] && continue
    printf '   • [%s] rel %s  %s\n       %s\n' "${typ:-note}" "${rel:-?}" "${loc#"$WS"/}" "$reason"
  done
  echo
else
  # ── Fallback: link layer unavailable (no node / no model / links.mjs absent / empty index) ──────────
  # Best-effort so the pass still has raw material. We do NOT fake "domain" from `type`; you judge
  # cross-domain-ness yourself from the notes below.
  echo "   engine: fallback (link layer unavailable) — most-related notes via msem"
  echo
  echo "── Related notes (fallback — judge cross-domain-ness yourself) ──"
  if command -v node >/dev/null 2>&1 && [ -x "$MSEM" ]; then
    "$MSEM" "$SEED" "$K" 2>/dev/null \
      | grep -vE '^\[node-llama-cpp\]' \
      | grep -oE '\[[a-z0-9-]+\][[:space:]]+[A-Za-z0-9_./-]+\.md:[0-9]+' \
      | while IFS= read -r line; do printf '   • %s\n' "${line#"$WS"/}"; done
  else
    echo "   (need Node + the semantic stack under $SEM — none found; install the suite to enable synthesis)"
  fi
  echo
fi

# ── The agent's job: synthesize (the tool surfaces; you synthesize) ───────────────────────────────────
echo "── Now synthesize (the agent's job) ──"
echo "Read the candidates above. Look for ONE of the four strong connection types:"
echo "   A·Principle      same underlying principle in two different domains"
echo "   B·Contradiction  two notes in genuine tension (interesting, not trivial)"
echo "   C·Pattern        3+ notes that together form one unnamed insight"
echo "   D·Answered-Q     a question in one note another note accidentally answers"
echo "Surface only what would genuinely SURPRISE — min 3, max 5. The insight lives BETWEEN the notes,"
echo "not inside any one of them. Restating what a note already says is NOT a connection."
echo
echo "Then write each real insight to the connections store:  memory/05-connections/YYYY-MM-DD-connection-<slug>.md"
echo "(type · one-sentence bridge · [[real source notes]] · why it matters). See references/synthesis-guide.md."
