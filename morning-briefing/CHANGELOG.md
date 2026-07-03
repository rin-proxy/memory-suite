# Changelog — morning-briefing

## 1.0.0 (2026-06-16)
- Initial release. Clean-room Rin build (ATM of `ai-daily-briefing` + aitmpl `daily-meeting-update`).
- `generate-briefing.sh`: composes 7 sections from the agent's memory stack, degrades gracefully.
- Memory-surfacing step (agent runs `mdeep` total-recall) = the differentiator.
- PDA-structured: lean SKILL.md + `references/briefing-format.md`; ≤15-bullet / <2-min rule.
