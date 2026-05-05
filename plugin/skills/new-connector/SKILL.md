---
name: new-connector
description: Scaffold a new Verona connector under ~/.verona/user/connectors/<id>/ — its own directory, manifest, source, build output. Loaded by the daemon at startup and on `verona reload`. Use when the user wants to add support for a new external system (Discord, Telegram, email, GitHub webhooks, QuickBooks, etc.).
---

# /verona:new-connector

Add a new user-authored Connector. These live in **the user content repo** (`~/.verona/user/connectors/<id>/`), not in Verona's source tree. The daemon discovers them at boot and on `verona reload`. No source-tree edits needed.

## Inputs

1. **id** — kebab-case identifier (e.g. `discord`, `telegram`, `quickbooks`).
2. **direction** — `inbound`, `outbound`, or `both`.
3. **transport** — high-level: WebSocket / HTTP / polling / SDK call.
4. **secrets** — list of secret keys the connector needs (e.g. `["client_id", "refresh_token"]`). Captured per-machine by `verona connectors add <id>` into `<state>/secrets/_connectors/<id>/<key>`. Never read from `process.env`.

## Steps

1. **Read first**: `knowledge/architecture/connector-contract.md` and `src/connectors/connector.ts`. The new connector MUST satisfy that contract.
2. Create the directory at `~/.verona/user/connectors/<id>/` with this layout:
   ```
   <id>/
     connector.toml          # manifest
     src/index.ts            # author writes TS here
     dist/index.js           # build output (committed; daemon imports this)
     package.json            # connector-local deps
     .gitignore              # excludes node_modules/
   ```
3. Write `connector.toml`:
   ```toml
   id = "<id>"
   direction = "outbound"          # or "inbound" / "both"
   version = "0.1.0"
   entry = "dist/index.js"         # default; relative to this dir
   description = "<one-line>"
   secrets = ["client_id", "refresh_token"]   # keys verona will prompt for
   ```
   The `id` MUST match the directory name. The `version` is the diff key for hot-reload — bump it when the code changes so a running daemon picks up the new code on `verona reload`.
4. Implement `src/index.ts` as a default-exported `UserConnectorFactory`:
   ```ts
   import type {
     Connector,
     ConnectorContext,
     OutboundMessage,
     UserConnectorInit,
   } from "verona-ai/connector";  // type-only import; type-checked, erased at build

   export default function createConnector(init: UserConnectorInit): Connector {
     // init.secrets:           Record<key, value> resolved from state/secrets/
     // init.agentSubscriptions: Map<agentName, agent.toml's [connectors.<id>] block>
     return {
       id: "<id>",
       direction: "outbound",
       async start(ctx: ConnectorContext) { /* required for inbound */ },
       async stop() { /* clean up */ },
       async send(msg: OutboundMessage) { /* required for outbound */ },
     };
   }
   ```
   - For inbound: subscribe via the transport; on each event call `ctx.deliver(event)` with an `InboundEvent` (assign a fresh ULID `runId` from `ulidx`).
   - For outbound: emit ONE `connector_send` audit record via `ctx.audit()` per call, on both success and failure. Throw `ConnectorSendError` from `verona-ai/errors` for transport failures.
   - Never read `process.env` for tokens — use `init.secrets`.
5. Build it:
   ```bash
   verona connectors build <id>
   ```
   This runs esbuild → `dist/index.js`, marking `node_modules` deps as external.
6. Capture tokens (per-machine):
   ```bash
   verona connectors add <id>
   ```
   This reads the manifest's `secrets` array and prompts for each. Tokens are written to `<state>/secrets/_connectors/<id>/<key>` with chmod 600 and never echoed.
7. Push the connector source + dist to your user repo:
   ```bash
   verona user push
   ```
   The server pulls within the polling interval and reloads.
8. (Optional) Add a smoke-test script inside the connector dir. `verona connectors test <id>` only knows about built-ins; user connectors should ship their own test scripts.

## Reference implementations

Look at the built-ins for shape — they implement the same `Connector` interface:
- Bidirectional, WebSocket-based: `src/connectors/slack/index.ts`
- Outbound-only HTTP: `src/connectors/webhook/index.ts`
- Outbound-only fetch utility: `src/connectors/web-fetch/index.ts`

## Things to NOT do

- Don't read tokens from `process.env`. Use `init.secrets`.
- Don't generate `runId` inside `send()` — use `msg.runId`.
- Don't try to scaffold into `src/connectors/` (Verona's source tree). User connectors live in `~/.verona/user/connectors/`.
- Don't share the same `version` between code changes. Bump it so the SIGHUP-triggered reload picks up the new code (the loader appends `?v=<version>` to the dynamic import URL to bust Node's module cache).
- Don't commit `node_modules/` or token files. Default `.gitignore` covers `node_modules/`; secrets live outside the user repo entirely.
