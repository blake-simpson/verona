import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRecorder } from "../../src/core/git-recorder.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-git-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("GitRecorder", () => {
  it("ensureRepo initializes a git repo with a default .gitignore", async () => {
    const recorder = new GitRecorder({ stateDir });
    await recorder.ensureRepo();
    const log = await simpleGit(stateDir).log();
    expect(log.total).toBeGreaterThanOrEqual(1);
    expect(log.latest?.message).toContain("initialize state tree");
  });

  it("commit returns the new commit SHA when there are staged changes", async () => {
    const recorder = new GitRecorder({ stateDir });
    await recorder.ensureRepo();
    await writeFile(path.join(stateDir, "verona.toml"), "log_level = 'info'\n", "utf8");
    const sha = await recorder.commit({
      message: "verona: add config",
      paths: ["verona.toml"],
    });
    expect(sha).toBeTruthy();
    const log = await simpleGit(stateDir).log();
    expect(log.latest?.message).toBe("verona: add config");
  });

  it("commit returns null when skipIfClean and tree is clean", async () => {
    const recorder = new GitRecorder({ stateDir });
    await recorder.ensureRepo();
    const sha = await recorder.commit({
      message: "noop",
      paths: [],
      skipIfClean: true,
    });
    expect(sha).toBeNull();
  });

  it("recordMemoryUpdate stages an agent dir and commits with a structured message", async () => {
    const recorder = new GitRecorder({ stateDir });
    await recorder.ensureRepo();
    const agentDir = path.join(stateDir, "agents", "researcher", "memory", "learned", "facts");
    await import("node:fs/promises").then((m) => m.mkdir(agentDir, { recursive: true }));
    await writeFile(path.join(agentDir, "alpha.md"), "alpha", "utf8");

    const sha = await recorder.recordMemoryUpdate({
      agentName: "researcher",
      taskId: "nightly-scan",
      runId: "01HX3Q-runid",
    });
    expect(sha).toBeTruthy();

    const log = await simpleGit(stateDir).log();
    expect(log.latest?.message).toContain("agent:researcher task:nightly-scan run:01HX3Q-runid");
  });
});
