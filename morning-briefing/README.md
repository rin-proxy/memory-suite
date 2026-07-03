# ☀️ morning-briefing

A short, **memory-powered** morning briefing for your AI agent — focus, open loops, where you left off, recently-learned, system health, and today's schedule, in under 2 minutes.

## What makes it different
Generic briefing skills dump a to-do list. This one taps the agent's **own memory stack** — it runs total-recall (`mdeep`) to surface a relevant past detail the human may have forgotten, and reports its **own** health. That's the part a generic briefing can't do.

## What you get
- **`scripts/generate-briefing.sh`** — composes the deterministic skeleton from your memory files (tasks, continuity, learnings, health, cron). Degrades gracefully if a source is missing.
- **`SKILL.md`** — the 7 sections, the ≤15-bullet rule, and the memory-surfacing step.
- **`references/briefing-format.md`** — full spec, data-source map, customization, tone.

## Install
```bash
openclaw skills install git:OWNER/morning-briefing
```

## Usage
```bash
./scripts/generate-briefing.sh            # full briefing
./scripts/generate-briefing.sh --short    # quick pulse
```
Then enrich the 🧠 section with `mdeep` and trim to ≤15 bullets. Optional: wire it to a daily cron (lint the job with the `cron-automation` skill).

## Credit
Clean-room Rin implementation. Pattern inspired by the `ai-daily-briefing` skill and aitmpl's `daily-meeting-update` (the ≤15-bullet brevity rule) — credited as inspiration, no code reused. The memory-surfacing twist is Rin's.
