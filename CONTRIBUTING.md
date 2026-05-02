# Contributing to Verona

Thanks for the interest. Verona is early — APIs are still moving — so the most useful contributions right now are bug reports, design feedback, and reference agents.

## Before you write code

1. Read `AGENTS.md` and the entry in `knowledge/architecture/` matching your change area.
2. Check `~/.claude/plans/we-are-in-new-expressive-kay.md` for the v0.1.0 plan and milestone status.
3. For non-trivial changes, open an issue first to align on direction.

## Setup

```bash
npm install
npm run typecheck
npm run check       # biome lint
npm test
```

## What's in scope vs out of scope

In scope (welcome):
- New connectors (email, Discord, Telegram, Notion, Calendar, GitHub, etc.)
- New AI adapters (Ollama, Bedrock, Vertex, etc.)
- Reference agents under `agents/examples/`
- Bug fixes and docs

Out of scope for v0.1.0:
- Web UI / dashboard
- Multi-host coordination / cluster mode
- Memory review queue (auto-write with FS guard is the chosen model)
- Windows support

## Code style

- TypeScript strict mode is on; don't loosen `tsconfig.json`.
- Biome handles lint + format. Run `npm run format` before committing.
- Errors at system boundaries throw a `VeronaError` subclass.
- Tests mirror `src/` paths and use Vitest. Prefer real temp dirs over filesystem mocks.

## Commits and PRs

- Short imperative subject lines (`add slack thread reply support`, not `Slack stuff`).
- One concept per PR.
- No secrets. The `scripts/check-secrets.sh` pre-commit hook will catch most leaks; run `git diff --staged` before pushing.
- No co-authored commit trailers.

## Adding a connector

1. Implement `src/connectors/<name>/index.ts` against the `Connector` interface in `src/connectors/connector.ts`.
2. Add a Zod config schema for it in `src/config/schema.ts`.
3. Add an entry to `knowledge/architecture/connector-contract.md` documenting auth model, rate limits, and failure semantics.
4. Add tests under `tests/connectors/<name>/`.
5. Open a PR — add a one-line bullet to `README.md`'s connector list.

## Adding an AI adapter

1. Implement `src/adapters/<name>.ts` against the `AIAdapter` interface in `src/adapters/adapter.ts`.
2. Update `src/adapters/effort-mapping.ts` with the provider's effort → model mapping.
3. Document auth (`ANTHROPIC_API_KEY`-style env var or subscription) in `knowledge/architecture/adapter-contract.md`.
4. Add tests with `MockAdapterRequest` / `MockAdapterResponse` fixtures.
