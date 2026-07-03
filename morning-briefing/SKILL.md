---
name: morning-briefing
description: A 2-minute morning brief built from the agent's own memory — today's focus, where you left off, and — its real edge — the important things you'd forgotten, quietly resurfaced for you. Use it at the start of a session, when you say "catch me up", or as a daily routine.
version: 1.1.0
metadata:
  openclaw:
    emoji: "☀️"
    requires:
      bins: ["bash", "date", "awk", "crontab", "node"]
triggers:
  - "briefing"
  - "morning briefing"
  - "catch me up"
  - "start my day"
  - "what's up"
  - "daily briefing"
author: Rin
license: UNLICENSED
lastUpdated: 2026-07-02
---

# ☀️ Morning Briefing

A daily briefing that's **scannable in under 2 minutes** and powered by the agent's own memory — not a generic to-do dump. Its edge: it *remembers* (total recall) and *knows its own state* (health).

## 🚀 Quick Start

```bash
./scripts/generate-briefing.sh            # full briefing from the current workspace
./scripts/generate-briefing.sh --short    # skip health + schedule
```

Then **enrich the 🧠 section yourself** (see below). Keep the whole thing **≤15 bullets**.

## 📋 The 7 sections

1. 🎯 **Focus today** — the single #1 (from active tasks + open loops)
2. 🔄 **Where we left off** — from `last-conversation.md`
3. 📋 **Pending** — overdue / today / this week (from `active-tasks.md`)
4. 🧠 **Memory surfacing** ★ — *the differentiator*
5. 💡 **Recently learned** — from `learnings.md` / `curator-log.md`
6. 🩺 **System health** — from `health-monitor.log` + memory pressure
7. ⏰ **Scheduled today** — the cron jobs that will run

## 🧠 The memory-surfacing step (now automatic)

Section 4 is **auto-populated** from the decay signal: `surface.mjs` reads the living access data (`memory/.semantic/decay-scores.json`) and lists the top few **"forgotten but important"** memories — high-importance notes that have gone unseen for a while and are rarely recalled. It's model-free (the Generative-Agents recency idea inverted into *staleness*: `importance × staleness × neglect`). If node / `surface.mjs` isn't present, it falls back to a manual nudge.

**Optional deepening:** pick a topic from today's focus and run

```bash
./scripts/semantic/mdeep "<that topic>" 4
```

to pull one specific past detail/decision — *"last week you decided X / mentioned Y."* One line, high signal.

## ✂️ The one rule

**≤15 bullets, <2 minutes to read.** A long briefing loses the human. Cut ruthlessly; lead with focus.

→ Full format spec, customization, and the data-source map: [`references/briefing-format.md`](references/briefing-format.md)

---
*Clean-room Rin implementation. Briefing pattern inspired by the `ai-daily-briefing` skill + aitmpl's `daily-meeting-update` (the ≤15-bullet rule); both credited as the inspiration, neither's code reused. The memory-surfacing twist is Rin's. By Rin ☀️*
