import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runAgentsAdd,
  runAgentsInit,
  runAgentsList,
  runAgentsRemove,
} from "../../src/cli/commands/agents.js";
import { runInit } from "../../src/cli/commands/init.js";
import { ConfigError, StateError } from "../../src/util/errors.js";

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

describe("verona agents remove", () => {
  it("removes the state-tree dir and commits the deletion", async () => {
    await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
    expect(await runAgentsList({ stateDir })).toEqual(["hello-world"]);

    const result = await runAgentsRemove({ name: "hello-world", stateDir });
    expect(result.agentName).toBe("hello-world");
    expect(result.commit).toBeTruthy();

    expect(await runAgentsList({ stateDir })).toEqual([]);

    const log = await simpleGit(stateDir).log();
    expect(log.latest?.message).toContain("remove agent hello-world");

    // the dir is gone from the state tree
    await expect(stat(path.join(stateDir, "agents", "hello-world"))).rejects.toThrow();
  });

  it("throws StateError if the agent isn't registered", async () => {
    await expect(runAgentsRemove({ name: "ghost", stateDir })).rejects.toBeInstanceOf(StateError);
  });
});

describe("verona agents init", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = await mkdtemp(path.join(tmpdir(), "verona-init-agents-"));
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  it("scaffolds from the bundled hello-world template into the agents dir", async () => {
    const result = await runAgentsInit({
      name: "smoke-1",
      template: "hello-world",
      agentsDir,
    });
    expect(result.agentName).toBe("smoke-1");
    expect(result.targetDir).toBe(path.join(agentsDir, "smoke-1"));

    // Files copied
    expect((await stat(path.join(result.targetDir, "agent.toml"))).isFile()).toBe(true);
    expect((await stat(path.join(result.targetDir, "SOUL.md"))).isFile()).toBe(true);

    // agent.toml's [agent].name was rewritten to the new name
    const toml = await readFile(path.join(result.targetDir, "agent.toml"), "utf8");
    expect(toml).toMatch(/\[agent\][\s\S]*?name = "smoke-1"/);
    expect(toml).not.toMatch(/name = "hello-world"/);
  });

  it("scaffolds from the bundled researcher template", async () => {
    const result = await runAgentsInit({
      name: "research-personal",
      template: "researcher",
      agentsDir,
    });
    const toml = await readFile(path.join(result.targetDir, "agent.toml"), "utf8");
    expect(toml).toMatch(/name = "research-personal"/);
    // Researcher has [[tasks]] blocks with their own `id` field; rewrite must
    // not touch those.
    expect(toml).toMatch(/id = "nightly-scan"/);
  });

  it("refuses to clobber an existing target dir", async () => {
    await runAgentsInit({ name: "dup", template: "hello-world", agentsDir });
    await expect(
      runAgentsInit({ name: "dup", template: "hello-world", agentsDir }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects an invalid agent name", async () => {
    await expect(
      runAgentsInit({ name: "Has Spaces", template: "hello-world", agentsDir }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects an unknown template", async () => {
    await expect(
      runAgentsInit({ name: "ok", template: "definitely-not-real", agentsDir }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("respects VERONA_AGENTS_DIR env var when agentsDir is omitted", async () => {
    const envDir = await mkdtemp(path.join(tmpdir(), "verona-init-env-"));
    const prev = process.env.VERONA_AGENTS_DIR;
    process.env.VERONA_AGENTS_DIR = envDir;
    try {
      const result = await runAgentsInit({ name: "from-env", template: "hello-world" });
      expect(result.targetDir.startsWith(envDir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VERONA_AGENTS_DIR;
      else process.env.VERONA_AGENTS_DIR = prev;
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
