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
  --append-system-prompt <SOUL + framing + INDEX>
  --max-budget-usd <task.budget_usd>            # optional
  --session-id <new-or-resumed-uuid>
  --allowedTools "Read Write Edit WebFetch ..."  # from agent.toml
  --resume <session-id>                          # only on continuation, not first call
  "<task prompt body>"
```

**Flags we DO NOT pass:**

- **NO `--bare`.** This flag forces API-key auth and skips OAuth/keychain reads. The whole reason for choosing claude-cli over the Anthropic SDK is to reuse the user's subscription. Don't pass it.
- **NO `ANTHROPIC_API_KEY` in the subprocess env.** The adapter actively scrubs it before spawn. If a user wants API-key billing, they choose `adapter = "anthropic-api"` in agent.toml — that's the explicit path.

## Auth model

The user runs `claude login` once on every host. The Claude CLI stores OAuth credentials in the OS keychain. `claude -p` reads them at invocation time. Verona never sees, stores, or rotates these credentials.

`verona doctor` checks that `claude` is logged in by running `claude --version` and a no-op probe; if not, it instructs the user to `claude login`.

## Hook settings shape

`render-hook-settings.ts` writes a per-task settings JSON like:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "/opt/verona/runtime/src/hooks/memory-guard.sh" }]
      }
    ]
  }
}
```

The shell script reads `tool_input.file_path` from stdin and emits `permissionDecision: "deny"` for any path outside `memory/INDEX.md` or `memory/learned/**`.

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

## Don't re-do

- **Don't try to set the model via `--model`.** Effort mapping owns this. Hardcoding here couples the adapter to a single model.
- **Don't try to use `--agents <json>` to inject Verona's agent definition.** That's for Claude Code's *internal* sub-agent feature. Verona's agents are a different concept; we use system prompts.
- **Don't wrap the spawn in `bash -c`.** Direct `spawn(claude, [args...])` only. Wrapping breaks env scrubbing and signal forwarding.

## Evidence

- Plan: `~/.claude/plans/we-are-in-new-expressive-kay.md`
- Adapter: `src/adapters/claude-cli.ts`
- Hook renderer: `src/hooks/render-hook-settings.ts`
- Hook script: `src/hooks/memory-guard.sh`

## Revisions

- 2026-05-02 — initial entry; subscription-OAuth-only contract codified.
