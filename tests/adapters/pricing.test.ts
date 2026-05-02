import { describe, expect, it } from "vitest";
import { computeCostUsd, lookupPricing } from "../../src/adapters/pricing.js";

describe("pricing", () => {
  it("returns null for unknown models", () => {
    expect(lookupPricing("anthropic", "definitely-not-real")).toBeNull();
    expect(lookupPricing("openai", "ghost-model")).toBeNull();
  });

  it("knows core Claude prices", () => {
    expect(lookupPricing("anthropic", "claude-sonnet-4-6")).toEqual(
      expect.objectContaining({ input: 3, output: 15 }),
    );
    expect(lookupPricing("anthropic", "claude-opus-4-7")).toEqual(
      expect.objectContaining({ input: 15, output: 75 }),
    );
  });

  it("computeCostUsd: 1M input tokens at $3 = $3", () => {
    const cost = computeCostUsd({ input: 1_000_000, output: 0 }, { input: 3, output: 15 });
    expect(cost).toBeCloseTo(3, 6);
  });

  it("computeCostUsd: cache reads are billed at the cacheRead rate, not input", () => {
    const cost = computeCostUsd(
      { input: 1_000_000, output: 0, cacheRead: 1_000_000 },
      { input: 3, output: 15, cacheRead: 0.3 },
    );
    // input has 0 billable (all cache), output 0, cacheRead 1M @ 0.3 = $0.30
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it("computeCostUsd: combines input + output + cache writes", () => {
    const cost = computeCostUsd(
      { input: 200_000, output: 50_000, cacheWrite: 100_000 },
      { input: 3, output: 15, cacheWrite: 3.75 },
    );
    // billable input = 200k - 100k = 100k @ $3 = $0.30
    // output 50k @ $15 = $0.75
    // cache write 100k @ $3.75 = $0.375
    // total $1.425
    expect(cost).toBeCloseTo(1.425, 6);
  });
});
