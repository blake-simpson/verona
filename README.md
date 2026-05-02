# Verona

Self-hosted CLI framework for scheduled, self-learning AI agents with persistent memory and bidirectional comms.

> **Status:** v0.x — actively under construction. APIs and config schemas may change.

## What it is

Verona lets you run long-lived AI agents on a host you control (your laptop, a VPS, an EC2 instance). Each agent has:

- **A soul** (`SOUL.md`) — personality, values, voice, ~200–500 words.
- **Tasks** — prompt templates that fire on a cron schedule, on a Slack mention, or on demand.
- **Memory** — protected human-curated `core/` plus agent-writable `learned/` (facts, episodic logs, working scratch). Self-learning is filesystem-enforced: the agent cannot rewrite its own soul.
- **Connectors** — Slack (bidirectional via Socket Mode), generic webhook, web fetch (read-only). More planned.
- **A pluggable AI runner** — defaults to `claude -p` using your Claude subscription. Swappable to Anthropic SDK / OpenAI / OpenRouter via API-key adapters.

## Why

You probably don't want to write a bespoke daemon every time you want a "thing that runs at 3am, posts findings to Slack, and lets you @-mention it to dig deeper." Verona is the boring plumbing — scheduler, dispatcher, memory loader, audit log, cost tracker, connectors — so you can focus on the agent's soul, tasks, and prompts.

## Install

```bash
git clone https://github.com/<you>/verona ~/code/verona
cd ~/code/verona
npm install
npm run build
./bin/verona init        # scaffold ~/.verona/state
./bin/verona doctor      # verify the host (claude binary, perms, git)
```

You'll need:

- **Node.js ≥ 25.9** (see `.tool-versions`; `mise install` will pick it up).
- **The `claude` CLI** installed and logged in (`claude login`) on every host where you'll use the default `claude-cli` adapter. Verona never sees your subscription credentials — it relies on `claude` being authenticated separately.

## Quick start

Register the bundled smoke-test agent and run it once:

```bash
verona agents add ./agents/examples/hello-world
verona schedule run hello-world:greet
verona logs hello-world --latest
```

Wire up Slack for the bundled researcher agent:

```bash
verona connectors add slack       # interactive: paste bot_token (xoxb-) and app_token (xapp-)
verona connectors test slack --destination '#research-feed'
verona agents add ./agents/examples/researcher
verona schedule list              # shows nightly cron + on_message tasks
```

Run the daemon (foreground for now; install as a service via `deploy/README.md` for production):

```bash
verona daemon
```

## CLI overview

```
verona init                                  # scaffold the state dir + git repo
verona doctor                                # verify host readiness
verona daemon                                # run the long-lived daemon

verona agents {add <path> | list}
verona connectors {add <id> | test <id>}
verona schedule {list | next | run <agent>:<task>}

verona invocations [--agent X] [--since 7d] [--json]
verona costs
verona logs <agent> [--task <id>] [--latest] [--limit N]
```

## How it works (one diagram)

```
                 ┌──────────────────────────────────────────────────────┐
                 │              verona daemon (one process)             │
                 │                                                      │
   cron timer ──▶│ Scheduler ──┐                                        │
                 │             ▼                                        │
   Slack WSS  ──▶│  Connector ─▶ Dispatcher ─▶ MemoryLoader ─▶ Adapter  │
   webhook    ──▶│  Inbox                          │            │       │
                 │                                 │            ▼       │
                 │                                 │      claude -p     │
                 │                                 │      subprocess    │
                 │                                 ▼            │       │
                 │                          (loads SOUL +       │       │
                 │                           INDEX.md;          │       │
                 │                           PreToolUse hook    │       │
                 │                           enforces FS write  │       │
                 │                           boundary)          │       │
                 │                                              ▼       │
                 │                                     ConnectorOutbox  │
                 │                                              │       │
                 │                                              ▼       │
                 │                                      AuditLog +      │
                 │                                      GitRecorder     │
                 └──────────────────────────────────────────────────────┘
```

The state dir lives **outside** the deploy tree (default `~/.verona/state`) so `verona deploy` never clobbers an agent's memory. The state dir is its own git repo — every memory mutation auto-commits.

## Two-tree deploy

Source repo (this) holds code, dev docs, examples. `verona build` produces a slim `verona-runtime/` artifact that ships only the runtime essentials (no `knowledge/`, no `AGENTS.md`, no source). Worker agents at runtime never see Verona's own dev-time docs — they only see their own `<state>/agents/<name>/memory/`.

See `deploy/README.md` for `verona-runtime/` deployment via launchd (macOS) or systemd (Linux).

## What's in this repo

```
src/                                # framework code
  adapters/   {claude-cli,anthropic-api,openai-compat,...}
  connectors/ {slack,webhook,web-fetch}
  core/       {daemon,scheduler,dispatcher,memory-loader,audit-log,...}
  cli/        {commands/}
agents/examples/                    # reference agents (templates)
  hello-world/   (smoke test)
  researcher/    (cron + Slack + WebFetch + thread replies)
plugin/                             # /verona:* Claude Code plugin (skills + manifest)
marketplace.json                    # in-tree plugin marketplace descriptor
deploy/                             # launchd + systemd templates
knowledge/                          # dev-time living docs (NOT shipped to runtime)
tests/
```

## Open-source hygiene

- `.gitignore` covers `state/`, `.env*` (except `.env.example`), `dist/`, `node_modules/`, `*.log`.
- All examples use `<replace-me>` placeholders, never real tokens.
- The `state/` directory holds memory, secrets, and session IDs — **never** push a state-dir git remote to a public host.

## License

MIT — see `LICENSE`.
