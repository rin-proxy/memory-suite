#!/usr/bin/env bash
# consolidate.sh — LAYER 3 (nightly consolidation) · autonomous maintenance, PROVIDER-FREE BY DEFAULT.
#
# The heavier nightly counterpart to heartbeat.sh. It runs the DETERMINISTIC (pure-code, cloud-free)
# consolidation passes, then hands the JUDGMENT part to a PLUGGABLE, OPT-IN LLM step — or, if no model
# is configured, leaves a queue for the running agent. Nothing is ever hard-deleted (prune = archive).
#
# DETERMINISTIC passes (always run, provider-free — reuse the shared semantic stack):
#   A. dedup sweep      — cross-file near-duplicate detector over the index using reconcile.mjs's
#                         thresholds (RECONCILE.HIGH/MID) + store.mjs cosine. FLAGS pairs; never merges
#                         (merging is judgment → left to the LLM step / agent).
#   B. decay-prune      — move entries whose decay factor has bottomed out at the floor (decay.mjs)
#                         into memory/.archive/ — a NON-DESTRUCTIVE move (recoverable, audited), never
#                         a delete. Conservative gates (age + importance + never 00-core).
#   C. surface          — resurface stale-but-important memories via surface.mjs (importance × staleness).
#   D. review scan      — collect notes still carrying a `reconcile: review` write-time flag.
#   E. rebuild index    — incremental reindex + strip archived/queued/orphaned keys from recall.
#
# PLUGGABLE LLM step (the "consolidate / summarize / reflect" JUDGMENT — OPT-IN, never hard-required):
#   • env MEMORY_LLM_CMD set  → the candidate items (A–D) are formatted into a consolidation prompt and
#       piped to that command (any local LLM / OpenClaw model-run). Its output is APPENDED as a dated
#       consolidation record under memory/04-meta/consolidations/ (a proposal/summary — NOT a silent
#       destructive rewrite of your memories). If the command fails/returns nothing, we fall back to the
#       queue so the work is never lost.
#   • env MEMORY_LLM_CMD unset → the SAME prompt + candidates are written to
#       memory/.consolidation/queue-<date>.md for the running agent to process. This is the default.
#
# HONEST SCOPE: there is no fake autonomous "mind" here. The deterministic passes are real code; the
# smart part is opt-in and, even when enabled, produces a reviewable record rather than mutating curated
# notes behind your back. Guarded + best-effort throughout: a missing node / stack / model degrades
# gracefully (passes that need them are skipped, the queue is still produced).
#
# Usage:  consolidate.sh [--ws PATH] [--top N] [--dry-run] [-h|--help]
#   --ws       workspace root (default: $OPENCLAW_WORKSPACE, else ~/.openclaw/workspace)
#   --top      how many stale-but-important items to surface (default: 8; env CONSOLIDATE_SURFACE_TOP)
#   --dry-run  compute + report + write the queue, but do NOT move any file into the archive.
# Env knobs (all optional): MEMORY_LLM_CMD, RECONCILE_HIGH, RECONCILE_MID,
#   CONSOLIDATE_PRUNE_AGE_DAYS (90), CONSOLIDATE_PRUNE_FACTOR (0.35),
#   CONSOLIDATE_PRUNE_IMPORTANCE (0.6), CONSOLIDATE_MAX_PRUNE (50), CONSOLIDATE_DEDUP_MAX (40).
# Meant to run nightly in local TZ (opt-in cron via install.sh --with-cron). Safe to run by hand.
set -uo pipefail

WS_ARG=""; SURFACE_TOP="${CONSOLIDATE_SURFACE_TOP:-8}"; DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --ws)      shift; WS_ARG="${1:-}" ;;
    --top)     shift; SURFACE_TOP="${1:-8}" ;;
    --dry-run) DRY=true ;;
    -h|--help)
      sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "consolidate.sh: unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

WS="${WS_ARG:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
MEM="$WS/memory"
SEM="$WS/scripts/semantic"
[ -d "$MEM" ] || { echo "consolidate: no memory store at $MEM (nothing to do)"; exit 0; }

