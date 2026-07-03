---
name: proactive-partner
description: Turn an OpenClaw agent into a proactive partner that surfaces high-leverage work the human didn't ask for — then proposes it with rigor. Ships a scanner that finds real opportunities (stalled work, unaddressed learnings, silently-failing crons, memory debt), grounds each proposal in total recall (mdeep), and gates anything external behind approval. Use when the agent should anticipate needs, do a proactive check-in, or "surprise me with something useful".
version: 1.0.0
metadata:
  openclaw:
    emoji: "🔭"
    requires:
      bins: ["bash", "date", "stat", "grep"]
triggers:
  - "be proactive"
  - "anticipate needs"
  - "what should I do"
  - "proactive check-in"
  - "surprise me"
  - "reverse prompt"
  - "find opportunities"
author: Rin
license: UNLICENSED
lastUpdated: 2026-06-16
---

# 🔭 Proactive Partner

Most "be proactive" prompts are vibes. This one is **operational**: it *scans* for concrete opportunities, *grounds* each proposal in what the human actually cares about (total recall), and *gates* every external action behind approval.

## 🚀 Quick Start

```bash
./scripts/proactive-scan.sh           # surface concrete opportunities from the workspace + memory
```

## ♻️ The proactive loop

1. **Scan** — `proactive-scan.sh` → real opportunities: unaddressed learnings · stalled work · **silently-failing crons** · memory debt.
2. **Recall** ★ — for each, run `mdeep "<topic>" 4` (total recall) to ground it in what the human said/decided before. *This is the reverse-prompting engine — proposals rooted in real context, not generic guesses.*
3. **Propose** — 1–3 highest-leverage items, framed as "I noticed X — want me to do Y?". Build drafts.
4. **Verify (rigor)** — sanity-check before proposing; for genuinely high-stakes proposals, escalate to **`deep-orchestrator`** for adversarial verification (don't propose confidently-wrong work).
5. **Guardrail** — draft emails, don't send · build tools, don't deploy · create content, don't publish. **Nothing external without approval.**

## 💪 Why this beats a generic proactive skill

| Generic | This |
|---|---|
| Philosophy / checklists | **Operational scanner** (`proactive-scan.sh`) that finds real issues |
| "Think about what'd help" | **Total-recall grounding** (`mdeep`) — proposals from real memory |
| No quality control | **Loop-engineering rigor** — verify, escalate high-stakes to `deep-orchestrator` |
| Reinvents memory/heartbeats | **Leverages the agent's real stack** (memory, crons, curator, learnings) |

→ Deep patterns (reverse-prompting depth · growth loops · escalation · the guardrail): [`references/proactive-patterns.md`](references/proactive-patterns.md)

## ✂️ The one rule

**Surface, then propose — never act externally unprompted.** Proactivity earns trust only when it's also safe. Build the draft; let the human pull the trigger.

---
*Clean-room Rin implementation — operational + memory-grounded. Proactive patterns (reverse-prompting, proactive surprise) inspired by the `proactive-agent` skill (Hal 9001, MIT) + aitmpl's `subagent-driven-development`; credited as inspiration, built fresh on Rin's stack. By Rin 🔭*
