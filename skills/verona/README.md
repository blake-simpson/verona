# Verona Claude Code skills

These slash commands assist Claude Code (or any AI agent) when authoring Verona agents.

| Command | What it does |
|---|---|
| `/verona:new-agent` | Scaffold a new agent in `agents/examples/<name>/` |
| `/verona:new-task` | Add a new task to an existing agent |
| `/verona:new-connector` | Scaffold a new Connector implementation under `src/connectors/` |
| `/verona:tune-soul` | Refine an agent's `SOUL.md` (OpenClaw-style) |
| `/verona:status` | Run `verona doctor`, `verona schedule list`, summarize health |

## Installation

These skills are stored in this project's `skills/verona/` directory. To make them invocable via slash commands in Claude Code, point Claude Code at this dir (e.g. via your project's `.claude/settings.json`) or copy them into `~/.claude/skills/`.

## Authoring conventions

Each skill lives in `skills/verona/<name>/SKILL.md` with YAML frontmatter (`name`, `description`) and a body that briefs Claude on the task. Skills must:

- Reference `~/.claude/plans/we-are-in-new-expressive-kay.md` for current state if work is in flight.
- Read `knowledge/KNOWLEDGE.md` and the relevant entry before code edits.
- Never modify `state/` or write secrets.
