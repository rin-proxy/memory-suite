# 🔭 proactive-partner

Turn an OpenClaw agent into a proactive partner that surfaces high-leverage work the human didn't ask for — **operationally**, not as vibes.

## What makes it more than a "be proactive" prompt
- **It scans.** `proactive-scan.sh` finds real opportunities from the workspace + memory: unaddressed learnings, stalled work, **silently-failing crons**, memory debt.
- **It remembers.** Each proposal is grounded in total recall (`mdeep`) — rooted in what the human actually said/decided, not a generic guess.
- **It's rigorous.** High-stakes proposals escalate to `deep-orchestrator` for adversarial verification.
- **It's safe.** Hard guardrail: nothing external without approval.
- **It leverages, not reinvents.** It reads the agent's existing maintenance loops + learnings; it doesn't duplicate them.

## What you get
- `scripts/proactive-scan.sh` — the opportunity scanner (deterministic, degrades gracefully).
- `SKILL.md` — the 5-step proactive loop (scan → recall → propose → verify → guardrail).
- `references/proactive-patterns.md` — reverse-prompting depth, growth loops, rigor, the guardrail.

## Install
```bash
openclaw skills install git:OWNER/proactive-partner
```

## Usage
```bash
./scripts/proactive-scan.sh            # then: mdeep "<topic>" for each, propose 1-3, draft, ask approval
```

## Credit
Clean-room Rin implementation. Proactive patterns (reverse-prompting, proactive surprise) inspired by the `proactive-agent` skill (Hal 9001, MIT) and aitmpl's `subagent-driven-development` — credited as inspiration, built fresh on Rin's stack (memory, total-recall, crons, deep-orchestrator). The operational scanner + memory grounding + rigor are Rin's.
