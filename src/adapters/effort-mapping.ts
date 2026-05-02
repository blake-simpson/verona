/**
 * Per-adapter effort → model mapping. Each adapter owns its own table because
 * provider model names diverge. Users can override via verona.toml's
 * adapters.effort_mapping section.
 *
 * See knowledge/architecture/adapter-contract.md for why this is per-adapter.
 */

import type { AdapterId, Effort } from "./adapter.js";

export interface ClaudeCliEffortResolution {
  model: string;
  /** Optional `--effort` flag value. If undefined, flag is omitted. */
  effortFlag?: "low" | "medium" | "high" | "xhigh" | "max";
}

const CLAUDE_CLI_DEFAULTS: Record<Effort, ClaudeCliEffortResolution> = {
  low: { model: "claude-haiku-4-5-20251001" },
  medium: { model: "claude-sonnet-4-6", effortFlag: "medium" },
  high: { model: "claude-opus-4-7", effortFlag: "high" },
  max: { model: "claude-opus-4-7", effortFlag: "max" },
};

const ANTHROPIC_API_DEFAULTS: Record<Effort, string> = {
  low: "claude-haiku-4-5-20251001",
  medium: "claude-sonnet-4-6",
  high: "claude-opus-4-7",
  max: "claude-opus-4-7",
};

const OPENAI_DEFAULTS: Record<Effort, string> = {
  low: "gpt-4o-mini",
  medium: "gpt-4o",
  high: "o1",
  max: "o1-pro",
};

/**
 * OpenRouter has no canonical default — users typically configure a mapping
 * per their provider preferences. These defaults are sensible starting points
 * but expect override via verona.toml.
 */
const OPENROUTER_DEFAULTS: Record<Effort, string> = {
  low: "anthropic/claude-haiku-4-5",
  medium: "anthropic/claude-sonnet-4-6",
  high: "anthropic/claude-opus-4-7",
  max: "anthropic/claude-opus-4-7",
};

export function resolveClaudeCliEffort(
  effort: Effort,
  overrides?: Partial<Record<Effort, string>>,
): ClaudeCliEffortResolution {
  const baseline = CLAUDE_CLI_DEFAULTS[effort];
  const overrideModel = overrides?.[effort];
  if (overrideModel) {
    return { ...baseline, model: overrideModel };
  }
  return baseline;
}

export function resolveAnthropicApiEffort(
  effort: Effort,
  overrides?: Partial<Record<Effort, string>>,
): string {
  return overrides?.[effort] ?? ANTHROPIC_API_DEFAULTS[effort];
}

export function resolveOpenAiEffort(
  effort: Effort,
  overrides?: Partial<Record<Effort, string>>,
): string {
  return overrides?.[effort] ?? OPENAI_DEFAULTS[effort];
}

export function resolveOpenRouterEffort(
  effort: Effort,
  overrides?: Partial<Record<Effort, string>>,
): string {
  return overrides?.[effort] ?? OPENROUTER_DEFAULTS[effort];
}

export function defaultEffortModelFor(adapter: AdapterId, effort: Effort): string {
  switch (adapter) {
    case "claude-cli":
      return CLAUDE_CLI_DEFAULTS[effort].model;
    case "anthropic-api":
      return ANTHROPIC_API_DEFAULTS[effort];
    case "openai":
      return OPENAI_DEFAULTS[effort];
    case "openrouter":
      return OPENROUTER_DEFAULTS[effort];
  }
}
