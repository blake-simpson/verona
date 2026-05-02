# Connector contract

## Why this matters

Connectors are how agents touch the outside world. Slack DMs, webhook calls, scraping a URL — same interface, different transports. Getting the contract right means a Slack bug doesn't bleed into the webhook code path, and a new connector is a contained add.

## Invariant

Every connector implements `Connector` from `src/connectors/connector.ts` and obeys this contract:

1. **Direction is declared, not negotiated.** `direction: "inbound" | "outbound" | "both"`. The dispatcher uses it to wire start/stop/send routing.
2. **Inbound delivery flows one way: connector → `ctx.dispatcher.deliver(InboundEvent)`.** The connector never invokes adapters or writes memory.
3. **`send()` is async and returns when the message is *accepted*, not when it's *delivered*.** For Slack that's "API ack received." Errors throw `ConnectorSendError` so the dispatcher can audit-log a failed send.
4. **All connector calls (send + receive) emit one audit-log record.** Connectors call into `audit-log.ts` directly; this is the only "core" service they're allowed to touch.
5. **Tokens come from `state/secrets/_connectors/<id>/`, never from `process.env`.** This keeps the open-source `.env.example` clean and allows per-connector rotation.

## How it's enforced

- TypeScript interface in `src/connectors/connector.ts`.
- The dispatcher refuses to register a connector whose declared direction doesn't match the methods it implements (e.g. `direction: "inbound"` requires `start()`).
- Contract tests in `tests/connectors/` exercise: send-error path, inbound-delivery path, audit-log emission.

## Failure mode if you break it

- A connector that bypasses `audit-log.ts` invisibly disappears from `verona invocations`.
- A connector that throws synchronously instead of rejecting breaks the dispatcher's error-handling.
- A connector that reads `process.env.SLACK_BOT_TOKEN` directly bypasses the secrets store and per-agent scoping — and forces users to put secrets in `.env`, which is more leak-prone than `state/secrets/`.

## Don't re-do

- **Don't make connectors plug-and-play discoverable from `node_modules`.** Tried mentally; v1 explicitly registers connectors in code. Discoverability is a v2+ concern.
- **Don't merge inbound HTTP server connectors into one shared listener.** Each connector that needs HTTP (webhook inbound, future GitHub webhooks) gets its own port. Shared listener was tempting for resource use; it was rejected because the audit-log routing got tangled.
- **Don't pass raw Slack event objects to the dispatcher.** Always normalize to `InboundEvent`. Connector-specific shapes leak abstraction.

## Evidence

- Initial spec: `~/.claude/plans/we-are-in-new-expressive-kay.md`
- Interface: `src/connectors/connector.ts`
- v1 implementations: `src/connectors/{slack,webhook,web-fetch}/`

## Revisions

- 2026-05-02 — initial entry, three v1 connectors scoped (Slack, webhook, web-fetch).
