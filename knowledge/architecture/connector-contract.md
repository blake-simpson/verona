# Connector contract

## Why this matters

Connectors are how agents touch the outside world. Slack DMs, webhook calls, scraping a URL, hitting QuickBooks — same interface, different transports. Getting the contract right means a Slack bug doesn't bleed into the webhook code path, and a new connector is a contained add.

Two flavours implement the same interface:

- **Built-in connectors** (`src/connectors/{slack,webhook,web-fetch}/`) ship in the npm artifact and are statically registered in `Daemon.startBuiltInConnectors()`.
- **User connectors** live in the user content repo (`~/.verona/user/connectors/<id>/`), authored by the user, never in this source tree. Discovered + dynamic-imported by `src/core/connector-loader.ts` at daemon boot and on every `verona reload`.

## Two halves: daemon-side and spawn-side

A connector has two roles, running in two different processes.

| Half | Process | Owns |
|---|---|---|
| **Daemon-side** | the long-lived `verona daemon` | Socket Mode WebSocket, webhook listener, OAuth refresh, inbound delivery via `ctx.deliver(...)`, system-side `send()` (legacy auto-post + daemon notifications). |
| **Spawn-side** | a per-task `verona-mcp-server.js` child of `claude -p` | Capability invocation. Reuses the same `state/secrets/_connectors/<id>/` tokens, but constructs only the outbound half (e.g. `SlackOutboundClient`, no Socket Mode). Exits when claude exits. |

The agent's outbound is via the spawn-side capability tools (`mcp__verona__<connector>__<cap>`), NOT via the daemon-side `Connector.send()`. `send()` remains as the system-side outbound for daemon notifications and the legacy fallback when an inbound-message agent doesn't call any tool.

## Invariant

Every connector implements `Connector` from `src/connectors/connector.ts` and obeys this contract:

1. **Direction is declared, not negotiated.** `direction: "inbound" | "outbound" | "both"`. The dispatcher uses it to wire start/stop/send routing.
2. **Inbound delivery flows one way: connector → `ctx.deliver(InboundEvent)`.** The connector never invokes adapters or writes memory.
3. **`send()` is async and returns when the message is *accepted*, not when it's *delivered*.** For Slack that's "API ack received." Errors throw `ConnectorSendError` so the dispatcher can audit-log a failed send.
4. **All connector calls (send + receive + capability invocations) emit one audit-log record.** Daemon-side `Connector.send()` writes `connector_send` records; the spawn-side MCP server writes `connector_call` records per capability invocation. Joins on `runId`.
5. **Tokens come from `state/secrets/_connectors/<id>/`, never from `process.env`.** Built-ins read via `getSecret(...)`. User connectors receive resolved values in `UserConnectorInit.secrets`. The daemon also resolves spawn-side secrets and passes them through `VERONA_SUBSCRIPTIONS_JSON` to the MCP server.

## Capabilities

A connector can publish a tool catalog via `Connector.capabilities()` returning `ConnectorCapability[]`. Each capability has:

- `name` (kebab-case, unique within the connector — final tool name is `mcp__verona__<connectorId>__<name>`)
- `description` for the agent
- `inputSchema` (JSON Schema, validated at the MCP layer)
- `sideEffect: "read" | "write" | "destructive"` — gating layer (see hook contract below)
- `invoke(input, ctx)` returning `CapabilityResult`

`CapabilityCallContext` exposes `runId`, `agentName`, `attachmentsDir` (per-run scratch), and `anchorThread(threadKey)` — calling this last one writes a record to `<runDir>/anchors.ndjson` so the dispatcher can persist `(agent, threadKey) → response.sessionId` to SessionStore after the spawn exits.

The per-spawn MCP server (`src/mcp/verona-mcp-server.ts`):
1. Reads env (`VERONA_AGENT`, `VERONA_RUN_ID`, `VERONA_RUN_DIR`, `VERONA_SUBSCRIPTIONS_JSON`, `VERONA_AUDIT_LOG_PATH`).
2. Builds capabilities for each subscription via `getBuiltInSpawnFactory` (built-ins) or, in future iterations, a user-connector dynamic-import.
3. Registers each as an MCP tool, validates input via JSON Schema, dispatches `invoke`.
4. Per call: writes a `connector_call` audit record + appends to `<runDir>/calls.ndjson` (used by the daemon to suppress legacy auto-post when the agent already spoke).

