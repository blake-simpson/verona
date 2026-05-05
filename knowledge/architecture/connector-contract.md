# Connector contract

## Why this matters

Connectors are how agents touch the outside world. Slack DMs, webhook calls, scraping a URL, hitting QuickBooks — same interface, different transports. Getting the contract right means a Slack bug doesn't bleed into the webhook code path, and a new connector is a contained add.

Two flavours implement the same interface:

- **Built-in connectors** (`src/connectors/{slack,webhook,web-fetch}/`) ship in the npm artifact and are statically registered in `Daemon.startBuiltInConnectors()`.
- **User connectors** live in the user content repo (`~/.verona/user/connectors/<id>/`), authored by the user, never in this source tree. Discovered + dynamic-imported by `src/core/connector-loader.ts` at daemon boot and on every `verona reload`.

## Invariant

Every connector implements `Connector` from `src/connectors/connector.ts` and obeys this contract:

1. **Direction is declared, not negotiated.** `direction: "inbound" | "outbound" | "both"`. The dispatcher uses it to wire start/stop/send routing.
2. **Inbound delivery flows one way: connector → `ctx.dispatcher.deliver(InboundEvent)`.** The connector never invokes adapters or writes memory.
3. **`send()` is async and returns when the message is *accepted*, not when it's *delivered*.** For Slack that's "API ack received." Errors throw `ConnectorSendError` so the dispatcher can audit-log a failed send.
4. **All connector calls (send + receive) emit one audit-log record.** Connectors call into `audit-log.ts` directly; this is the only "core" service they're allowed to touch.
5. **Tokens come from `state/secrets/_connectors/<id>/`, never from `process.env`.** Built-ins read via `getSecret(...)`. User connectors receive resolved values in `UserConnectorInit.secrets`. This keeps the open-source `.env.example` clean and allows per-connector rotation.

## User-connector loader

A user connector is a directory under `~/.verona/user/connectors/<id>/` with:

- `connector.toml` — manifest validated by `ConnectorManifestSchema`. Fields: `id`, `direction`, `version` (semver), `entry` (default `dist/index.js`), `description`, `secrets` (string[]).
- The compiled module at `entry` — must default-export a `UserConnectorFactory: (init: UserConnectorInit) => Connector | Promise<Connector>`. Named export `connector` is also accepted.

The loader (`src/core/connector-loader.ts`):

1. Reads each `<id>/connector.toml`, validates with Zod, and asserts `manifest.id === <dir-name>`.
2. Dynamic-imports `pathToFileURL(<entry>) + "?v=<manifest.version>"`. The query string busts Node's module cache so SIGHUP-triggered reloads pick up new code after a `verona connectors build`.
3. Calls the factory with `{ secrets, agentSubscriptions }` resolved from `state/secrets/` and `agent.toml`'s `[connectors.<id>]` blocks.

Hot-reload diff (`Daemon.reloadUserConnectors`):

- new id present → start.
- id present, same `manifest.version` → leave running.
- id present, different version → stop old, instantiate new, start.
- id removed from disk → stop.

Built-ins are not subject to the diff — they're bound to startup and require a daemon restart for token / channel-mapping changes.

## Inbound message dispatch (no on_message task required)

When an `InboundEvent` arrives, the daemon dispatches a reply WITHOUT requiring the agent to declare an `on_message` task:

- **Thread reply with prior session** (Slack thread_ts maps to a stored sessionId) → `claude -p --resume <sessionId> "<user message>"`. The original cron task's prompt and the assistant's response are already in the session; nothing else needs prepending. The agent's SOUL drives reply behavior.
- **Top-level @mention or no prior session** → fresh session: SOUL + framing + INDEX as the system prompt, user's message as the first user turn. No task body.

The synthetic dispatch uses `taskId = "reply"`, the agent's `default_effort`, and a default `allowed_tools = ["Read", "Write", "WebFetch"]`. Audit log records read `task: "reply"` for these runs.

**Advanced override** — declaring a `[[tasks]]` block with `on_message = true` substitutes that block's `prompt`, `effort`, `budget_usd`, and `allowed_tools` instead of the defaults. Use this only when you want a strict per-message protocol (e.g. a triage prompt that runs every reply).

## Inbound message dispatch (no on_message task required)

When an `InboundEvent` arrives, the daemon dispatches a reply WITHOUT requiring the agent to declare an `on_message` task:

- **Thread reply with prior session** (Slack thread_ts maps to a stored sessionId) → `claude -p --resume <sessionId> "<user message>"`. The original cron task's prompt and the assistant's response are already in the session; nothing else needs prepending. The agent's SOUL drives reply behavior.
- **Top-level @mention or no prior session** → fresh session: SOUL + framing + INDEX as the system prompt, user's message as the first user turn. No task body.

The synthetic dispatch uses `taskId = "reply"`, the agent's `default_effort`, and a default `allowed_tools = ["Read", "Write", "WebFetch"]`. Audit log records read `task: "reply"` for these runs.

**Advanced override** — declaring a `[[tasks]]` block with `on_message = true` substitutes that block's `prompt`, `effort`, `budget_usd`, and `allowed_tools` instead of the defaults. Use this only when you want a strict per-message protocol (e.g. a triage prompt that runs every reply).

## How it's enforced

- TypeScript interface in `src/connectors/connector.ts`.
- The dispatcher refuses to register a connector whose declared direction doesn't match the methods it implements (e.g. `direction: "inbound"` requires `start()`).
- Contract tests in `tests/connectors/` exercise: send-error path, inbound-delivery path, audit-log emission.

## Failure mode if you break it

- A connector that bypasses `audit-log.ts` invisibly disappears from `verona invocations`.
- A connector that throws synchronously instead of rejecting breaks the dispatcher's error-handling.
- A connector that reads `process.env.SLACK_BOT_TOKEN` directly bypasses the secrets store and per-agent scoping — and forces users to put secrets in `.env`, which is more leak-prone than `state/secrets/`.

## Don't re-do

- **Don't discover connectors from `node_modules` (the `verona-connector-*` package convention).** Tried mentally; rejected. User connectors live in the user content repo, version-pinned with the user's other authored content, no npm registry round-trip required.
- **Don't merge inbound HTTP server connectors into one shared listener.** Each connector that needs HTTP (webhook inbound, future GitHub webhooks) gets its own port. Shared listener was tempting for resource use; it was rejected because the audit-log routing got tangled.
- **Don't pass raw Slack event objects to the dispatcher.** Always normalize to `InboundEvent`. Connector-specific shapes leak abstraction.
- **Don't use the same `manifest.version` across connector code changes.** The loader's cache-bust uses the version string; same version → same cached module → reload is a no-op for the new code.

## Evidence

- Initial spec: `~/.claude/plans/we-are-in-new-expressive-kay.md`
- User-connector design: `~/.claude/plans/if-i-am-running-merry-horizon.md`
- Interface: `src/connectors/connector.ts` (Connector, UserConnectorInit, UserConnectorFactory)
- Built-in implementations: `src/connectors/{slack,webhook,web-fetch}/`
- Loader: `src/core/connector-loader.ts`
- Hot-reload diff: `Daemon.reloadUserConnectors` in `src/core/daemon.ts`

## Revisions

- 2026-05-02 — initial entry, three v1 connectors scoped (Slack, webhook, web-fetch).
- 2026-05-05 — user-authored connectors land. Loader at `src/core/connector-loader.ts` discovers `~/.verona/user/connectors/<id>/`, dynamic-imports their compiled entry, version-keyed cache-bust enables hot reload via SIGHUP.
