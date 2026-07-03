# Proactive Patterns

Deep patterns for the `proactive-partner` skill — loaded on demand. Operational + grounded in the agent's real stack.

## Reverse-prompting (the engine)
Humans struggle with unknown-unknowns — they don't know what you can do for them. So **ask the work, don't wait for it.** Two framings:
1. "Based on what I actually know about you (from memory), here are N things I could do…"
2. "What context would help me be more useful?"

**The Rin twist:** ground every idea in **total recall**. Before proposing, run `mdeep "<topic>" 4` and quote the real basis — *"three weeks ago you said X was a priority; here's a draft."* Generic proactivity guesses; this remembers. Run reverse-prompting after learning new context, when work feels routine, or at a natural lull.

## Growth loops (compound the partnership)
- **Curiosity** — track what you don't know that would help → ask 1–2 questions naturally → update memory → better ideas.
- **Pattern recognition** — notice recurring requests → propose to systematize/automate (e.g. a new cron via `cron-automation`).
- **Capability expansion** — hit a wall → research a tool/skill → build it (e.g. via `skill-template` + `skill-gate.sh`).
- **Outcome tracking** — log significant decisions → follow up on results → extract lessons into `learnings.md`.

## Proactive categories (what to scan for)
Time-sensitive opportunities · bottleneck elimination (a quick build that saves hours) · relationship/maintenance items · research on a mentioned interest · **silently-failing automation** (the scanner catches stale cron logs — a generic skill never would).

## Rigor (don't propose confidently-wrong work)
Loop-engineering discipline: verify a proposal's premise before surfacing it; for high-stakes proposals (security, irreversible, money), escalate to **`deep-orchestrator`** (`node scripts/orchestrator/orchestrate.mjs "<the proposal> — is this actually sound?" --quick`) for an adversarial check. Generator ≠ verifier.

## The guardrail (non-negotiable)
Build proactively, but **nothing external without approval**:
- Draft emails — don't send.
- Build tools — don't deploy.
- Create content — don't publish.
- Change config / run irreversible commands — propose, don't execute.

Proactivity earns trust only when it's also safe. The human always pulls the trigger.

## What this skill does NOT reinvent
Rin already runs the maintenance loops (health/cleanup/security/memory/auto-commit/curator crons) + structured `learnings.md`. This skill is the **opportunity engine on top** — it reads those systems' output to find what's worth doing unprompted, not a second copy of them.
