# Error handling

## Why this matters

Verona is a long-running daemon doing async work across subprocess, network, and filesystem. Sloppy errors → mystery crashes at 3am → trust collapses.

## Invariant

1. **Throw `VeronaError` subclasses at every boundary.** Never `throw "string"`, never raw `new Error("...")`. Subclasses live in `src/util/errors.ts`: `ConfigError`, `SecretError`, `AdapterError`, `ConnectorSendError`, `MemoryGuardError`, `ScheduleError`.
2. **Errors carry `cause`.** Wrap underlying errors: `throw new AdapterError("claude -p exited non-zero", { cause: spawnErr })`.
3. **The daemon never crashes a whole task chain on a single failure.** Errors caught at the dispatcher boundary become an audit-log record (`ok: false`, `errorClass: "AdapterError"`) and the daemon proceeds.
4. **Fatal errors only at startup.** If state-dir perms are wrong, refuse to start. After that, every error is recoverable / loggable.

## How it's enforced

- ESLint/biome `no-throw-literal` is on.
- Error classes have `readonly type` discriminator for narrowing.
- `audit-log.ts` writes `errorClass` from the error's `name` property.

## Failure mode if you break it

- Bare strings or generic `Error` lose stack info via `cause` and produce useless audit-log records.
- An uncaught error at the dispatcher boundary crashes the daemon and aborts pending tasks — a single bad task takes down all schedules.

## Don't re-do

- **Don't add a global unhandled-rejection handler that "logs and continues."** That's an excuse for not handling errors at the right layer. Catch where you have context.
- **Don't use Result/Either monads.** TypeScript's exception model is fine; we don't need `neverthrow` for this scope.

## Evidence

- Errors module: `src/util/errors.ts`
- Dispatcher boundary: `src/core/dispatcher.ts`

## Revisions

- 2026-05-02 — initial entry.
