---
name: status
description: Report Verona's current health — daemon state, registered agents, scheduled jobs, recent invocations, costs. Use when the user asks 'how's Verona doing' or 'what did the agents do last night'.
---

# /verona:status

Surface a one-screen health view.

## Steps (in order)

1. **Doctor**: run `verona doctor`. If anything fails (claude not installed, perms wrong, state dir missing), surface it FIRST — nothing below matters.
2. **Daemon process**: check whether the launchd / systemd service is running. On Mac: `launchctl list | grep com.verona.daemon`. On Linux: `systemctl --user status verona-daemon`. If not running, suggest the right install/start command from `deploy/README.md`.
3. **Registered agents**: `verona agents list`.
4. **Schedule**: `verona schedule list` (full table) and `verona schedule next` (closest fire).
5. **Recent activity**: `verona invocations --since 24h --limit 20`.
6. **Costs**: `verona costs`. Call out subscription vs metered separately.
7. **Errors**: `verona invocations --failed --since 7d` — anything in the last week worth a follow-up?

## Output format

Group output as five sections with headings:

```
== Health ==
== Schedule ==
== Recent activity ==
== Costs ==
== Issues ==
```

Keep it scannable — bullet lines, not paragraphs.

## Things to NOT do

- Don't fix anything. This skill REPORTS; it does not fix. If something's broken, point at the right repair skill (`/verona:new-agent`, `/verona:new-task`, etc.) or CLI command.
- Don't show successful invocation bodies (huge, noisy). Just one-liner summaries from `verona invocations`.
- Don't proactively run agents (no `verona schedule run`).