# --- tunables (env-overridable) ----------------------------------------------------------------------
PRUNE_AGE="${CONSOLIDATE_PRUNE_AGE_DAYS:-90}"      # only archive things unseen this many days
PRUNE_FACTOR="${CONSOLIDATE_PRUNE_FACTOR:-0.35}"   # ...whose decay factor has sunk to ~the floor (0.30)
PRUNE_IMP="${CONSOLIDATE_PRUNE_IMPORTANCE:-0.6}"   # ...and are below this importance (never prune important)
MAX_PRUNE="${CONSOLIDATE_MAX_PRUNE:-50}"           # hard cap per run (safety)
DEDUP_MAX="${CONSOLIDATE_DEDUP_MAX:-40}"           # cap dedup pairs reported

TAB="$(printf '\t')"
DATE="$(date -u +%Y-%m-%d)"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
INDEX_JSON="$MEM/.semantic/index.json"
DECAY_JSON="$MEM/.semantic/decay-scores.json"
AUDIT="$MEM/04-meta/audit.log"
ARCHIVE_DIR="$MEM/.archive"
QUEUE_DIR="$MEM/.consolidation"
QUEUE="$QUEUE_DIR/queue-$DATE.md"
CONS_DIR="$MEM/04-meta/consolidations"
mkdir -p "$QUEUE_DIR" "$ARCHIVE_DIR" "$CONS_DIR" "$MEM/04-meta" 2>/dev/null || true

# scratch files (bash-3.2 safe; cleaned on exit)
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/consolidate.XXXXXX" 2>/dev/null || echo "")"
[ -n "$TMPD" ] || { echo "consolidate: cannot make a temp dir; aborting (nothing changed)"; exit 0; }
cleanup() { rm -rf "$TMPD" 2>/dev/null || true; }
trap cleanup EXIT
DEDUP_OUT="$TMPD/dedup.tsv"; : > "$DEDUP_OUT"
PRUNE_OUT="$TMPD/prune.tsv"; : > "$PRUNE_OUT"
SURFACE_OUT="$TMPD/surface.txt"; : > "$SURFACE_OUT"
REVIEW_OUT="$TMPD/review.txt"; : > "$REVIEW_OUT"
ARCHIVED_OUT="$TMPD/archived.txt"; : > "$ARCHIVED_OUT"

HAVE_NODE=false
command -v node >/dev/null 2>&1 && HAVE_NODE=true

echo "🌙 consolidate $TS  ws=$WS  (mode: $([ -n "${MEMORY_LLM_CMD:-}" ] && echo 'LLM step ENABLED' || echo 'provider-free → queue for agent')$( [ "$DRY" = true ] && echo ' · dry-run'))"

# helper: write a portable ESM evaluator to a .mjs temp and run it (imports the installed stack) --------
run_mjs() { # $1=body  $2..=argv ; prints stdout, swallows errors
  local body="$1"; shift
  local f="$TMPD/ev.$$.$RANDOM"
  printf '%s\n' "$body" > "$f.mjs" 2>/dev/null || { return 0; }
  node "$f.mjs" "$@" 2>/dev/null || true
  rm -f "$f.mjs" 2>/dev/null || true
}

# =====================================================================================================
# Pass E-pre: refresh the index so the sweeps see current vectors (best-effort · needs model).
# =====================================================================================================
if $HAVE_NODE && [ -f "$SEM/index.mjs" ]; then
  if ( cd "$SEM" && node index.mjs --incremental ) >/dev/null 2>&1; then
    echo "  ✓ reindex(pre): curated index refreshed"
  else
    echo "  · reindex(pre): skipped/failed (model/node_modules absent or lock held) — best-effort"
  fi
fi

