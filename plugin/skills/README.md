# Verona Claude Code skills

These slash commands assist Claude Code (or any AI agent) when authoring Verona agents.

| Command | What it does |
|---|---|
| `/verona:new-agent` | Scaffold a new agent in `agents/<name>/` |
| `/verona:new-task` | Add a new task to an existing agent |
| `/verona:new-connector` | Scaffold a new Connector implementation under `src/connectors/` |
| `/verona:tune-soul` | Refine an agent's `SOUL.md` (OpenClaw-style) |
| `/verona:status` | Run `verona doctor`, `verona schedule list`, summarize health |

## How they're discovered

The skills live in this repo's `plugin/skills/` directory. The plugin manifest at `plugin/.claude-plugin/plugin.json` plus the in-tree `marketplace.json` at the repo root let Claude Code auto-discover the plugin when a session starts in this directory — no `/plugin install` step needed for local use.

When Verona ships a marketplace release, the same layout means external users can install via `/plugin marketplace add blake-simpson/verona && /plugin install verona@verona`.

## Authoring conventions

Each skill lives in `plugin/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`) and a body that briefs Claude on the task. Skills must:

- Read `knowledge/KNOWLEDGE.md` and the relevant entry before code edits.
- Never modify `state/` or write secrets.
- Never co-author commits.
