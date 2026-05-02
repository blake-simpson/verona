import { describe, expect, it } from "vitest";
import {
  defaultEffortModelFor,
  resolveAnthropicApiEffort,
  resolveClaudeCliEffort,
  resolveOpenAiEffort,
  resolveOpenRouterEffort,
} from "../../src/adapters/effort-mapping.js";

describe("effort-mapping", () => {
  describe("claude-cli", () => {
    it("low → haiku, no effort flag", () => {
      const r = resolveClaudeCliEffort("low");
      expect(r.model).toContain("haiku");
      expect(r.effortFlag).toBeUndefined();
    });

    it("medium → sonnet, effort=medium", () => {
      const r = resolveClaudeCliEffort("medium");
      expect(r.model).toBe("claude-sonnet-4-6");
      expect(r.effortFlag).toBe("medium");
    });

    it("high → opus, effort=high", () => {
      const r = resolveClaudeCliEffort("high");
      expect(r.model).toBe("claude-opus-4-7");
      expect(r.effortFlag).toBe("high");
    });

    it("max → opus, effort=max", () => {
      const r = resolveClaudeCliEffort("max");
      expect(r.model).toBe("claude-opus-4-7");
      expect(r.effortFlag).toBe("max");
    });

    it("respects user overrides", () => {
      const r = resolveClaudeCliEffort("medium", { medium: "claude-haiku-4-5-20251001" });
      expect(r.model).toBe("claude-haiku-4-5-20251001");
      // Effort flag still applies even when model is overridden
      expect(r.effortFlag).toBe("medium");
    });
  });

  describe("anthropic-api / openai / openrouter", () => {
    it("anthropic-api maps each effort to a Claude model", () => {
      expect(resolveAnthropicApiEffort("low")).toContain("haiku");
      expect(resolveAnthropicApiEffort("medium")).toBe("claude-sonnet-4-6");
      expect(resolveAnthropicApiEffort("high")).toBe("claude-opus-4-7");
    });

    it("openai maps to GPT/o-series models", () => {
      expect(resolveOpenAiEffort("low")).toBe("gpt-4o-mini");
      expect(resolveOpenAiEffort("max")).toBe("o1-pro");
    });

    it("openrouter maps to provider-prefixed slugs", () => {
      expect(resolveOpenRouterEffort("medium")).toContain("/");
    });
  });

  describe("defaultEffortModelFor", () => {
    it("returns adapter-appropriate model", () => {
      expect(defaultEffortModelFor("claude-cli", "medium")).toBe("claude-sonnet-4-6");
      expect(defaultEffortModelFor("openai", "low")).toBe("gpt-4o-mini");
    });
  });
});
