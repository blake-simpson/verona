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

  it("--agent filter narrows results", async () => {
    await runScheduleRun({ stateDir, taskSpec: "hello-world:greet" });
    const matching = await runInvocations({ stateDir, agent: "hello-world" });
    const empty = await runInvocations({ stateDir, agent: "no-such-agent" });
    expect(matching).toContain("hello-world");
    expect(empty).toBe("(no invocations)");
  });
});
