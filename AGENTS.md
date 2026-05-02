# Verona — Working notes for Claude Code

This file is the entry point for Claude Code (or any AI agent) working *on* the Verona codebase. Read it at the start of every session.

## CRITICAL: Three trees — don't confuse them

Verona has three logical trees. Mixing them is a load-bearing bug.

| Tree | Location | Edited by | Shipped in `verona build` artifact? |
|---|---|---|---|
| **1. Source** (this) | this repo: `src/`, `knowledge/`, `agents/examples/`, `plugin/`, `deploy/`, `tests/` | Verona maintainers + Claude Code working on Verona | only `dist/`, `bin/`, `deploy/`, `agents/examples/`, `LICENSE`, slim `README.md` ship — `knowledge/`, `AGENTS.md`, `src/`, `tests/`, `scripts/`, `plugin/`, `marketplace.json`, `.claude/` are EXCLUDED |
| **2. User agents** | `~/.verona/agents/<name>/` (override via `$VERONA_AGENTS_DIR`) | the user (you) — `verona agents init` scaffolds, then you edit | **n/a — lives outside this repo entirely** |
| **3. Runtime state** | `~/.verona/state/` (override via `$VERONA_STATE_DIR`) — its own git repo | the daemon at runtime + memory-guard hook | **n/a — lives outside this repo entirely** |

`agents/examples/` in this repo is **read-only canonical templates**. Users copy them via `verona agents init <name> --template <template>` into their user-agents dir; never edit the bundled examples for personal use. `/verona:new-agent` writes to the user-agents dir, never to `agents/examples/`.

Worker agents at runtime get `--add-dir <state>/agents/<name>` only. They never see `knowledge/`, `AGENTS.md`, the source repo, or other agents' state.

## Read this first when starting a session

1. `knowledge/KNOWLEDGE.md` — routing index. Open only the entries it points you to.
2. The plan file: `~/.claude/plans/we-are-in-new-expressive-kay.md` (initial architecture spec).
3. This file (`AGENTS.md`).

If the work touches a domain (adapters, connectors, memory, deploy), read the matching entry in `knowledge/architecture/`.

## Live invariants — short and prescriptive

1. **`claude -p` adapter uses subscription OAuth, never API keys.** No `--bare` flag. Scrub `ANTHROPIC_API_KEY` from the subprocess env. See `knowledge/architecture/claude-p-invocation.md`.
2. **Memory write boundary is FS-enforced via PreToolUse hook.** Agents can only write under `memory/INDEX.md` and `memory/learned/**`. `SOUL.md`, `agent.toml`, `tasks/`, `memory/core/` are denied at the hook layer. See `knowledge/architecture/memory-protocol.md`.
3. **Two-tree deploy is the contract.** Source repo (this) holds code + dev docs + examples. State dir lives outside, never touched by deploys. `verona build` MUST NOT include `knowledge/`, `AGENTS.md`, `CLAUDE.md`, `tests/`, `scripts/`, `agents/examples/`. See `knowledge/architecture/two-tree-deploy.md`.
4. **Per-task subprocess model.** The daemon spawns a fresh `claude -p` per task; conversations resume via `--session-id`. No long-lived in-process LLM clients. See `knowledge/architecture/claude-p-invocation.md`.
5. **Audit log is append-only NDJSON joined by `runId`.** Every adapter call and every connector call gets a record. Cost rollups in `state/costs/` are regenerated, never authoritative.
6. **Secrets live in `state/secrets/` with chmod 0700 / 0600.** Per-agent scoping. Daemon refuses to start if perms are wrong. Never committed.
7. **No telemetry.** Open-source, self-hosted, user owns their data.
8. **TOML for config, Zod for validation after parse.** No YAML.
9. **TypeScript strict + ESM.** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on. Don't loosen them.

## How to amend knowledge

`knowledge/` follows Belmont's living-docs pattern. **Amend in place; don't append.** Each entry has a one-line `Revisions:` footer. Adding a dated paragraph to the top is wrong — edit the body to reflect the new truth, then add one line to the footer.

See `knowledge/meta/how-to-amend-knowledge.md`.

## Code conventions

- Errors at boundaries: throw `VeronaError` subclasses (not raw strings, not generic `Error`).
- Don't add comments that re-state what well-named code already says.
- No "future-proofing" abstractions. Three similar lines beats a premature interface.
- No backwards-compat shims. Change the code; don't leave `// deprecated` markers.
- Tests live in `tests/` and mirror `src/` structure. Vitest. Don't mock the filesystem when a temp dir works.

## Commit style

- Short imperative subject, ≤72 chars. Body explains *why*, not *what*.
- Never commit secrets. The `scripts/check-secrets.sh` pre-commit hook greps for known token prefixes.
- Don't co-author commits.
