import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentsAdd } from "../../src/cli/commands/agents.js";
import { runInit } from "../../src/cli/commands/init.js";
import { listLogs } from "../../src/cli/commands/logs.js";
import {
  runScheduleList,
  runScheduleNext,
  runScheduleRun,
} from "../../src/cli/commands/schedule.js";

const FIXTURE_HELLO = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);
const FAKE_CLAUDE = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-claude.sh");

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-sched-cli-"));
  await runInit({ stateDir });
  process.env.VERONA_CLAUDE_BIN = FAKE_CLAUDE;
});

afterEach(async () => {
  delete process.env.VERONA_CLAUDE_BIN;
  await rm(stateDir, { recursive: true, force: true });
});

describe("verona schedule list / next", () => {
  it("returns '(no scheduled tasks)' when no agents are registered", async () => {
    const out = await runScheduleList({ stateDir });
    expect(out).toBe("(no scheduled tasks)");
  });

  it("aggregates scheduled tasks across registered agents", async () => {
    await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
    const out = await runScheduleList({ stateDir });
    expect(out).toContain("hello-world:greet");
    expect(out).toContain("0 9 * * *");
  });

  it("next returns the upcoming task line", async () => {
    await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
    const out = await runScheduleNext({ stateDir });
    expect(out).toContain("hello-world:greet");
  });
});

describe("verona schedule run", () => {
  it("triggers a task immediately and produces an episodic log", async () => {
    await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
    await runScheduleRun({ stateDir, taskSpec: "hello-world:greet" });

    const logs = await listLogs({ stateDir, agentName: "hello-world" });
    expect(logs.length).toBe(1);
    expect(logs[0]?.taskId).toBe("greet");
  });

  it("rejects malformed task specs", async () => {
    await expect(runScheduleRun({ stateDir, taskSpec: "no-colon" })).rejects.toThrow(/expected/);
  });
});
