import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRegisteredAgents, registerAgent } from "../../src/state/agent-registry.js";

const FIXTURE_HELLO = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-registry-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("agent-registry.registerAgent", () => {
  it("fresh-adds an agent: copies dir and scaffolds memory subdirs", async () => {
    const result = await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    expect(result.fresh).toBe(true);
    expect(result.agentName).toBe("hello-world");

    const agentRoot = path.join(stateDir, "agents", "hello-world");
    expect((await stat(path.join(agentRoot, "agent.toml"))).isFile()).toBe(true);
    expect((await stat(path.join(agentRoot, "SOUL.md"))).isFile()).toBe(true);
    expect((await stat(path.join(agentRoot, "tasks", "greet.md"))).isFile()).toBe(true);
    expect((await stat(path.join(agentRoot, "memory", "INDEX.md"))).isFile()).toBe(true);
    expect((await stat(path.join(agentRoot, "memory", "core"))).isDirectory()).toBe(true);
    expect((await stat(path.join(agentRoot, "memory", "learned", "facts"))).isDirectory()).toBe(true);
    expect((await stat(path.join(agentRoot, "memory", "learned", "episodic"))).isDirectory()).toBe(
      true,
    );
    expect((await stat(path.join(agentRoot, "memory", "learned", "working"))).isDirectory()).toBe(
      true,
    );
  });

  it("re-add PRESERVES memory/learned/** (the agent's persistent state)", async () => {
    await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    const learnedFile = path.join(
      stateDir,
      "agents",
      "hello-world",
      "memory",
      "learned",
      "facts",
      "important.md",
    );
    await writeFile(learnedFile, "AGENT-AUTHORED: do not lose this", "utf8");

    // Simulate re-adding (e.g. after pulling new agent code).
    const result = await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    expect(result.fresh).toBe(false);
    expect(await readFile(learnedFile, "utf8")).toBe("AGENT-AUTHORED: do not lose this");
  });

  it("re-add PRESERVES memory/INDEX.md mutations", async () => {
    await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    const indexPath = path.join(stateDir, "agents", "hello-world", "memory", "INDEX.md");
    await writeFile(indexPath, "AGENT-CURATED INDEX", "utf8");

    await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    expect(await readFile(indexPath, "utf8")).toBe("AGENT-CURATED INDEX");
  });

  it("re-add UPDATES SOUL.md and tasks/ from source", async () => {
    await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    const stateSoulPath = path.join(stateDir, "agents", "hello-world", "SOUL.md");
    // simulate a stale soul in state by overwriting
    await writeFile(stateSoulPath, "STALE", "utf8");

    await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    const refreshed = await readFile(stateSoulPath, "utf8");
    expect(refreshed).not.toBe("STALE");
    expect(refreshed).toContain("hello-world");
  });

  it("listRegisteredAgents returns sorted agent names", async () => {
    await registerAgent({ sourceDir: FIXTURE_HELLO, stateDir });
    const names = await listRegisteredAgents(stateDir);
    expect(names).toEqual(["hello-world"]);
  });

  it("listRegisteredAgents returns [] when no state dir exists", async () => {
    const empty = await listRegisteredAgents(path.join(stateDir, "nonexistent"));
    expect(empty).toEqual([]);
  });
});
