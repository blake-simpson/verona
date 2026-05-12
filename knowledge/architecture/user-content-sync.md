# User content sync

## Why this matters

The npm-installed CLI is the same on every host, but the agents and connectors a user writes are personal. Editing `~/.verona/state/agents/<name>/agent.toml` directly works for one machine, but it makes "edit on laptop, run on server" a pain — there's no shared source-of-truth, no backup, no version history, and a forgotten `verona agents add` after an edit is a silent failure that wastes a debugging session.

The user-content tree fixes this: one git repo at `~/.verona/user/`, with `agents/`, `connectors/`, and `skills/` subdirs. The user authors here. The daemon refreshes the state tree from here on `verona reload`. A scheduled job inside the daemon polls a private remote for changes and reloads automatically.

## Invariant

There is exactly one user-content tree per host:

`~/.verona/user/` (default; override via `VERONA_USER_DIR`):
- `.git/` — the user's authored content, normally with a private remote.
- `agents/<name>/` — one dir per agent (SOUL.md, agent.toml, tasks/, memory/core/, memory/INDEX.md). Override the leaf via `VERONA_AGENTS_DIR`.
- `connectors/<id>/` — one dir per user connector (connector.toml, src/, dist/). Override via `VERONA_CONNECTORS_DIR`.
- `skills/<name>/` — one dir per skill (SKILL.md + optional references/, evals/). Override via `VERONA_SKILLS_DIR`. Loaded at spawn time, not at daemon startup — no reload needed when a skill file changes (only when an agent's declared skill list changes).
- Never holds secrets. Tokens live per-machine in `state/secrets/_connectors/<id>/`.

The state tree (`~/.verona/state/`) is still the daemon's runtime authority — that's where memory writes land. The user-content tree is a *source* the daemon copies *from* into the state tree. The two trees are git-tracked independently: state for the audit trail, user-content for the user's authoring history.

## Sync flow

Two halves, both shipped at v0.3.0:

**1. Refresh-on-reload (always on, no remote required).** When the daemon receives SIGHUP — via `verona reload`, programmatic `daemon.reload()`, or the polling sync below — `Daemon.reloadUserConnectors()` and the reload path's `refreshRegisteredAgents(stateDir, sourceRoot)` together re-copy protected files from `<sourceRoot>/<name>/` into `<state>/agents/<name>/` for every registered agent. Protected = `agent.toml`, `SOUL.md`, `tasks/`, `memory/core/`. **Memory under `learned/` is preserved** by `registerAgent`'s existing logic. Then connectors are diffed by manifest version and started/restarted/stopped. See `agent-registry.ts` and `daemon.ts`.

**2. Polling sync (opt-in, requires remote).** `[user_sync]` block in `state/verona.toml`:

```toml
[user_sync]
enabled = true
interval = "*/5 * * * *"   # croner expression
reload_on_change = true
```

The daemon's `UserSync` (in `src/core/user-sync.ts`) runs `git pull --ff-only` on the configured cron. If HEAD moves, it calls `daemon.reload()` directly (not via SIGHUP / pidfile — same process). Errors are logged to stderr but never crash the daemon.

## Deploy key pattern (server-side)

Every server pulling from a private user repo needs a credential. The recommended pattern:

- **One ed25519 key per server**, generated locally with no passphrase (the daemon polls unattended; passphrase prompts would block).
- **Added as a read-only deploy key on the GitHub repo** (Settings → Deploy keys → Add → uncheck "Allow write access"). Read-only is sufficient — the server never pushes.
- **Pinned in `~/.ssh/config`** so SSH uses the right key for `github.com`.
- **Generate, configure, add — then test with `ssh -T git@github.com`** before cloning.

A leaked key on a compromised server only grants pull access to one private repo, not to the user's whole GitHub account, and can be revoked individually from the repo's deploy keys page.

## Failure modes if you break it

- **State tree drifts from user tree** if the daemon's reload doesn't refresh — the silent edit-and-forget bug `refreshRegisteredAgents` was added to fix.
- **Memory loss** if refresh treats `memory/learned/` as a protected file (it must NOT). `registerAgent`'s `PROTECTED_TOPLEVEL` and `PROTECTED_DIRS` lists draw the boundary; don't widen them.
- **Polling hammers the remote** if `interval` is too short. Default `*/5 * * * *` is reasonable. Sub-minute polling wastes egress without benefit; use a webhook (deferred — see "Don't re-do").
- **Daemon and CLI race on the user repo** if a `verona user pull` runs concurrently with a polling tick. Both read the same git ref so worst case is a wasted reload — `git pull --ff-only` is the only mutation either does.
- **Secrets in the user repo** would propagate them across machines and likely a public-ish private repo. Tokens MUST stay in `state/secrets/`, captured per-machine via `verona connectors add <id>`.

## Don't re-do

- **Don't make the daemon read directly from the user-content tree** (skipping the state-tree copy). Considered for "no two-tree drift". Rejected because the daemon writes runtime memory to `<state>/agents/<name>/memory/learned/`, which would then live alongside the user-authored source — making the user repo dirty after every task fire and introducing version-control noise.
- **Don't add a webhook receiver in v1.** Considered for sub-minute sync latency. Rejected because polling is enough for the laptop-push workflow, polling needs no inbound network surface (works behind NAT), and HMAC + cert + rate-limiting for an inbound HTTP endpoint is more attack surface than the latency saves. Revisit when someone needs sub-poll latency.
- **Don't store the user's private repo URL in the source tree.** It varies per user. The remote is configured via `verona user init --remote <url>` and lives in `~/.verona/user/.git/config`.
- **Don't auto-clean the legacy `~/.verona/agents/` location** when 0.2.x users upgrade. The doctor warning + a manual `mv` is safer than auto-mutation.

## Evidence

- Plan: `~/.claude/plans/if-i-am-running-merry-horizon.md`
- CLI: `src/cli/commands/user.ts` (`init`/`push`/`pull`/`status`)
- Sync job: `src/core/user-sync.ts`
- Refresh helper: `src/state/agent-registry.ts` (`refreshRegisteredAgents`)
- Daemon integration: `Daemon.reload()` and `Daemon.reloadUserConnectors()` in `src/core/daemon.ts`
- Config schema: `[user_sync]` block in `src/config/schema.ts`

## Revisions

- 2026-05-05 — initial entry. User-content tree, refresh-on-reload, opt-in polling sync, deploy-key pattern.
- 2026-05-12 — user-content tree gains a `skills/` subdir; loaded per-spawn rather than at daemon startup. See `architecture/skills.md`.
