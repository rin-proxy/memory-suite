# Briefing Format Reference

Full format spec, data sources, customization, and tone for the `morning-briefing` skill — loaded on demand.

## Data-source map (what each section pulls)
| Section | Source file(s) | Notes |
|---|---|---|
| 🎯 Focus | `memory/active-tasks.md` (first heading) | the single #1 |
| 🔄 Where we left off | `memory/last-conversation.md` | continuity note |
| 📋 Pending | `memory/active-tasks.md` (headings) | overdue/today/week if structured |
| 🧠 Memory surfacing | **agent runs `mdeep`** | + `memory/05-connections/` |
| 💡 Recently learned | `memory/learnings.md` → `curator-log.md` | latest entry |
| 🩺 Health | `memory/health-monitor.log` + `free -m` | last status line + mem pressure |
| ⏰ Scheduled | `crontab -l` | today's jobs |

The script **degrades gracefully** — any missing source becomes a `(no …)` line, never an error.

## Output rules
- **≤15 bullets total, <2 minutes to read.** Lead with focus. Cut anything that isn't actionable or surprising.
- One blank line between sections; bullets only (no walls of text).
- The 🧠 line should be the *highest-signal* item — a specific recalled detail, not a generic reminder.

## Variations
- `--short` — drops 🩺 Health + ⏰ Scheduled (use for a quick start-of-session pulse).
- **Cron delivery** — wire `generate-briefing.sh` to a daily cron (e.g. `0 0 * * *` UTC = 07:00 WIB) and announce to a channel. (Use the `cron-automation` skill to lint the job.)
- **Custom workspace** — pass a path: `./generate-briefing.sh /path/to/ws`.

## How the agent should assemble it
1. Run `generate-briefing.sh` → get the deterministic skeleton.
2. Replace the 🧠 placeholder: run `mdeep "<topic>" 4`, pick the single most relevant past detail, write it as one line.
3. Trim to ≤15 bullets. If a section is empty/low-value, drop it entirely.
4. Deliver. Tone: warm, concise, owner-not-employee — "here's what matters today," not a status report.

## Tone
- Speak to the human, not about them. "You left off at…", "today's #1 is…".
- Surface, don't dump. A briefing's value is *judgment* (what matters), not completeness.
- Never pad. If it's a quiet day, a 5-bullet briefing is a great briefing.