## Two-layer hook gating

Two PreToolUse hooks fire on every claude tool call:

- **`memory-guard.sh`** (matcher `Write|Edit`) — denies file writes outside `memory/INDEX.md` or `memory/learned/**`.
- **`connector-guard.sh`** (matcher `mcp__verona__.*`) — gates connector tool calls in two layers:
  - **Layer A** — destination allowlist. For Slack, `tool_input.channel` must be in the agent's `[connectors.slack].channel(s)` allowlist when one is declared.
  - **Layer B** — sideEffect class. Capabilities marked `destructive` are denied unless `[connectors.<id>].allow_destructive = true`. The MCP server enforces the same rule at invoke time as defence-in-depth.

The dispatcher writes `<runDir>/connector-policy.json` per task, embedding allowed channels + per-capability `sideEffect` metadata (built by calling the same spawn-factory registry the MCP server uses). The hook reads this via `$VERONA_CONNECTOR_POLICY`.

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

### What the agent actually sees on every inbound

`Daemon.handleInbound` always prepends a `<verona-context>` block to the user
message before dispatching, so every reply turn has the values it needs:

```
<verona-context>
connector: slack
channel: C0123ABC
thread_ts: 1700000000.123456
</verona-context>

<user text>
```

Authors writing an `[[tasks]] on_message = true` body should reference these
values directly. Pass `thread_ts` from the block on every Slack tool call —
without it, the reply lands as a top-level channel post.

When the agent has connector subscriptions **but no on_message task**, the
daemon also prepends `buildDefaultReplyPrompt(subscriptions)`: a generated
directive that lists every `mcp__verona__*` tool the agent has, the hard
rule "reply via a tool, not plain text," and the Slack-specific
`thread_ts` instruction. Brand-new agents get this for free; they don't
have to write the boilerplate themselves.

The override path (declare an `on_message` task) is for agents that need a
stricter or differently-shaped reply protocol than the framework default.
The default is the right answer for almost every agent.

### Routing for thread replies without an @-mention

Slack's `message` events (subscribed alongside `app_mention`) deliver thread replies that don't carry the bot's @-mention. The connector emits an `InboundEvent { kind: "thread_reply", agentTarget: null, threadKey: thread_ts }`. The daemon resolves the agent via `SessionStore.findByThreadKey(thread_ts)` — whichever agent anchored that thread (by calling `slack__send_message` earlier) is the recipient. Inbound DMs are deferred to a follow-up phase.

### Outbound thread anchoring

When an agent calls `slack__send_message` from inside a cron task, the capability returns the message `ts` and calls `ctx.anchorThread(ts)`. The MCP server writes a record to `<runDir>/anchors.ndjson`. After `claude` exits, the dispatcher drains the file and writes `(agentName, threadKey) → response.sessionId` to SessionStore. A later thread reply finds the session via the same `getSession(agent, threadKey)` lookup that the existing inbound path uses.

### Inbound attachments

When a `message` event carries `files[]`, the connector downloads each file (using the bot token) into `<state>/runs/<runId>/inbound/<filename>` and populates `InboundEvent.attachments`. The dispatcher prepends an attachment manifest section to the user prompt and adds `<runDir>` as an `--add-dir` so the agent can `Read` the files inline.

### Legacy auto-post suppression

When the agent spoke for itself (any `connector_call` written to `<runDir>/calls.ndjson` against the originating connector), `Daemon.handleInbound` skips the daemon-side `connector.send(result.response.text)` fallback. Agents that take no tool action keep behaving the v0.3 way; agents that call `slack__send_message` are fully in charge.

## How it's enforced

- TypeScript interface in `src/connectors/connector.ts`.
- The dispatcher refuses to register a connector whose declared direction doesn't match the methods it implements (e.g. `direction: "inbound"` requires `start()`).
- Contract tests in `tests/connectors/` exercise: send-error path, inbound-delivery path, audit-log emission.

## Failure mode if you break it

