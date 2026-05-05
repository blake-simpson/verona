# Verona

Self-hosted CLI framework for scheduled, self-learning AI agents with persistent memory and bidirectional comms.

> **Status:** v0.x — actively under construction. APIs and config schemas may change.

## What it is

Verona lets you run long-lived AI agents on a host you control (your laptop, a VPS, an EC2 instance). Each agent has:

- **A soul** (`SOUL.md`) — personality, values, voice, ~200–500 words.
- **Tasks** — prompt templates that fire on a cron schedule, on a Slack mention, or on demand.
- **Memory** — protected human-curated `core/` plus agent-writable `learned/` (facts, episodic logs, working scratch). Self-learning is filesystem-enforced: the agent cannot rewrite its own soul.
- **Connectors** — Slack (bidirectional via Socket Mode), generic webhook, web fetch (read-only), plus user-authored connectors loaded from `~/.verona/user/connectors/` (e.g. QuickBooks, GitHub, anything).
- **A pluggable AI runner** — defaults to `claude -p` using your Claude subscription. Swappable to Anthropic SDK / OpenAI / OpenRouter via API-key adapters.

## Why

You probably don't want to write a bespoke daemon every time you want a "thing that runs at 3am, posts findings to Slack, and lets you @-mention it to dig deeper." Verona is the boring plumbing — scheduler, dispatcher, memory loader, audit log, cost tracker, connectors — so you can focus on the agent's soul, tasks, and prompts.

## Mental model — three dirs

```
   Source repo (this)             User content                 Runtime state
   (Verona maintainers            (you author here)            (daemon writes here)
    only)
   ┌───────────────────┐          ┌─────────────────┐          ┌──────────────────┐
   │  github.com/      │  npm     │  ~/.verona/     │  git     │  ~/.verona/      │
   │  blake/verona     │ ─────→   │      user/      │ ←push→   │      state/      │
   │                   │          │   ├ agents/     │ ─pull─   │   ├ secrets/     │
   │  src/             │          │   └ connectors/ │          │   ├ memory/      │
   │  agents/examples/ │          │                 │          │   ├ sessions/    │
   │  plugin/          │          │   .git ←────────┼ private  │   └ logs/        │
   │  knowledge/       │          │                 │  remote  │ .git (local)     │
   └───────────────────┘          └─────────────────┘          └──────────────────┘
                                          ↓                            ↑
                                          └────── verona daemon ───────┘
                                          reads `user/`, writes `state/`
```

The user dir is one git repo so you can back up + sync your authored content with one push. State is a separate local-only repo (auto-commits memory + audit trail; **never** push it — it contains secrets and conversation data).

## Install

```bash
npm install -g verona-ai
verona init                  # scaffold ~/.verona/state/
verona user init             # scaffold ~/.verona/user/ (git repo for your agents + connectors)
verona doctor                # verify the host (claude binary, perms, git, plugin)
```

**Requirements:**

- **Node.js ≥ 25.9** on `PATH` (see `.tool-versions`; `mise install` will pick it up).
- **The `claude` CLI** installed and logged in (`claude login`) on every host where you'll use the default `claude-cli` adapter. Verona never sees your subscription credentials — it relies on `claude` being authenticated separately.

### Claude Code skills (optional but recommended)

The `/verona:*` skills in Claude Code (`/verona:new-agent`, `/verona:new-task`, `/verona:new-connector`, `/verona:tune-soul`, `/verona:status`) make authoring fast. Install:

```text
/plugin marketplace add blake-simpson/verona
/plugin install verona@verona
```

`verona doctor` warns if the plugin is missing, with the install command.

## Quickstart — local (one machine, no sync)

```bash
verona init
verona user init

# In Claude Code (with the plugin installed):
> /verona:new-agent hello-world
# → scaffolds ~/.verona/user/agents/hello-world/

verona agents add ~/.verona/user/agents/hello-world
verona service install && verona service restart   # systemd / launchd
```

That's the floor. Daemon runs your agent on its schedule.

If you skip Claude Code, the bundled CLI scaffolder still works:

```bash
verona agents init hello-world --template hello-world
verona agents add ~/.verona/user/agents/hello-world
```

## Quickstart — laptop authoring + server runtime

For when you want to edit on your laptop (with your local tools) and run on a server.

**Set up a private git repo** (GitHub, Gitea/Forgejo, or `git init --bare` on any SSH-reachable box). One-time, ~1 minute.

**On your laptop:**

```bash
npm install -g verona-ai
verona user init --remote git@github.com:you/verona-personal.git
# In Claude Code: install the plugin (see above)
```

**Authoring (any time):**

