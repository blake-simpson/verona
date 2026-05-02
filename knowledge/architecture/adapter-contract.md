# Adapter contract

## Why this matters

Verona's whole value proposition over a hand-rolled cron job is that you can swap the AI runner without rewriting agents. Three adapters must work today (`claude-cli`, `anthropic-api`, `openai`/`openrouter`) and a fourth (`ollama`) must be addable in <100 LOC. The interface decisions made here cascade into every agent ever written.

## Invariant

Every AI adapter implements `AIAdapter` from `src/adapters/adapter.ts` and obeys this contract:

1. **`invoke(req)` is idempotent w.r.t. its inputs.** Same request → same shape of response. No hidden side effects.
2. **`AdapterResponse` always reports tokens.** `costUsd` may be `null` for subscription-covered adapters, but `tokens.{input,output}` is always populated.
3. **`subscriptionCovered` is the truth signal.** `true` means the daemon must NOT report a dollar figure. `false` means `costUsd` is a real number.
4. **Adapters never write to disk except via the hook layer.** They don't manage memory, sessions, or audit logs — those are dispatcher / core concerns.
5. **`cancel: AbortSignal` is honored.** Adapters listen and tear down cleanly when the daemon needs to stop.

## How it's enforced

- TypeScript: `AIAdapter` is a strict interface; the `claude-cli` / `anthropic-api` / `openai-compat` files implement it explicitly.
- Tests: every adapter has a contract-test suite (same set of cases) that asserts the response shape and side-effect-freeness.
- The dispatcher only ever calls `adapter.invoke()`; it doesn't reach into adapter internals.

## Failure mode if you break it

If an adapter silently mutates the working dir or returns `costUsd: 0` for a subscription path, the audit log lies and cost reports underreport. Worse, switching adapters in `agent.toml` produces different observable behavior — defeating the point.

## Don't re-do

- **Don't add a streaming callback to the interface.** We considered an `onToken` callback for Slack live-typing. Not in v1: too much surface, not enough payoff. Slack lets you edit a message after the fact.
- **Don't push effort → model resolution into the dispatcher.** Adapters own their own model mapping (each provider has different model names). `effort-mapping.ts` is per-adapter, not central.
- **Don't make `sessionId` adapter-internal.** The dispatcher owns session continuity (different connectors → different threads → different session IDs). The adapter is told the session, not the other way around.

## Evidence

- Initial spec: `~/.claude/plans/we-are-in-new-expressive-kay.md`
- Interface: `src/adapters/adapter.ts`
- Reference impl: `src/adapters/claude-cli.ts`

## Revisions

- 2026-05-02 — initial entry, three v1 adapters scoped.
