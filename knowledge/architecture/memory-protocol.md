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
2. **Hook layer (load-bearing)** — `memory-guard.sh` rejects out-of-zone writes regardless of what the agent thinks. This is the part you must not break. Workers run under `--permission-mode bypassPermissions` (the headless prompt can't be answered — see `claude-p-invocation.md`), so this hook is the *sole* gate on writes, not a second line behind Claude Code's permission prompt. There is no implicit prompt-layer fallback; if this hook is mis-wired the zone is wide open.
3. **Git layer** — every memory write is auto-committed to the state dir's git repo. Even a write that somehow bypassed the hook is recoverable via `git revert`.

## Loading rules (the token-bloat fix)

The system prompt for a task contains:
1. `SOUL.md` (verbatim).
2. Framing block: "your memory is at `<path>`; read INDEX.md first; only read other files when INDEX directs you."
3. `memory/INDEX.md` (verbatim, capped ≤200 lines).
4. `memory/learned/facts/preferences.md` (optional, capped ≤60 lines) — current user-stated behaviour rules, wrapped as a "HARD OUTPUT CONSTRAINTS" block and placed **last** so it is the highest-adherence section. Loaded on **every** spawn, including `--resume`. The system prompt is re-appended each spawn anyway, the file is ≤60 lines so the cache/whiplash cost is negligible, and the earlier "replayed conversation history carries it" assumption failed under claude-cli context compaction (the original Slack-feedback propagation bug: agents kept reverting to em-dashes / AI cadence mid-thread).
5. Task prompt (`tasks/<id>.md`).

`memory/core/**` and the rest of `memory/learned/**` are NOT loaded eagerly. The agent uses its own `Read` tool when INDEX.md tells it to. This is the structural fix for input-token bloat. `preferences.md` is the single deliberate exception — it carries always-on user rules that the agent (and humans reviewing) need on every spawn, fresh or resumed.

## File size caps

- `INDEX.md` — soft cap ≤200 lines, surfaced in framing (no enforcement layer yet).
- `learned/facts/*.md` — soft cap ≤100 lines, surfaced in framing.
- `learned/facts/preferences.md` — **hard cap 60 lines, enforced synchronously by `memory-guard.sh`**. Writes that would push the file past 60 lines are denied at PreToolUse time; the agent gets a "rewrite to consolidate, don't append" reason and must Write a fresh shorter version.
- `core/*.md` — human-curated, no enforcement.

## Failure mode if you break it

- Widen the writable zone → an agent's hallucinated `Edit` call rewrites SOUL.md and the personality silently drifts. Recoverable from git, but you may not notice for days.
- Skip the hook → same outcome, no recovery if the user is using a clean checkout.
- Eagerly load `core/**` into the prompt → token usage explodes; cost tracking spikes; subscription-covered runs hit rate limits.

## Don't re-do

- **Don't replace the FS hook with a chrooted subprocess.** Considered. PreToolUse hook is simpler, well-supported by Claude Code, and the hook script is auditable.
- **Don't use a separate "memory daemon" process.** Considered for cross-agent shared memory. v1 is per-agent, isolated. Cross-agent memory is a v2 design problem with different tradeoffs.
- **Don't make `core/**` agent-writable with a "review queue" instead.** User explicitly chose auto-write + structural protection over a queue. Don't reintroduce.
- **Don't generalise the eager-load to all of `learned/**`.** `preferences.md` is a deliberate single-path carve-out, not a doctrinal shift. Lazy-by-default for `learned/` exists for cost reasons and to keep INDEX as the routing surface.
- **Don't introduce a new top-level file (`directives.md`, `behaviour.md`, etc.) for the same purpose.** Considered. A reserved path inside the existing writable zone has the same effect with a smaller protocol surface — no hook allowlist widening, no new scaffold step.

## Evidence

- Plan: `~/.claude/plans/we-are-in-new-expressive-kay.md` (Memory protocol section)
- Hook script: `src/hooks/memory-guard.sh`
- Settings renderer: `src/hooks/render-hook-settings.ts`
- Claude Code hooks docs: confirmed `permissionDecision: "deny"` works in `claude -p` mode.

## Revisions

- 2026-05-02 — initial entry, three-layer enforcement spec.
- 2026-05-13 — `preferences.md` eagerly loaded on fresh sessions; frozen on `--resume`; 60-line cap enforced by the hook. Closes the Slack-feedback propagation gap.
- 2026-05-17 — `preferences.md` now loaded on **every** spawn (resume included), moved **last**, and wrapped as a HARD OUTPUT CONSTRAINTS block. The `--resume` freeze regressed multi-turn Slack threads (preferences fell out of context under compaction; agent reverted to em-dashes/AI cadence). `isResume` removed from `loadMemory`.
- 2026-05-19 — clarified that `--permission-mode bypassPermissions` makes the hook the *sole* write gate; the headless default mode was previously the de-facto (broken) gate, auto-denying all memory writes. No change to the writable zone.
