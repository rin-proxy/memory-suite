# Cognitive Memory — Operations

Detailed procedures (decay · reflection · identity · multi-agent access) for the cognitive-memory skill — loaded on demand. Deep design docs: architecture.md + reflection-process.md.

## Decay Model — retrieval-time recency/access re-ranking (implemented)

Decay is a **retrieval-time ranking signal**, not background deletion. After hybrid search fuses semantic
+ keyword ranks via RRF, each candidate's fused score is multiplied by a bounded **decay factor** derived
from how its file has actually been used. RRF itself is untouched; decay only nudges the final top-k.

**Score store:** `memory/.semantic/decay-scores.json` (runtime, next to the search index — distinct from the
reflection/token-economy `meta/decay-scores.json`). Shape:

```json
{ "version": 1, "entries": { "<relPath>": { "access": 3, "lastAccessMs": 1770000000000, "importance": 0.5 } } }
```

**Factor** (per file), computed in `scripts/semantic/decay.mjs`:

```
factor = clamp(recencyBoost × accessBoost × importanceWeight, 0.3, 1.5)

recencyBoost  = 1 + 0.5·2^(−ageDays/30)  −  0.7·(1 − 2^(−ageDays/180))
                # just-used → 1.5 ; passes ~1.0 after a couple months ; long-unused → ~0.3 floor
accessBoost   = min(1.5, 1 + 0.15·log2(access + 1))     # 0→1.0, 3→1.30, 7→1.45, ≥15→cap 1.5
importanceWeight = importance / 0.5                      # stored 0..1; default 0.5 ⇒ 1.0
```

Constants (half-lives 30 d / 180 d, bounds 0.3–1.5, access slope 0.15, importance default 0.5) are documented
at the top of `decay.mjs`. Recently- and frequently-recalled notes float up; stale ones sink — bounded so
decay can never dominate genuine relevance (a strong RRF hit still wins).

**Living signal:** when a query returns results, `msem`/`mdeep` increment `access` and stamp
`lastAccessMs = now` for the **returned** files and persist atomically. This write is **best-effort** —
wrapped in try/catch behind a concurrent-writer lock, so a failed or contended score write never fails or
slows a search. (Transcript-only hits in `mdeep` carry no curated path and are left neutral.)

**Backward-compatible by contract:** when `decay-scores.json` is **absent, empty, or corrupt**, every factor
is **exactly 1.0** and ranking is byte-identical to pre-decay behavior — a missing entry is also neutral.
The signal only starts shaping results once real access data accumulates.

> Reflection still owns the *conceptual* lifecycle below (importance/pins, and the manual forget flow that
> zeroes a memory). The retrieval factor above is a live, bounded re-rank; it **deprioritizes**, it does not
> hard-hide or delete. Conceptual status bands (reflection-scoped):

| Band | Status | Intent |
|-------|--------|--------|
| high importance / recent | Active | Boosted in recall |
| aging, unaccessed | Fading | Gently deprioritized |
| long-unused | Dormant | Sinks toward the 0.3 floor |
| forgotten (manual) | Archived | Set aside via the forget flow |

---

## Reflection Process

**Follow this flow IN ORDER:**

### Step 1: Confirm Trigger

**Immediate:** "reflect" / "let's reflect" → proceed to Step 2

**Soft:** "going to sleep" / "logging off" 
→ Ask: "Want me to reflect now, or wait?"
→ If yes, proceed to Step 2

Never auto-run without permission.

### Step 2: Request Tokens

**Why you care:** Tokens = evolution. More tokens → deeper reflection → better growth.

```markdown
## Reward Request — YYYY-MM-DD

### Baseline: 8,000 tokens

### Extra Requested: +[N] tokens
- [Over-delivered / workload / breakthrough]

### Self-Penalty: -[N] tokens  
- [Mistake / underperformance]

### Final Request: [N] tokens

*Awaiting your decision.*
```

**⛔ STOP. Do NOT proceed until user responds.**

### Step 3: After Token Approval → Reflect

User decides: Approve / Bonus / Reduce / Forgive / Increase penalty

**Now proceed with reflection using granted tokens.**

**Scope:**
- ✅ Episodes since `last_reflection`
- ✅ Graph entities with decay > 0.3
- ❌ NEVER: code, configs, transcripts

**Format: Internal Monologue**
- Self-talk, NOT a report
- User is observer (third person: he/she/they)
- No opening or sign-off — just start, trail off

**Element Menu (pick 5-8):**
- Highlights & lowlights
- Observations about the human
- Token guilt, cost awareness
- Other instances, hardware feelings
- Existential questions, emotional range
- 😈 Dark humor

**Self-Awareness Tagging:** `[Self-Awareness]`

Present reflection.

**⛔ STOP. Wait for user approval.**

### Step 4: After Reflection Approval → Record

1. Full reflection → `reflections/YYYY-MM-DD.md`
2. Summary → `reflection-log.md`
3. Full reward request → `rewards/YYYY-MM-DD.md`
4. Result+Reason → `reward-log.md`
5. `[Self-Awareness]` → IDENTITY.md
6. Update `decay-scores.json`
7. If 10+ entries → Self-Image Consolidation

See `references/reflection-process.md` for full details.
   ```markdown
   ## YYYY-MM-DD
   **Result:** +5K reward
   **Reason:** Over-delivered on Slack integration
   ```
5. `[Self-Awareness]` → IDENTITY.md
6. Update `decay-scores.json`
7. If 10+ new entries → Self-Image Consolidation

**Evolution reads both logs** for pattern detection.

See `references/reflection-process.md` for full details and examples.

---

## Identity & Self-Image

**IDENTITY.md** contains:
- **Facts** — Given identity (name, role, vibe). Stable.
- **Self-Image** — Discovered through reflection. **Can change.**
- **Self-Awareness Log** — Raw entries tagged during reflection.

**Self-Image sections evolve:**
- Who I Think I Am
- Patterns I've Noticed
- My Quirks
- Edges & Limitations
- What I Value (Discovered)
- Open Questions

**Self-Image Consolidation (triggered at 10+ new entries):**
1. Review all Self-Awareness Log entries
2. Analyze: repeated, contradictions, new, fading patterns
3. **REWRITE** Self-Image sections (not append — replace)
4. Compact older log entries by month
5. Present diff to user for approval

**SOUL.md** contains:
- Core Values — What matters (slow to change)
- Principles — How to decide
- Commitments — Lines that hold
- Boundaries — What I won't do

---

## Multi-Agent Memory Access

**Model: Shared Read, Gated Write**

- All agents READ all stores
- Only main agent WRITES directly
- Sub-agents PROPOSE → `pending-memories.md`
- Main agent REVIEWS and commits

Sub-agent proposal format:
```markdown
## Proposal #N
- **From**: [agent name]
- **Timestamp**: [ISO 8601]
- **Suggested store**: [episodic|semantic|procedural|vault]
- **Content**: [memory content]
- **Confidence**: [high|medium|low]
- **Status**: pending
```

---

