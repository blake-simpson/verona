import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentsAdd } from "../../src/cli/commands/agents.js";
import { runCosts } from "../../src/cli/commands/costs.js";
import { runInit } from "../../src/cli/commands/init.js";
import { runInvocations } from "../../src/cli/commands/invocations.js";
import { runScheduleRun } from "../../src/cli/commands/schedule.js";
import { AuditLog } from "../../src/core/audit-log.js";
import { statePaths } from "../../src/state/paths.js";

const FIXTURE_HELLO = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);
const FAKE_CLAUDE = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-claude.sh");

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-audit-cli-"));
  await runInit({ stateDir });
  await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
  process.env.VERONA_CLAUDE_BIN = FAKE_CLAUDE;
});

afterEach(async () => {
  delete process.env.VERONA_CLAUDE_BIN;
  await rm(stateDir, { recursive: true, force: true });
});

describe("verona invocations + verona costs (end-to-end)", () => {
  it("running a task writes one adapter_invocation record visible to invocations + costs", async () => {
    const before = await runInvocations({ stateDir });
    expect(before).toBe("(no invocations)");

    await runScheduleRun({ stateDir, taskSpec: "hello-world:greet" });

    const after = await runInvocations({ stateDir });
    expect(after).toContain("adapter_invocation");
    expect(after).toContain("hello-world:greet");
    expect(after).toContain("subscription"); // claude-cli is subscription-covered

    const costs = await runCosts({ stateDir });
    expect(costs).toContain("hello-world");
    expect(costs).toContain("subscription");
    // claude-cli is subscription-covered, so no $ figure should appear
    expect(costs).not.toMatch(/\$\d+\.\d+/);
  });

  it("--json mode emits raw NDJSON parseable line by line", async () => {
    await runScheduleRun({ stateDir, taskSpec: "hello-world:greet" });
    const raw = await runInvocations({ stateDir, json: true });
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("adapter_invocation");
    expect(parsed.agent).toBe("hello-world");
  });

  it("surfaces errorMessage on an indented detail line for failed records", async () => {
    const paths = statePaths(stateDir);
    const log = new AuditLog({
      filePath: paths.invocations,
      rotatedDir: path.join(paths.logs, "invocations"),
    });
    await log.append({
      ts: new Date().toISOString(),
      type: "adapter_invocation",
      runId: "01TESTRUNFAILXYZ",
      agent: "lead-generator",
      task: "reply",
      trigger: { kind: "message", from: "U08HY4CFH5H" },
      adapter: "claude-cli",
      modelUsed: "(unknown)",
      effort: "medium",
      tokens: { input: 0, output: 0 },
      costUsd: null,
      subscriptionCovered: false,
      durationMs: 9601,
      toolCalls: 0,
      ok: false,
      errorClass: "AdapterError",
      errorMessage: "claude exited with code 1\nstderr tail:\nimage exceeds maximum size",
    });
    await log.drain();

    const out = await runInvocations({ stateDir });
    expect(out).toContain("ERR");
    expect(out).toContain("lead-generator:reply");
    // Reason rendered on a continuation line, multi-line stderr re-indented.
    expect(out).toContain("↳ claude exited with code 1");
    expect(out).toContain("image exceeds maximum size");
  });

  it("--agent filter narrows results", async () => {
    await runScheduleRun({ stateDir, taskSpec: "hello-world:greet" });
    const matching = await runInvocations({ stateDir, agent: "hello-world" });
    const empty = await runInvocations({ stateDir, agent: "no-such-agent" });
    expect(matching).toContain("hello-world");
    expect(empty).toBe("(no invocations)");
  });
});
