---
name: proactive-partner
description: Make your agent proactive instead of just reactive. It scans your open work and memory for high-value things you didn't ask about — stalled tasks, lessons you never acted on, jobs failing silently — and proposes them with reasoning, always leaving the final call to you. Use when the agent should anticipate what's useful or surprise you with something worth doing.
version: 1.1.0
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

1. **Scan** — `proactive-scan.sh` → real opportunities: unaddressed learnings · stalled work · **silently-failing crons** · memory debt · **engine-upgrade advisories** (provider-free, approval-gated).
2. **Recall** ★ — for each, run `mdeep "<topic>" 4` (total recall) to ground it in what the human said/decided before. *This is the reverse-prompting engine — proposals rooted in real context, not generic guesses.*
3. **Propose** — 1–3 highest-leverage items, framed as "I noticed X — want me to do Y?". Build drafts.
4. **Verify (rigor)** — sanity-check before proposing; for genuinely high-stakes proposals, escalate to **`deep-orchestrator`** for adversarial verification (don't propose confidently-wrong work).
5. **Guardrail** — draft emails, don't send · build tools, don't deploy · create content, don't publish. **Nothing external without approval.**

## 🔧 Engine-upgrade advisories

The scan also runs a **provider-free** upgrade advisor (`scripts/upgrade-advisor.sh`) that detects when one of Memory Suite's optional install flags would now help — `--with-cron` (recall missing recent memories / no reindex cron), `--with-sqlite-vec` (corpus large enough that queries get slow + heavy), `--with-reranker` (large corpus wants sharper top results). Detection is pure code — no model, no network. The **install is not automatic**: treat each advisory like any other opportunity — surface it with the exact command, and run `install.sh --with-…` **only after the human approves. The agent proposes, the user approves, nothing is ever auto-installed.**

→ Triggers, thresholds, the provider-free detection + the no-auto-install contract: [`references/upgrade-advisor.md`](references/upgrade-advisor.md)

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
