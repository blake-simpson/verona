# Two-tree deploy

## Why this matters

If `git pull` or `verona deploy` could overwrite an agent's memory, no one would trust the framework to run unattended. The deploy/state split — source repo here, runtime state somewhere else — is the structural answer. It also means worker agents at runtime don't see the dev-time `knowledge/` and `AGENTS.md` (a separate non-negotiable from the user).

A separate concern lives in the user-content tree (`~/.verona/user/`, the user's private git repo of agents + connectors). That's documented in `architecture/user-content-sync.md`. This entry is about the deploy artifact vs. the state tree — the boundary that protects memory.

## Invariant

There are exactly two trees that the deploy boundary protects:

**Source tree** (this repo):
- `src/`, `agents/examples/`, `plugin/`, `marketplace.json`, `deploy/`, `tests/`, `scripts/`
- `knowledge/`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`
- Edited by humans + Claude Code working on Verona itself.

**State tree** (runtime, default `~/.verona/state/`):
- `agents/<name>/{agent.toml,SOUL.md,tasks/,memory/}` — the *deployed* agent dir, where memory lives.
- `secrets/`, `sessions/`, `logs/`, `invocations.ndjson`, `costs/`, `verona.toml`
- Its own `.git` — memory writes auto-commit here.
- Touched by the daemon at runtime; **never touched by deploys.**

The deployed runtime artifact is a third, ephemeral tree (`/opt/verona/runtime/`) — a slim subset of the source tree, built by `verona build`. This is replaceable; the state tree above is not. The user-content tree (`~/.verona/user/`) is a fourth concern but lives outside the deploy path entirely and is the user's authoring repo, not framework state — see `user-content-sync.md`.

## What `verona build` includes / excludes

**Includes:**
- `dist/` (compiled JS)
- `bin/`
- `package.json` (pruned: no devDependencies)
- `deploy/`
- `src/hooks/memory-guard.sh` (literally the only `src/` file shipped because it's invoked at runtime as a script, not compiled)
- `LICENSE`, slim `README.md`

**Excludes (and `scripts/build.ts` asserts these are absent):**
- `knowledge/`
- `AGENTS.md`, `CLAUDE.md`
- `src/` (post-compile only `dist/` ships)
- `tests/`, `scripts/`
- `agents/examples/` (these are templates the user copies, not code Verona itself runs)
- `.env*`, `state/`, anything matching the `.gitignore` exclude list

## How it's enforced

1. `scripts/build.ts` — explicit allow-list, not deny-list. New files don't get into the runtime artifact unless explicitly added.
2. A test in `tests/build.test.ts` boots a build and asserts the resulting `verona-runtime/` does not contain `knowledge/`, `AGENTS.md`, `tests/`, `src/`, etc.
3. `verona deploy` rsyncs `verona-runtime/` to `<host>:/opt/verona/runtime/` with `--delete` — the deploy tree is replaced, but `--exclude state/` is set redundantly even though state lives outside the deploy path.

## Failure mode if you break it

- Worker agents see `knowledge/` → start "helpfully" trying to update Verona's own dev docs from a runtime context (the user explicitly flagged this).
- Memory written to a path *inside* the deploy tree → next `verona deploy` wipes it.
- `AGENTS.md` shipped to runtime → agents read instructions meant for Claude Code working on the framework, not the agent itself.

## Don't re-do

- **Don't co-locate state under the source tree (e.g. `./state/`).** Tempting for a single-machine setup. Rejected because `verona deploy` rsyncs the source tree, which would clobber state. State lives outside the deploy path, period.
- **Don't symlink `state/agents/<name>/SOUL.md` back to the source `agents/examples/<name>/SOUL.md`.** Considered for "live-edit your soul during dev." Rejected because the source dir gets blown away on `git stash`/`git checkout` operations and runtime would lose its soul.
- **Don't add `knowledge/` to the runtime artifact "just for reference."** It's NOT for runtime agents. The build excludes it deliberately.

## Evidence

- Plan: `~/.claude/plans/we-are-in-new-expressive-kay.md` (Build & deploy section)
- Build script: `scripts/build.ts`
- Test: `tests/build.test.ts`

## Revisions

- 2026-05-02 — initial entry, two-tree contract codified.
- 2026-05-05 — note the user-content tree introduced in v0.3.0; cross-link to `user-content-sync.md`. The deploy/state invariant is unchanged.
