# Verona Knowledge Index

This is a routing table for Claude Code (or any agent) working on Verona itself. Open only the entries you need.

**Worker agents at runtime never see this directory** — it is excluded from the `verona build` artifact. Keep that distinction live.

## How to use

1. Identify the domain you're touching (adapter, connector, memory, deploy, conventions).
2. Open the matching entry below.
3. If you find your task isn't covered or the entry is wrong, **amend in place** and add a one-line revisions footer. Don't append a dated paragraph.

See `meta/how-to-amend-knowledge.md` for amendment rules.

## Architecture

| Read this... | When you're about to... |
|---|---|
| `architecture/adapter-contract.md` | Add a new AI adapter or change the `AIAdapter` interface |
| `architecture/connector-contract.md` | Add a connector (Slack, webhook, email, Discord, etc.) |
| `architecture/memory-protocol.md` | Touch memory loading, the FS write boundary, or the PreToolUse hook |
| `architecture/two-tree-deploy.md` | Change `verona build`, `verona deploy`, or the source/state tree split |
| `architecture/user-content-sync.md` | Touch the laptop→server sync flow, `verona user *` commands, the polling job, refresh-on-reload, or the deploy-key pattern |
| `architecture/claude-p-invocation.md` | Change how the claude-cli adapter shells out, edit hook settings, or debug a `claude -p` flag |
| `architecture/skills.md` | Touch the skills mechanism — declaration in agent.toml, the per-spawn symlink staging, or the cwd-based discovery in claude-cli |

## Conventions

| Read this... | When you're about to... |
|---|---|
| `conventions/error-handling.md` | Throw an error or design an error class |
| `conventions/secrets-handling.md` | Touch anything in `state/secrets/` or write code that reads tokens |

## Meta

| Read this... | When you're about to... |
|---|---|
| `meta/how-to-amend-knowledge.md` | Edit a knowledge entry, add a new one, or remove one |

## Maintenance rules

- Keep each entry ≤200 lines. If it's growing, split into a sub-entry.
- Per-topic amends — don't pile new sections onto an existing entry.
- The "Don't re-do" section in each entry exists so future-you doesn't re-run failed experiments. Add to it when you reject an alternative.
- Git history is the audit trail. Don't keep a chronological decision log inside the entries themselves.
