import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AdapterInvocationRecord, AuditLog } from "../../src/core/audit-log.js";
import { buildRollup, formatRollup } from "../../src/core/cost-tracker.js";

let dir: string;
let log: AuditLog;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-costs-"));
  log = new AuditLog({
    filePath: path.join(dir, "invocations.ndjson"),
    rotatedDir: path.join(dir, "logs", "invocations"),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function rec(overrides: Partial<AdapterInvocationRecord>): AdapterInvocationRecord {
  return {
    ts: "2026-05-02T10:00:00.000Z",
    type: "adapter_invocation",
    runId: "R",
    agent: "alpha",
    task: "scan",
    trigger: { kind: "cron", expr: "0 3 * * *" },
    adapter: "claude-cli",
    modelUsed: "claude-sonnet-4-6",
    effort: "medium",
    tokens: { input: 100, output: 20 },
    costUsd: null,
    subscriptionCovered: true,
    durationMs: 1000,
    toolCalls: 0,
    ok: true,
    ...overrides,
  };
}

describe("buildRollup", () => {
  it("returns empty buckets when log is empty", async () => {
    const r = await buildRollup(log);
    expect(r.total.invocations).toBe(0);
  });

  it("sums tokens across calls", async () => {
    await log.append(rec({ runId: "R1", tokens: { input: 100, output: 20 } }));
    await log.append(rec({ runId: "R2", tokens: { input: 50, output: 10 } }));
    const r = await buildRollup(log);
    expect(r.total.tokensInput).toBe(150);
    expect(r.total.tokensOutput).toBe(30);
  });

  it("KEEPS subscription-covered separate from metered $", async () => {
    await log.append(
      rec({ runId: "sub", adapter: "claude-cli", subscriptionCovered: true, costUsd: null }),
    );
    await log.append(
      rec({
        runId: "metered",
        adapter: "anthropic-api",
        subscriptionCovered: false,
        costUsd: 0.0234,
      }),
    );
    const r = await buildRollup(log);
    expect(r.total.subscriptionInvocations).toBe(1);
    expect(r.total.meteredUsd).toBeCloseTo(0.0234, 4);
    expect(r.byAdapter["claude-cli"]?.meteredUsd).toBe(0);
    expect(r.byAdapter["anthropic-api"]?.subscriptionInvocations).toBe(0);
  });

  it("buckets by agent / adapter / month", async () => {
    await log.append(rec({ runId: "1", agent: "alpha", ts: "2026-04-15T00:00:00Z" }));
    await log.append(
      rec({
        runId: "2",
        agent: "beta",
        ts: "2026-05-01T00:00:00Z",
        adapter: "openai",
        subscriptionCovered: false,
        costUsd: 0.5,
      }),
    );
    await log.append(rec({ runId: "3", agent: "alpha", ts: "2026-05-02T00:00:00Z" }));
    const r = await buildRollup(log);

    expect(r.byAgent.alpha?.invocations).toBe(2);
    expect(r.byAgent.beta?.invocations).toBe(1);
    expect(r.byAdapter.openai?.invocations).toBe(1);
    expect(r.byAdapter["claude-cli"]?.invocations).toBe(2);
    expect(r.byMonth["2026-04"]?.invocations).toBe(1);
    expect(r.byMonth["2026-05"]?.invocations).toBe(2);
  });

  it("formatRollup mentions both subscription and metered when both present", async () => {
    await log.append(rec({ runId: "sub" }));
    await log.append(
      rec({
        runId: "metered",
        adapter: "openai",
        subscriptionCovered: false,
        costUsd: 0.05,
      }),
    );
    const text = formatRollup(await buildRollup(log));
    expect(text).toMatch(/subscription/);
    expect(text).toMatch(/metered/);
    expect(text).toMatch(/\$0\.0500/);
  });
});