- A connector that bypasses `audit-log.ts` invisibly disappears from `verona invocations`.
- A connector that throws synchronously instead of rejecting breaks the dispatcher's error-handling.
- A connector that reads `process.env.SLACK_BOT_TOKEN` directly bypasses the secrets store and per-agent scoping — and forces users to put secrets in `.env`, which is more leak-prone than `state/secrets/`.
- A capability that pulls in long-lived I/O at module-load time (Socket Mode, webhook listener) runs once per spawn and slows every task. Keep spawn-side modules thin (e.g. `slack/spawn.ts` imports only `slack/outbound-client.ts`).
- A capability that mutates state without `sideEffect: "destructive"` slips past Layer-B gating. Mark anything that deletes, overwrites without diff, or sends mass messaging as destructive.

## Don't re-do

- **Don't discover connectors from `node_modules` (the `verona-connector-*` package convention).** Tried mentally; rejected. User connectors live in the user content repo, version-pinned with the user's other authored content, no npm registry round-trip required.
- **Don't merge inbound HTTP server connectors into one shared listener.** Each connector that needs HTTP (webhook inbound, future GitHub webhooks) gets its own port. Shared listener was tempting for resource use; it was rejected because the audit-log routing got tangled.
- **Don't pass raw Slack event objects to the dispatcher.** Always normalize to `InboundEvent`. Connector-specific shapes leak abstraction.
- **Don't use the same `manifest.version` across connector code changes.** The loader's cache-bust uses the version string; same version → same cached module → reload is a no-op for the new code.
- **Don't bring back `post_response`.** The agent now decides when to post via the `slack__send_message` tool. Mixing the two would double-post or argue with the agent's own judgment. If the agent didn't say anything, it didn't think anything was worth saying.
- **Don't write to SessionStore from inside the spawn.** The MCP server writes to `<runDir>/anchors.ndjson`; the dispatcher (single writer) drains and persists after the spawn exits.
- **Don't make capabilities `async invoke()` rely on long-lived state across calls.** Each invocation gets a fresh `CapabilityCallContext` and runs in a per-spawn process that exits with claude.

## Evidence

- Initial spec: `~/.claude/plans/we-are-in-new-expressive-kay.md`
- User-connector design: `~/.claude/plans/if-i-am-running-merry-horizon.md`
- Connectors-as-tools design: `~/.claude/plans/honestly-i-don-t-like-scalable-galaxy.md`
- Interface: `src/connectors/connector.ts` (Connector, ConnectorContext, UserConnectorInit, UserConnectorFactory)
- Capability types: `src/connectors/capability.ts`
- Built-in implementations: `src/connectors/{slack,webhook,web-fetch}/`
- Slack outbound (shared by daemon-side and spawn-side): `src/connectors/slack/outbound-client.ts`
- Slack spawn-side capabilities: `src/connectors/slack/spawn.ts`
- Loader: `src/core/connector-loader.ts`
- MCP server (spawn-side): `src/mcp/verona-mcp-server.ts`
- MCP config render + IPC files: `src/mcp/{spawn-config,anchor-store,spawn-factories,locate}.ts`
- Connector-guard hook: `src/hooks/connector-guard.sh` (plus `render-hook-settings.ts` policy renderer)
- Hot-reload diff: `Daemon.reloadUserConnectors` in `src/core/daemon.ts`

## Revisions

- 2026-05-02 — initial entry, three v1 connectors scoped (Slack, webhook, web-fetch).
- 2026-05-05 — user-authored connectors land. Loader at `src/core/connector-loader.ts` discovers `~/.verona/user/connectors/<id>/`, dynamic-imports their compiled entry, version-keyed cache-bust enables hot reload via SIGHUP.
- 2026-05-05 — connectors as tools: capabilities() exposed via per-spawn MCP server (`mcp__verona__<connector>__<cap>`). InboundEvent gains kind/channelId/attachments. SlackConnector subscribes to message events for thread replies + downloads attachments. Outbound thread anchoring writes to anchors.ndjson and is persisted to SessionStore by the dispatcher. Two-layer hook gating (Layer A destination + Layer B sideEffect) via `connector-guard.sh`. `post_response` removed; the agent decides via `slack__send_message`.