# =====================================================================================================
# Pass A — dedup sweep across the curated store (reuse reconcile.mjs thresholds + store.mjs cosine).
#   Cross-FILE near-duplicate PAIRS over the index's file-lead vectors. Excludes working areas and
#   self-matches. FLAGS only — merging duplicate memories is judgment (LLM step / agent).
# =====================================================================================================
if $HAVE_NODE && [ -f "$INDEX_JSON" ] && [ -f "$SEM/store.mjs" ] && [ -f "$SEM/reconcile.mjs" ]; then
  run_mjs '
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const sem=process.argv[2], ws=process.argv[3], maxPairs=Number(process.argv[4])||40;
const { cosine } = await import(pathToFileURL(sem+"/store.mjs").href);
const { RECONCILE } = await import(pathToFileURL(sem+"/reconcile.mjs").href);
const envF=(n,d)=>{const v=Number.parseFloat(process.env[n]||"");return Number.isFinite(v)?v:d;};
const HIGH=envF("RECONCILE_HIGH",RECONCILE.HIGH), MID=envF("RECONCILE_MID",RECONCILE.MID);
let idx; try{ idx=JSON.parse(fs.readFileSync(ws+"/memory/.semantic/index.json","utf8")); }catch{ process.exit(0); }
const files=[];
for(const [rel,ent] of Object.entries((idx&&idx.files)||{})){
  if(/^memory\/\.(archive|consolidation)\//.test(rel)) continue;
  const ch=((ent&&ent.chunks)||[]).find(c=>Array.isArray(c.vector)&&c.vector.length);
  if(ch) files.push({rel, v:ch.vector, dim:ch.vector.length});
}
const pairs=[];
for(let i=0;i<files.length;i++) for(let j=i+1;j<files.length;j++){
  if(files[i].dim!==files[j].dim) continue;
  const s=cosine(files[i].v, files[j].v);
  if(s>=MID) pairs.push({a:files[i].rel,b:files[j].rel,s});
}
pairs.sort((x,y)=>y.s-x.s);
for(const p of pairs.slice(0,maxPairs)) process.stdout.write((p.s>=HIGH?"DUP":"SIM")+"\t"+p.s.toFixed(3)+"\t"+p.a+"\t"+p.b+"\n");
' "$SEM" "$WS" "$DEDUP_MAX" > "$DEDUP_OUT" 2>/dev/null || true
fi
DEDUP_N=$(grep -c . "$DEDUP_OUT" 2>/dev/null || true); DEDUP_N=${DEDUP_N:-0}
echo "  ✓ dedup sweep: $DEDUP_N near-duplicate pair(s) flagged (thresholds from reconcile.mjs; not merged)"

# =====================================================================================================
# Pass B — decay-prune below the floor → memory/.archive/ (NON-DESTRUCTIVE move · reuse decay.mjs).
# =====================================================================================================
if $HAVE_NODE && [ -f "$DECAY_JSON" ] && [ -f "$SEM/decay.mjs" ]; then
  run_mjs '
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const sem=process.argv[2], ws=process.argv[3];
const AGE=Number(process.argv[4]), FAC=Number(process.argv[5]), IMP=Number(process.argv[6]), MAX=Number(process.argv[7]);
const { decayFactor } = await import(pathToFileURL(sem+"/decay.mjs").href);
let sc; try{ sc=JSON.parse(fs.readFileSync(ws+"/memory/.semantic/decay-scores.json","utf8")); }catch{ process.exit(0); }
const now=Date.now(), out=[];
for(const [rel,e] of Object.entries((sc&&sc.entries)||{})){
  if(!e||typeof e!=="object") continue;
  if(!/^memory\//.test(rel)) continue;
  if(/^memory\/00-core\//.test(rel)) continue;                        // never prune never-decay core
  if(/^memory\/\.(archive|consolidation)\//.test(rel)) continue;      // already in a working area
  const imp = Number.isFinite(e.importance)? e.importance : 0.5;
  if(imp>=IMP) continue;                                              // keep important memories
  const la = Number.isFinite(e.lastAccessMs)&&e.lastAccessMs>0 ? e.lastAccessMs : 0;
  if(!la) continue;                                                   // need a timestamp to age
  const ageDays=(now-la)/86400000;
  if(ageDays<AGE) continue;                                           // not stale enough
  const f=decayFactor(e, now);
  if(f>FAC) continue;                                                 // decay factor not at the floor
  if(!fs.existsSync(ws+"/"+rel)) continue;                            // file must exist to move
  out.push({rel,f:Number(f.toFixed(3)),age:Math.round(ageDays),imp});
}
out.sort((a,b)=>a.f-b.f);
for(const o of out.slice(0,MAX)) process.stdout.write(o.rel+"\t"+o.f+"\t"+o.age+"\t"+o.imp+"\n");
' "$SEM" "$WS" "$PRUNE_AGE" "$PRUNE_FACTOR" "$PRUNE_IMP" "$MAX_PRUNE" > "$PRUNE_OUT" 2>/dev/null || true
fi

PRUNED=0
if [ -s "$PRUNE_OUT" ]; then
  while IFS="$TAB" read -r rel fac age imp; do
    [ -n "${rel:-}" ] || continue
    src="$WS/$rel"
    [ -f "$src" ] || continue
    dstrel="${rel#memory/}"
    dst="$ARCHIVE_DIR/$dstrel"
    if [ "$DRY" = true ]; then
      echo "    would archive: $rel  (factor $fac · ${age}d unseen · imp $imp)"
      printf '%s\t%s\n' "$rel" "(dry-run)" >> "$ARCHIVED_OUT"
      continue
    fi
    mkdir -p "$(dirname "$dst")" 2>/dev/null || true
    if mv "$src" "$dst" 2>/dev/null; then
      PRUNED=$((PRUNED+1))
      printf '%s\t%s\n' "$rel" "memory/.archive/$dstrel" >> "$ARCHIVED_OUT"
      printf '%s | ARCHIVE | %s | consolidate:cron | auto | decay-floor factor=%s age=%sd imp=%s → memory/.archive/%s\n' \
             "$TS" "$rel" "$fac" "$age" "$imp" "$dstrel" >> "$AUDIT" 2>/dev/null || true
      printf '%s\t%s\t%s\tfactor=%s;age=%sd;imp=%s\n' "$DATE" "$rel" "memory/.archive/$dstrel" "$fac" "$age" "$imp" \
             >> "$ARCHIVE_DIR/manifest.tsv" 2>/dev/null || true
    fi
  done < "$PRUNE_OUT"
fi
if [ "$DRY" = true ]; then
  DRYN=$(grep -c . "$ARCHIVED_OUT" 2>/dev/null || true); DRYN=${DRYN:-0}
  echo "  ✓ decay-prune: $DRYN candidate(s) at the floor (dry-run — nothing moved)"
else
  echo "  ✓ decay-prune: archived $PRUNED memor(y/ies) → memory/.archive/ (non-destructive move · audited · never deleted)"
fi

# =====================================================================================================
# Pass C — surface stale-but-important (reuse surface.mjs CLI directly).
# =====================================================================================================
if $HAVE_NODE && [ -f "$SEM/surface.mjs" ]; then
  ( cd "$SEM" && node surface.mjs --top "$SURFACE_TOP" --ws "$WS" ) > "$SURFACE_OUT" 2>/dev/null || true
fi
# don't resurface what we just archived this run (surface.mjs reads decay-scores, not the filesystem).
if [ -s "$ARCHIVED_OUT" ]; then
  cut -f1 "$ARCHIVED_OUT" > "$TMPD/arch-rels.txt" 2>/dev/null || : > "$TMPD/arch-rels.txt"
  if [ -s "$TMPD/arch-rels.txt" ] && grep -vF -f "$TMPD/arch-rels.txt" "$SURFACE_OUT" > "$TMPD/surface.filt" 2>/dev/null; then
    mv "$TMPD/surface.filt" "$SURFACE_OUT"
  fi
fi
[ -s "$SURFACE_OUT" ] || printf '(nothing to resurface)\n' > "$SURFACE_OUT"
SURFACE_N=$(grep -c '^- ' "$SURFACE_OUT" 2>/dev/null || true); SURFACE_N=${SURFACE_N:-0}
echo "  ✓ surface: $SURFACE_N stale-but-important item(s) resurfaced"

# =====================================================================================================
# Pass D — collect notes still carrying a `reconcile: review` write-time flag (needs a verdict).
# =====================================================================================================
grep -rlF 'reconcile: review' "$MEM" 2>/dev/null \
  | grep -Ev '/\.consolidation/|/\.archive/' \
  | sed "s#^$WS/#- \`#; s#\$#\` — judge duplicate/update/contradiction/distinct#" \
  | head -30 > "$REVIEW_OUT" 2>/dev/null || true
REVIEW_N=$(grep -c '^- ' "$REVIEW_OUT" 2>/dev/null || true); REVIEW_N=${REVIEW_N:-0}
echo "  ✓ review scan: $REVIEW_N note(s) awaiting a reconcile verdict"

# =====================================================================================================
# Build the consolidation prompt (the JUDGMENT brief) from the deterministic candidates A–D.
# =====================================================================================================
PROMPT="$TMPD/prompt.md"
{
  echo "# Memory consolidation brief — $DATE"
  echo
  echo "You are consolidating the curated memory store. The deterministic passes below already ran"
  echo "(provider-free). Your job is the JUDGMENT they can't do: (1) MERGE/resolve the duplicate pairs,"
  echo "(2) resolve the \`reconcile: review\` conflicts, (3) summarize/compact where it helps, (4) decide"
  echo "whether any surfaced stale-but-important item should be refreshed or re-pinned, (5) sanity-check"
  echo "the archived list for anything that was actually important (restore it from memory/.archive/)."
  echo "Be honest and grounded — only act on what is listed here. Non-destructive: move/merge, don't delete."
  echo
  echo "## A. Duplicate / near-duplicate pairs  (DUP = cosine ≥ HIGH, SIM = in [MID,HIGH))"
  if [ -s "$DEDUP_OUT" ]; then
    while IFS="$TAB" read -r tag score a b; do
      [ -n "${tag:-}" ] || continue
      echo "- [$tag $score] \`$a\`  ⇔  \`$b\`"
    done < "$DEDUP_OUT"
  else
    echo "- (none flagged)"
  fi
  echo
  echo "## B. Archived this run (decay floor — verify none were important, restore if so)"
  if [ -s "$ARCHIVED_OUT" ]; then
    while IFS="$TAB" read -r rel to; do
      [ -n "${rel:-}" ] || continue
      echo "- \`$rel\` → $to"
    done < "$ARCHIVED_OUT"
  else
    echo "- (none — nothing had sunk to the floor)"
  fi
  echo
  echo "## C. Surfaced stale-but-important (consider refresh / re-pin)"
  cat "$SURFACE_OUT"
  echo
  echo "## D. Notes awaiting a reconcile verdict"
  if [ -s "$REVIEW_OUT" ]; then cat "$REVIEW_OUT"; else echo "- (none)"; fi
  echo
  echo "Output: a short consolidation summary + concrete operations (MERGE/UPDATE/PIN/RESTORE/RESOLVE),"
  echo "each naming the file(s) above. Keep it tight; this is a record, not a rewrite of the store."
} > "$PROMPT"

# =====================================================================================================
# The PLUGGABLE, OPT-IN LLM step — or the provider-free queue fallback.
# =====================================================================================================
LLM_DONE=false
if [ -n "${MEMORY_LLM_CMD:-}" ]; then
  echo "  → LLM step: piping consolidation brief to \$MEMORY_LLM_CMD …"
  LLM_OUT="$TMPD/llm.out"
  if printf '%s\n' "$(cat "$PROMPT")" | eval "$MEMORY_LLM_CMD" > "$LLM_OUT" 2>/dev/null && [ -s "$LLM_OUT" ]; then
    CONS_FILE="$CONS_DIR/consolidation-$DATE.md"
    {
      [ -f "$CONS_FILE" ] || {
        echo "---"; echo "type: meta"; echo "status: active"; echo "date: $DATE"
        echo "source: consolidate"; echo "---"; echo
        echo "# Consolidation record — $DATE"; echo
      }
      echo "## Run $TS  (via \$MEMORY_LLM_CMD)"
      echo
      cat "$LLM_OUT"
      echo
      echo "_Proposal/summary produced by the pluggable LLM step — review before applying structural changes._"
      echo
    } >> "$CONS_FILE" 2>/dev/null || true
    printf '%s | CONSOLIDATE | %s | consolidate:llm | auto | LLM brief applied (dedup=%s prune=%s surface=%s review=%s)\n' \
           "$TS" "${CONS_FILE#$WS/}" "$DEDUP_N" "$PRUNED" "$SURFACE_N" "$REVIEW_N" >> "$AUDIT" 2>/dev/null || true
    echo "  ✓ LLM step: consolidation record appended → ${CONS_FILE#$WS/}"
    LLM_DONE=true
  else
    echo "  ⚠  LLM step: \$MEMORY_LLM_CMD failed or returned nothing — falling back to the queue (work not lost)"
  fi
fi

if [ "$LLM_DONE" = false ]; then
  # provider-free default: leave the brief for the running agent.
  if [ ! -f "$QUEUE" ]; then
    {
      echo "# Consolidation queue — $DATE"
      echo "_Layer 3 · deterministic scaffolding (provider-free). The running agent (or a configured MEMORY_LLM_CMD) processes these, then deletes this file. Nothing here is auto-applied._"
    } > "$QUEUE" 2>/dev/null || true
  fi
  {
    echo
    echo "## Nightly consolidation — $TS"
    echo
    cat "$PROMPT"
  } >> "$QUEUE" 2>/dev/null || true
  printf '%s | CONSOLIDATE | %s | consolidate:cron | auto | queued for agent (dedup=%s prune=%s surface=%s review=%s)\n' \
         "$TS" "${QUEUE#$WS/}" "$DEDUP_N" "$PRUNED" "$SURFACE_N" "$REVIEW_N" >> "$AUDIT" 2>/dev/null || true
  echo "  ✓ queue: consolidation brief written → ${QUEUE#$WS/}  (set MEMORY_LLM_CMD to auto-run the judgment step)"
fi

# =====================================================================================================
# Pass E — rebuild the index (post-prune) + keep archived/queued/orphaned notes out of active recall.
# =====================================================================================================
if $HAVE_NODE && [ -f "$SEM/index.mjs" ]; then
  ( cd "$SEM" && node index.mjs --incremental ) >/dev/null 2>&1 || true
fi
if $HAVE_NODE && [ -f "$INDEX_JSON" ]; then
  stripped="$(node -e '
    const fs=require("fs");const p=process.argv[1],ws=process.argv[2];
    try{const j=JSON.parse(fs.readFileSync(p,"utf8"));const F=(j&&j.files)||{};let n=0;
      for(const k of Object.keys(F)){if(/^memory\/\.(archive|consolidation)\//.test(k)||!fs.existsSync(ws+"/"+k)){delete F[k];n++;}}
      if(n){const t=p+".tmp";fs.writeFileSync(t,JSON.stringify(j));fs.renameSync(t,p);}
      process.stdout.write(String(n));}catch(e){process.stdout.write("0");}
  ' "$INDEX_JSON" "$WS" 2>/dev/null || echo 0)"
  [ "${stripped:-0}" != "0" ] && echo "  ✓ index: stripped $stripped archived/queued/orphaned entr(y/ies) from recall"
fi
# decay housekeeping: drop score entries whose file is gone (incl. the ones we just archived).
if $HAVE_NODE && [ -f "$DECAY_JSON" ]; then
  node -e '
    const fs=require("fs");const p=process.argv[1],ws=process.argv[2];
    try{const j=JSON.parse(fs.readFileSync(p,"utf8"));if(!j||!j.entries){process.exit(0);}let n=0;
      for(const k of Object.keys(j.entries)){if(!fs.existsSync(ws+"/"+k)){delete j.entries[k];n++;}}
      if(n){const t=p+".tmp";fs.writeFileSync(t,JSON.stringify({version:1,entries:j.entries}));fs.renameSync(t,p);}
    }catch(e){}
  ' "$DECAY_JSON" "$WS" 2>/dev/null || true
fi

echo "🌙 consolidate done — deterministic passes ran; judgment $([ "$LLM_DONE" = true ] && echo 'applied via LLM step' || echo 'queued for the agent'). Nothing hard-deleted."
