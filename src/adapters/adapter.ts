/**
 * AIAdapter — Verona's swap point for the AI runner.
 *
 * v1 implementations:
 *   - claude-cli      : spawns `claude -p` (subscription OAuth, default)
 *   - anthropic-api   : @anthropic-ai/sdk (API key)
 *   - openai-compat   : OpenAI direct + OpenRouter via base URL (API key)
 *
 * See knowledge/architecture/adapter-contract.md for the invariants every
 * adapter must obey.
 */

export type Effort = "low" | "medium" | "high" | "max";

export type AdapterId = "claude-cli" | "anthropic-api" | "openai" | "openrouter";

export interface AdapterRequest {
  agentName: string;
  taskId: string;
  /** SOUL.md + framing block + INDEX.md */
  systemPrompt: string;
  userPrompt: string;
  effort: Effort;
  /**
   * Pass to resume an existing conversation (e.g. user replied in a Slack
   * thread). Adapter passes through to provider's session/resume mechanism.
   */
  sessionId?: string;
  /**
   * Hard cap. Only enforceable for API-key adapters; claude-cli treats this
   * as a soft hint via token-rate estimation.
   */
  budgetUsd?: number;
  /**
   * Tool allowlist passed to the provider (e.g. `claude -p --allowedTools`).
   * Format is provider-native (the adapter is responsible for translation if
   * needed).
   */
  allowedTools?: readonly string[];
  /** Path to the agent's state dir. The adapter passes it via --add-dir. */
  workingDir: string;
  /**
   * Path to the generated PreToolUse hook settings JSON, applied via
   * `claude -p --settings`. Required for claude-cli; ignored otherwise.
   */
  hookSettingsPath?: string;
  cancel: AbortSignal;
}

export interface AdapterTokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface AdapterResponse {
  /** The assistant's final text response. */
  text: string;
  /** Returned for continuation; falsy means new conversation next time. */
  sessionId?: string;
  tokens: AdapterTokenUsage;
  /**
   * Real $ for API-key adapters. NULL when subscriptionCovered=true (the
   * subscription paid; per-call $ is opaque to the daemon). Never silently
   * estimate.
   */
  costUsd: number | null;
  /**
   * true iff this invocation was billed against a subscription rather than
   * a metered API key. claude-cli => true; everything else => false.
   */
  subscriptionCovered: boolean;
  /** The exact provider model the adapter resolved the effort to. */
  modelUsed: string;
  toolCalls: number;
  durationMs: number;
}

export interface AIAdapter {
  readonly id: AdapterId;
  invoke(req: AdapterRequest): Promise<AdapterResponse>;
}
