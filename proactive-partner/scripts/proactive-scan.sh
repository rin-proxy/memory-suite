#!/usr/bin/env bash
# proactive-scan.sh — surface CONCRETE proactive opportunities from an agent's workspace + memory.
# Deterministic scan; the agent then runs mdeep (total recall) to turn each into a grounded proposal.
# This is the operational core a generic "be proactive" prompt lacks. Usage: ./proactive-scan.sh [/path/to/ws]
set -uo pipefail
WS="${1:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
M="$WS/memory"
[[ -d "$WS" ]] || { echo "workspace not found: $WS" >&2; exit 1; }
now=$(date +%s)
# portable mtime (epoch): GNU 'stat -c %Y' with BSD/macOS 'stat -f %m' fallback
mtime(){ stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
agd(){ [[ -e "$1" ]] && echo $(( (now-$(mtime "$1"))/86400 )) || echo -1; }
agh(){ [[ -e "$1" ]] && echo $(( (now-$(mtime "$1"))/3600 )) || echo -1; }

echo "# 🔭 Proactive Opportunities — $(date -u +%Y-%m-%d)"
echo "_Deterministic scan → turn into proposals. Guardrail: nothing goes external without approval._"

echo; echo "## 💡 Unaddressed learnings"
if [[ -s "$M/learnings.md" ]]; then
  n=$(grep -ciE 'pending' "$M/learnings.md" || true)
  if (( n>0 )); then echo "- ${n} pending marker(s) → act on / promote the real ones:"
    grep -iE 'pending' "$M/learnings.md" | grep -m3 -E 'LRN-|ERR-|^#{2,3} ' | sed 's/^#* */  - /'
  else echo "- none pending ✓"; fi
else echo "- (no learnings.md)"; fi

echo; echo "## 📋 Possibly stalled work"
d=$(agd "$M/active-tasks.md")
if   (( d<0 ));  then echo "- (no active-tasks.md)"
elif (( d>=3 )); then echo "- active-tasks.md untouched ${d}d → check progress / nag the human"
else echo "- active-tasks.md fresh (${d}d) ✓"; fi

echo; echo "## 🩺 Automation health (silent-failure detector)"
flagged=0
for pair in "health-monitor.log:3" "resource-log.md:26" "security-audit-log.md:80" "curator-log.md:200" "cleanup-log.md:200"; do
  lg=${pair%%:*}; lim=${pair##*:}; h=$(agh "$M/$lg")
  if   (( h<0 ));   then echo "- ⚠️ ${lg} missing → its cron may never have run"; flagged=1
  elif (( h>lim )); then echo "- ⚠️ ${lg} stale (${h}h, expect <${lim}h) → cron may be silently failing"; flagged=1; fi
done
ac=$(ls "$M"/*autocommit*.log "$M"/*auto-commit*.log 2>/dev/null | head -1)
[[ -n "${ac:-}" ]] && { h=$(agh "$ac"); (( h>2 )) && { echo "- ⚠️ $(basename "$ac") stale (${h}h) → auto-commit (30-min cron) may be down"; flagged=1; }; }
(( flagged==0 )) && echo "- all monitored crons fresh ✓"

echo; echo "## 🧹 Memory hygiene"
[[ -s "$WS/MEMORY.md" ]] && { kb=$(( $(wc -c <"$WS/MEMORY.md")/1024 )); (( kb>10 )) && echo "- MEMORY.md ${kb}KB → approaching ~10K cap, distill"; }
und=$(ls "$M"/2026-*.md 2>/dev/null | grep -vc synthesis || echo 0)
(( und>0 )) && echo "- ${und} raw daily note(s) — curate the un-synthesized ones into stores"

echo; echo "## ▶️ Reverse-prompting (the differentiator)"
echo "_For each real opportunity above, run:  mdeep \"<the topic>\" 4  → ground ONE concrete proposal in what the human actually cares about. Propose 1–3, highest-leverage first. Draft it; never ship external without approval._"
