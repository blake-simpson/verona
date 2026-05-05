# claude -p invocation

## Why this matters

The `claude-cli` adapter is the default. Every flag we pass shapes auth, cost, tool access, and memory safety. Getting this wrong silently switches users to API-key billing or breaks the memory write boundary.

## Invariant

The claude-cli adapter spawns:

```
claude -p
  --output-format stream-json
  --settings <path-to-generated-hook-settings.json>
  --add-dir <state>/agents/<name>
  --add-dir <state>/runs/<runId>                 # only when subscriptions are set
  --append-system-prompt <SOUL + framing + INDEX>
  --max-budget-usd <task.budget_usd>             # optional
  --session-id <new-uuid>                        # new conversation
  --resume <session-id>                          # continuation (mutually exclusive with --session-id)
  --mcp-config <state>/runs/<runId>/mcp-config.json   # only when subscriptions are set
  --allowedTools "Read Write Edit WebFetch ... mcp__verona__*"
  "<task prompt body>"
```

`--mcp-config` is set whenever the agent has `[connectors.<id>]` blocks, pointing at a per-task config that names the verona MCP server (`dist/mcp/verona-mcp-server.js`) plus env vars naming the agent + run + subscriptions. Tools the server registers as `slack__send_message` appear to the agent as `mcp__verona__slack__send_message`. The dispatcher extends `allowed_tools` with `mcp__verona__*` automatically when subscriptions are non-empty.

**Flags we DO NOT pass:**

- **NO `--bare`.** This flag forces API-key auth and skips OAuth/keychain reads. The whole reason for choosing claude-cli over the Anthropic SDK is to reuse the user's subscription. Don't pass it.
- **NO `ANTHROPIC_API_KEY` in the subprocess env.** The adapter actively scrubs it before spawn. If a user wants API-key billing, they choose `adapter = "anthropic-api"` in agent.toml — that's the explicit path.

## Auth model

The user runs `claude login` once on every host. The Claude CLI stores OAuth credentials in the OS keychain. `claude -p` reads them at invocation time. Verona never sees, stores, or rotates these credentials.

`verona doctor` checks that `claude` is logged in by running `claude --version` and a no-op probe; if not, it instructs the user to `claude login`.

## Hook settings shape

`render-hook-settings.ts` writes a per-task settings JSON with two PreToolUse matchers:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "/opt/verona/runtime/dist/hooks/memory-guard.sh" }]
      },
      {
        "matcher": "mcp__verona__.*",
        "hooks": [{ "type": "command", "command": "/opt/verona/runtime/dist/hooks/connector-guard.sh" }]
      }
    ]
  }
}
```

`memory-guard.sh` reads `tool_input.file_path` and denies writes outside `memory/INDEX.md` or `memory/learned/**`.

`connector-guard.sh` reads the per-run policy file at `$VERONA_CONNECTOR_POLICY` (set by the adapter on the spawn env) and applies two layers:

- **Layer A — destination allowlist.** For Slack, `tool_input.channel` must be in the agent's `[connectors.slack].channel(s)` list when one is declared.
- **Layer B — sideEffect class.** Capabilities marked `sideEffect: "destructive"` are denied unless `[connectors.<id>].allow_destructive = true`. The dispatcher bakes per-capability sideEffect metadata into the policy file at run start by calling the same spawn-factory registry the MCP server uses.

Both hook scripts always exit 0 — decisions are communicated via stdout JSON with `permissionDecision: "deny"`.

## Output parsing

`--output-format stream-json` emits one JSON object per line. The adapter accumulates:
- assistant text deltas
- tool-call counts
- final usage record (token counts; `total_cost_usd` may be present but for claude-cli is treated as informational only — `subscriptionCovered: true`, `costUsd: null` in `AdapterResponse`)

## Session continuity

- New conversation → adapter generates a fresh ULID, passes as `--session-id`.
- Continuation (e.g. user replied in Slack thread) → dispatcher looks up the prior session ID via `session-store.ts` and adapter passes `--resume <id>`.

## Failure mode if you break it

- Pass `--bare` → user gets billed via API key without realizing.
- Skip `--settings` → memory guard not active, agent can write anywhere.
- Skip `--add-dir` → agent can't read its own memory.
- Pass `ANTHROPIC_API_KEY` → claude-cli falls back to API-key auth even with subscription available; cost reporting becomes ambiguous.
- Skip `--mcp-config` for an agent with subscriptions → agent has no `mcp__verona__*` tools, falls back to legacy daemon-side auto-post.
- Forget to extend `allowed_tools` with `mcp__verona__*` → claude refuses to call connector tools even though they're advertised.

## Don't re-do

- **Don't try to set the model via `--model`.** Effort mapping owns this. Hardcoding here couples the adapter to a single model.
- **Don't try to use `--agents <json>` to inject Verona's agent definition.** That's for Claude Code's *internal* sub-agent feature. Verona's agents are a different concept; we use system prompts.
- **Don't wrap the spawn in `bash -c`.** Direct `spawn(claude, [args...])` only. Wrapping breaks env scrubbing and signal forwarding.

## Evidence

- Plan: `~/.claude/plans/we-are-in-new-expressive-kay.md`
- Connectors-as-tools plan: `~/.claude/plans/honestly-i-don-t-like-scalable-galaxy.md`
- Adapter: `src/adapters/claude-cli.ts`
- Hook renderer: `src/hooks/render-hook-settings.ts`
- Hook scripts: `src/hooks/memory-guard.sh`, `src/hooks/connector-guard.sh`
- MCP server: `src/mcp/verona-mcp-server.ts`
- MCP config renderer: `src/mcp/spawn-config.ts`

## Revisions

- 2026-05-02 — initial entry; subscription-OAuth-only contract codified.
- 2026-05-05 — `--mcp-config` is now passed when the agent has connector subscriptions; second PreToolUse matcher (`mcp__verona__.*`) wires `connector-guard.sh` for destination + sideEffect gating; `--add-dir <runDir>` exposes per-run scratch (inbound attachments, outbound files).
