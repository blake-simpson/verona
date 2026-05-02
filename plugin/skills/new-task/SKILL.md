---
name: new-task
description: Add a new task to an existing Verona agent. Updates agent.toml and creates tasks/<id>.md. Use when the user wants to extend an existing agent with another scheduled or on_message task.
---

# /verona:new-task

Add a task to an existing agent.

## Inputs

1. **agent name** — must already exist under `agents/examples/<name>/` or `<state>/agents/<name>/`.
2. **task id** — kebab-case, unique within the agent.
3. **trigger** — one of:
   - `schedule = "<cron-or-friendly>"` (e.g. `"0 3 * * *"`, `"every 30m"`)
   - `on_message = true` (fires on inbound message via Slack/webhook)
   - both (cron + reactive)
4. **effort** — overrides the agent default; one of `low | medium | high | max`. Optional.
5. **budget_usd** — optional per-task cap (only enforced for API-key adapters).
6. **allowed_tools** — optional array. Common values: `Read`, `Write`, `Edit`, `WebFetch`, `Bash(curl:*)`.
7. **prompt** — body for `tasks/<task-id>.md`. Should explain the task's goal, what tools to use, what to write to memory.

## Steps

1. Confirm the agent exists. If not, suggest `/verona:new-agent` instead.
2. Confirm the task id doesn't already exist in `agent.toml`.
3. Add a `[[tasks]]` block to `agent.toml` with the inputs above.
4. Create `tasks/<task-id>.md` with the supplied prompt body.
5. Validate by running `verona schedule list` (if state dir is initialized) — the new task should appear with the expected schedule.
6. Suggest a smoke test: `verona schedule run <agent>:<task>`.

## Things to NOT do

- Don't reorder existing tasks in `agent.toml` (preserve user ordering).
- Don't change the agent's `[agent]` block, soul, or memory config — that's `/verona:tune-soul` and `/verona:new-agent` territory.
- Don't write to `state/`.
