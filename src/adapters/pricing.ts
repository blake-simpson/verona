/**
 * Per-model pricing tables (USD per million tokens). Used by API-key adapters
 * to compute `costUsd` for AdapterResponse. Values are best-effort defaults;
 * users can override per-model via verona.toml's `adapters.pricing` section.
 *
 * These rates are subject to change. Update opportunistically when you notice
 * a discrepancy in a real run vs reported costUsd. Don't treat the resulting
 * `costUsd` as billing-grade — it's an estimate. Real billing comes from the
 * provider's invoice.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read input tokens. */
  cacheRead?: number;
  /** USD per 1M cache-write input tokens. */
  cacheWrite?: number;
}

const ANTHROPIC: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

const OPENAI: Record<string, ModelPricing> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  o1: { input: 15, output: 60 },
  "o1-pro": { input: 150, output: 600 },
};

const PROVIDER_TABLES: Record<string, Record<string, ModelPricing>> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
};

export function lookupPricing(
  provider: "anthropic" | "openai",
  model: string,
): ModelPricing | null {
  return PROVIDER_TABLES[provider]?.[model] ?? null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function computeCostUsd(tokens: TokenCounts, pricing: ModelPricing): number {
  const cacheReadTokens = tokens.cacheRead ?? 0;
  const cacheWriteTokens = tokens.cacheWrite ?? 0;
  const billableInput = tokens.input - cacheReadTokens - cacheWriteTokens;
  const inputCost = (Math.max(0, billableInput) / 1_000_000) * pricing.input;
  const outputCost = (tokens.output / 1_000_000) * pricing.output;
  const cacheReadCost = pricing.cacheRead ? (cacheReadTokens / 1_000_000) * pricing.cacheRead : 0;
  const cacheWriteCost = pricing.cacheWrite
    ? (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
    : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
