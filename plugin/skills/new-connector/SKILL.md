---
name: new-connector
description: Scaffold a new Verona Connector implementation under src/connectors/<id>/ with the contract enforced. Use when the user wants to add support for a new external system (Discord, Telegram, email, GitHub webhooks, etc.).
---

# /verona:new-connector

Add a new Connector to Verona's source tree.

## Inputs

1. **id** — kebab-case identifier (e.g. `discord`, `telegram`, `email`).
2. **direction** — `inbound`, `outbound`, or `both`.
3. **transport** — high-level: WebSocket / HTTP / polling / SDK call.
4. **auth model** — what tokens/credentials does it need? Where will they be stored (default: `state/secrets/_connectors/<id>/`)?

## Steps

1. **Read first**: `knowledge/architecture/connector-contract.md` and `src/connectors/connector.ts`. The new connector MUST satisfy that contract.
2. Create `src/connectors/<id>/index.ts` implementing the `Connector` interface.
   - For inbound: subscribe via the transport; on each event, call `ctx.deliver(event)` with an `InboundEvent` (assign a fresh ULID `runId`).
   - For outbound: implement `send(msg)`; emit one `connector_send` audit record via `ctx.audit()` per call (with the `runId` from `msg.runId`).
   - Audit on both success and failure.
   - Throw `ConnectorSendError` from `src/util/errors.ts` for outbound transport failures.
3. Add a Zod config schema to `src/config/schema.ts` so `agent.toml` references can be validated.
4. Add an entry to `knowledge/architecture/connector-contract.md` ("Don't re-do" any rejected approaches).
5. Wire into `Daemon.bootstrapConnectors()` (in `src/core/daemon.ts`) — load tokens from secrets, build the connector, start it.
6. Add tests under `tests/connectors/<id>/` mirroring the structure of `tests/connectors/slack.test.ts` — use injected `factoryMock`-style dependencies, never real network.
7. Document tokens in `state/secrets/_connectors/<id>/` and add to `verona connectors add` (in `src/cli/commands/connectors.ts`).

## Reference implementations

Mirror their shape — don't invent new patterns:
- Bidirectional, WebSocket-based: `src/connectors/slack/index.ts`
- Outbound-only HTTP: `src/connectors/webhook/index.ts`
- Outbound-only fetch utility: `src/connectors/web-fetch/index.ts`

## Things to NOT do

- Don't bypass `state/secrets/` and read tokens from `process.env`.
- Don't generate per-call `runId` inside `send()` — the daemon supplies it on the OutboundMessage.
- Don't make the new connector a singleton or globally importable. Construct it in the daemon.
