---
name: new-agent
description: Scaffold a new Verona agent under agents/examples/<name>/ with SOUL.md, tasks/, memory/INDEX.md, and a valid agent.toml. Use when the user wants to create a new agent.
---

# /verona:new-agent

Create a new Verona agent. Before writing files, gather the inputs below from the user — ask short, concrete questions, one or two at a time. Don't make up values.

## Inputs

1. **name** (kebab-case) — agent directory name and `[agent].name`. Must match `^[a-z][a-z0-9-]*$`.
2. **description** — one sentence. What does this agent do?
3. **adapter** — one of `claude-cli` (default, subscription), `anthropic-api`, `openai`, `openrouter`. Recommend `claude-cli` unless the user has a specific reason.
4. **default_effort** — `low` | `medium` | `high` | `max`. Recommend `medium`.
5. **soul_traits** — 3–5 short traits (tone, voice, opinions). You'll expand these into a 200–500 word SOUL.md.
6. **initial_tasks** — for each task ask: id, schedule (cron expression OR "every Nm/h/d") OR `on_message`, prompt summary.
7. **slack** — optional. If yes, ask for the channel (e.g. `#research-feed`).

## Steps

1. Confirm all inputs. Show a one-paragraph summary back to the user before writing anything.
2. Create `agents/examples/<name>/` with:
   - `agent.toml` (use the schema from `src/config/schema.ts`)
   - `SOUL.md` (200–500 words; OpenClaw style — specificity > generality, real opinions over safe positions)
   - `tasks/<task-id>.md` for each declared task — single-line title + body explaining what the task should do, what tools it can use, what it should write to memory
   - `memory/INDEX.md` (initial empty routing table; refer to existing examples)
3. Run `verona agents add agents/examples/<name>` to register it in the state dir (only if state dir is initialized — check `verona doctor` first).
4. Print a short next-steps list: register adapter API keys (if non-claude-cli), `verona connectors add slack` (if slack), `verona schedule run <name>:<task>` for a smoke test.

## Things to NOT do

- Don't put real tokens, real API keys, or real Slack channel IDs in committed files.
- Don't skip `agent.toml` validation — let `verona agents add` fail loudly if you got the schema wrong rather than papering over it.
- Don't write to `state/` directly. Use the CLI.
- Don't co-author commits.

## After scaffolding

If the user asks for a smoke test, suggest:

```bash
VERONA_CLAUDE_BIN="$(which claude)" verona schedule run <name>:<first-task-id>
verona logs <name> --latest
```

If the agent uses Slack, walk them through:

```bash
verona connectors add slack    # interactive token paste
verona connectors test slack --destination '#their-channel'
```
