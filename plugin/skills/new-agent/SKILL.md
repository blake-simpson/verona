---
name: new-agent
description: Scaffold a new Verona agent in the user-agents dir (default ~/.verona/agents/<name>/) with SOUL.md, tasks/, memory/INDEX.md, and a valid agent.toml. Use when the user wants to create a new agent.
---

# /verona:new-agent

Create a new Verona agent in the **user-agents dir** (default `~/.verona/agents/<name>/`, override via `$VERONA_AGENTS_DIR`).

**DO NOT write to `agents/examples/` in the Verona source repo.** That dir holds read-only canonical templates. The user's own agents live separately so `git pull` of Verona never touches them.

If the user wants to start from a bundled template, run `verona agents init <name> --template <template>` (CLI does the copy + name rewrite). Use this skill for from-scratch authoring or for guided customization beyond what `init` produces.

## Inputs

1. **name** (kebab-case) — agent directory name and `[agent].name`. Must match `^[a-z][a-z0-9-]*$`.
2. **description** — one sentence. What does this agent do?
3. **adapter** — one of `claude-cli` (default, subscription), `anthropic-api`, `openai`, `openrouter`. Recommend `claude-cli` unless the user has a specific reason.
4. **default_effort** — `low` | `medium` | `high` | `max`. Recommend `medium`.
5. **soul_traits** — 3–5 short traits (tone, voice, opinions). You'll expand these into a 200–500 word SOUL.md.
6. **initial_tasks** — cron tasks only by default. For each, ask: id, schedule (cron expression or `every Nm/h/d`), prompt summary. **Don't ask about `on_message`** — Slack/inbound replies just resume the prior session and need no task definition. Only suggest an `on_message = true` task if the user explicitly wants a strict per-message protocol (e.g. a triage prompt that must run on every reply).
7. **slack** — optional. If yes, ask for the channel (e.g. `#research-feed`).

## Resolve target dir

```
target_dir = $VERONA_AGENTS_DIR/<name>/    # if env var set
           = ~/.verona/agents/<name>/      # otherwise
```

Refuse to overwrite if `target_dir` already exists. Suggest a different name.

## Steps

1. Confirm all inputs. Show a one-paragraph summary back to the user before writing anything.
2. Create `<target_dir>/` with:
   - `agent.toml` — schema in `src/config/schema.ts`
   - `SOUL.md` — 200–500 words; OpenClaw style (specificity > generality, real opinions over safe positions)
   - `tasks/<task-id>.md` for each declared task — title + body explaining the task's goal, allowed tools, what to write to memory
   - `memory/INDEX.md` — initial routing table (mirror the structure of `agents/examples/*/memory/INDEX.md`)
3. Run `verona agents add <target_dir>` to register it in the state dir. Skip this step if `verona doctor` reports the state dir is missing — point the user at `verona init` first.
4. Print a short next-steps list: register adapter API keys (if non-claude-cli), `verona connectors add slack` (if slack), `verona schedule run <name>:<task>` for a smoke test.

## Things to NOT do

- **Don't write into `agents/examples/`** — that's the source repo's read-only template tree.
- Don't put real tokens, API keys, or Slack channel IDs in committed files.
- Don't skip `agent.toml` validation — let `verona agents add` fail loudly if you got the schema wrong.
- Don't write to `state/` directly. Use the CLI.
- Don't co-author commits.

## After scaffolding

If the user asks for a smoke test, suggest:

```bash
verona schedule run <name>:<first-task-id>
verona logs <name> --latest
```

If the agent uses Slack:

```bash
verona connectors add slack    # interactive token paste
verona connectors test slack --destination '#their-channel'
```
