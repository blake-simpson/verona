import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentsAdd, runAgentsList } from "../../src/cli/commands/agents.js";
import { runInit } from "../../src/cli/commands/init.js";

const FIXTURE_HELLO = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-agents-cli-"));
  await runInit({ stateDir });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("verona agents add", () => {
  it("registers an agent and produces a git commit", async () => {
    const result = await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
    expect(result.agentName).toBe("hello-world");
    expect(result.fresh).toBe(true);
    expect(result.commit).toBeTruthy();

    const log = await simpleGit(stateDir).log();
    expect(log.latest?.message).toContain("register agent hello-world");

    // The agent dir is materialized.
    expect((await stat(path.join(stateDir, "agents", "hello-world", "agent.toml"))).isFile()).toBe(
      true,
    );
  });

  it("listing after add returns the new agent", async () => {
    await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
    const list = await runAgentsList({ stateDir });
    expect(list).toEqual(["hello-world"]);
  });
});
