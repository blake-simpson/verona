# Memory protocol

## Why this matters

Self-learning agents are a great idea exactly until one of them rewrites its own soul. The user explicitly wants auto-write memory (no review queue) — which means the only thing standing between a hallucinated `Edit` call and a corrupted SOUL.md is the FS write boundary. This doc spells out the contract so a future change doesn't accidentally widen the writable zone.

## Invariant

In any agent dir at runtime (`<state>/agents/<name>/`):

**Protected (read-only to the agent):**
- `agent.toml`
- `SOUL.md`
- `tasks/**`
- `memory/core/**`

**Agent-writable:**
- `memory/INDEX.md`
- `memory/learned/facts/**`
- `memory/learned/episodic/**`
- `memory/learned/working/**`

This is enforced by a `PreToolUse` hook attached to every `claude -p` invocation. The hook (`src/hooks/memory-guard.sh`) inspects `Write`/`Edit` tool calls and emits:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }
```

…for any path not in the writable list. Confirmed working under `claude -p` (non-interactive `-p`) per the Claude Code hooks docs.

## How it's enforced

Three layers, defense-in-depth:

1. **Prompt layer** — the system prompt explicitly tells the agent the writable zone. Most well-behaved runs need only this.
2. **Hook layer (load-bearing)** — `memory-guard.sh` rejects out-of-zone writes regardless of what the agent thinks. This is the part you must not break.
3. **Git layer** — every memory write is auto-committed to the state dir's git repo. Even a write that somehow bypassed the hook is recoverable via `git revert`.

## Loading rules (the token-bloat fix)

The system prompt for a task contains:
1. `SOUL.md` (verbatim).
2. Framing block: "your memory is at `<path>`; read INDEX.md first; only read other files when INDEX directs you."
3. `memory/INDEX.md` (verbatim, capped ≤200 lines).
4. Task prompt (`tasks/<id>.md`).

`memory/core/**` and `memory/learned/**` are NOT loaded eagerly. The agent uses its own `Read` tool when INDEX.md tells it to. This is the structural fix for input-token bloat.

## File size caps (enforced by `verona lint`)

- `INDEX.md` — warn at 180 lines, error at 250.
- `learned/facts/*.md` — error at 100 lines (split required).
- `core/*.md` — warn at 200 lines (human-curated, but still policed).

## Failure mode if you break it

- Widen the writable zone → an agent's hallucinated `Edit` call rewrites SOUL.md and the personality silently drifts. Recoverable from git, but you may not notice for days.
- Skip the hook → same outcome, no recovery if the user is using a clean checkout.
- Eagerly load `core/**` into the prompt → token usage explodes; cost tracking spikes; subscription-covered runs hit rate limits.

## Don't re-do

- **Don't replace the FS hook with a chrooted subprocess.** Considered. PreToolUse hook is simpler, well-supported by Claude Code, and the hook script is auditable.
- **Don't use a separate "memory daemon" process.** Considered for cross-agent shared memory. v1 is per-agent, isolated. Cross-agent memory is a v2 design problem with different tradeoffs.
- **Don't make `core/**` agent-writable with a "review queue" instead.** User explicitly chose auto-write + structural protection over a queue. Don't reintroduce.

## Evidence

- Plan: `~/.claude/plans/we-are-in-new-expressive-kay.md` (Memory protocol section)
- Hook script: `src/hooks/memory-guard.sh`
- Settings renderer: `src/hooks/render-hook-settings.ts`
- Claude Code hooks docs: confirmed `permissionDecision: "deny"` works in `claude -p` mode.

## Revisions

- 2026-05-02 — initial entry, three-layer enforcement spec.