```bash
> /verona:new-agent quickbooks-bot
> /verona:new-connector quickbooks    # scaffolds ~/.verona/user/connectors/quickbooks/
$ cd ~/.verona/user/connectors/quickbooks && npm install <whatever>
$ # implement src/index.ts
$ verona connectors build quickbooks   # esbuild → dist/index.js
$ verona user push                     # commits + pushes
```

**On the server (one-time):**

```bash
npm install -g verona-ai
verona init
git clone git@github.com:you/verona-personal.git ~/.verona/user
verona connectors add quickbooks       # prompts for tokens (per-machine)
verona agents add ~/.verona/user/agents/quickbooks-bot
# Enable polling sync — edit ~/.verona/state/verona.toml:
#   [user_sync]
#   enabled = true
#   interval = "*/5 * * * *"
verona service install && verona service restart
```

After that:

```
You on laptop          GitHub          Server daemon
      │                   │                  │
      │ /verona:new-task  │                  │
      ├──┐                │                  │
      │  │ scaffold       │                  │
      │←─┘                │                  │
      │ verona user push  │                  │
      ├──────────────────→│                  │
      │                   │   poll (5m)      │
      │                   │←─────────────────┤
      │                   ├─ HEAD changed ──→│
      │                   │                  ├──┐ git pull
      │                   │                  │  │ + reload
      │                   │                  │←─┘
      │                   │            next scheduled
      │                   │            run uses new code
```

You never SSH in for content changes. Backup is a `git push`.

### Setup cost summary

| Step | Cost | Required when |
|---|---|---|
| `npm i -g verona-ai` | 30s | always |
| `verona init` | <1s | always |
| Install Claude Code plugin | 30s | optional |
| Set up a private git remote | 1–2min (GitHub) | only for laptop+server |
| `verona user init [--remote]` | <1s | always |
| `verona connectors add <id>` per token | 30s each | once per token-bearing connector per machine |
| `verona service install` | <1s | only for headless run |
| Configure `[user_sync]` | 30s | only for laptop+server |

Heaviest path = ~5 minutes total. Anyone who's set up a GitHub repo can do it.

### What does NOT need a private repo

- Local-only authoring (skip the laptop+server pattern entirely).
- Edit-on-server pattern (use VS Code Remote-SSH / Cursor remote / vim — sync is the editor's job; daemon picks up on `verona reload`).
- Personal experiments where you don't care about backup.

The git-remote requirement only applies when laptop is source-of-truth and server is runtime.

## CLI overview

```
verona init                                  # scaffold ~/.verona/state/
verona doctor                                # verify host readiness (+ plugin presence)
verona daemon                                # run the long-lived daemon

verona user init [--remote URL]              # scaffold ~/.verona/user/ as a git repo
verona user push                             # commit + push to origin
verona user pull                             # git pull --ff-only; reload daemon if HEAD moved
verona user status                           # branch, ahead/behind, dirty counts

verona agents init <name> --template <name>  # scaffold from a bundled template
verona agents {add <path> | list | remove <name>}

verona connectors add <id>                   # capture tokens (built-ins or user manifest)
verona connectors test <id>                  # smoke-test (built-ins only)
verona connectors build <id>                 # esbuild user connector src/ → dist/

verona schedule {list | next | run <agent>:<task>}
verona reload                                # SIGHUP daemon; re-reads agents + diffs user connectors

verona invocations [--agent X] [--since 7d] [--json]
verona costs
verona logs <agent> [--task <id>] [--latest] [--limit N]

verona service {install | uninstall | status | restart | logs}
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
   user conn  ──▶│  (~/.verona/user/connectors/)   │            ▼       │
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

## Hacking on Verona itself

```bash
git clone https://github.com/blake-simpson/verona ~/code/verona
cd ~/code/verona
npm install
npm run build
./bin/verona init
./bin/verona doctor
```

The `plugin/` and `marketplace.json` directories at the repo root let Claude Code auto-discover the `/verona:*` skills when you open a session in this directory — no `/plugin install` step needed for local development.

## Two-tree deploy

Source repo (this) holds code, dev docs, examples. `verona build` produces a slim `verona-runtime/` artifact that ships only the runtime essentials (no `knowledge/`, no `AGENTS.md`, no source). Worker agents at runtime never see Verona's own dev-time docs — they only see their own `<state>/agents/<name>/memory/`.

See `deploy/README.md` for `verona-runtime/` deployment via launchd (macOS) or systemd (Linux).

## What's in this repo

```
src/                                # framework code
  adapters/   {claude-cli,anthropic-api,openai-compat,...}
  connectors/ {slack,webhook,web-fetch}      # built-in connectors
  core/       {daemon,scheduler,dispatcher,memory-loader,audit-log,
               connector-loader,user-sync,...}
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
- The `state/` directory holds memory, secrets, and session IDs — **never** push a state-dir git remote to a public host. Per-machine secrets live in `state/secrets/` and never enter the user repo.

## License

MIT — see `LICENSE`.
