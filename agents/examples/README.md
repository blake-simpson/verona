# Verona example agents

These are **read-only canonical templates** bundled with Verona. They're documentation-by-example: the smallest correct shape of an agent.

**You should not edit these files for your own use.** When the source repo updates, your edits will be lost or merge-conflict. Instead, copy a template into your **user-agents dir** (default `~/.verona/agents/`) and edit there.

## Usage

```bash
# Pick a template, scaffold a personal copy:
verona agents init my-research --template researcher

# Review and edit:
$EDITOR ~/.verona/agents/my-research

# Register into the state tree:
verona agents add ~/.verona/agents/my-research

# Run it:
verona schedule run my-research:nightly-scan
```

The `verona agents init` command:
1. Copies the template dir into `$VERONA_AGENTS_DIR/<name>/` (default `~/.verona/agents/<name>/`).
2. Rewrites `[agent].name` in the new `agent.toml` to match `<name>`.
3. Does NOT auto-register — you review first, then `verona agents add` to wire it up.

## Available templates

| Template | What it demonstrates |
|---|---|
| `hello-world` | Minimal smoke test. Single cron task, no connectors. Run this first to confirm Verona is wired correctly on your host. |
| `researcher` | Full bidirectional flow — cron 03:00 nightly scan + on_message thread replies + Slack channel + WebFetch tool. Closest to a real production agent. |

## Why a separate user-agents dir?

The Verona source repo is "Tree 1" of three:

| Tree | What | Edited by |
|---|---|---|
| **1. Source** (this repo) | Verona itself + these read-only templates | Verona maintainers |
| **2. User agents** (`~/.verona/agents/`) | YOUR agent definitions | YOU |
| **3. State** (`~/.verona/state/`) | Memory, secrets, sessions, audit log | The daemon at runtime |

Trees 2 and 3 live outside the source repo so `git pull` and `verona deploy` never clobber them.

## Adding a new template

If you've authored an agent that's genuinely generic and useful as a starter for others, propose it here via PR:
1. Add `agents/examples/<your-template-name>/` with the same shape (agent.toml, SOUL.md, tasks/, memory/INDEX.md).
2. Add a row to the table above.
3. Make sure the SOUL.md is generic enough to be a starting point, not your personal voice.
