import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentsAdd } from "../../src/cli/commands/agents.js";
import { runInit } from "../../src/cli/commands/init.js";
import { Daemon } from "../../src/core/daemon.js";
import { ConfigError } from "../../src/util/errors.js";

const FIXTURE_HELLO = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);
const FAKE_CLAUDE = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-claude.sh");

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-daemon-"));
  await runInit({ stateDir });
  await runAgentsAdd({ sourceDir: FIXTURE_HELLO, stateDir });
  process.env.VERONA_CLAUDE_BIN = FAKE_CLAUDE;
});

afterEach(async () => {
  delete process.env.VERONA_CLAUDE_BIN;
  delete process.env.VERONA_FAKE_CLAUDE_LOG;
  await rm(stateDir, { recursive: true, force: true });
});

describe("Daemon", () => {
  it("bootstrap discovers registered agents and registers their schedules", async () => {
    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    const jobs = daemon.scheduler_().list();
    await daemon.stop();
    // hello-world fixture has one scheduled task: greet @ "0 9 * * *"
    expect(jobs.map((j) => `${j.agentName}:${j.taskId}`)).toEqual(["hello-world:greet"]);
  });

  it("runTask invokes dispatcher end-to-end via fake claude", async () => {
    const logPath = path.join(stateDir, "fake-claude.log");
    process.env.VERONA_FAKE_CLAUDE_LOG = logPath;

    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    await daemon.runTask({
      agentName: "hello-world",
      taskId: "greet",
      trigger: { kind: "manual" },
    });
    await daemon.stop();

    // Fake claude was invoked
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("--add-dir");
    expect(log).toContain("hello-world");

    // Episodic log was written
    const episodicDir = path.join(
      stateDir,
      "agents",
      "hello-world",
      "memory",
      "learned",
      "episodic",
    );
    const files = await import("node:fs/promises").then((m) => m.readdir(episodicDir));
    expect(files.length).toBeGreaterThan(0);
  });

  it("runTask throws ConfigError for unknown agent task", async () => {
    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    await expect(
      daemon.runTask({
        agentName: "hello-world",
        taskId: "does-not-exist",
        trigger: { kind: "manual" },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    await daemon.stop();
  });

  it("stop() does not delete a pidfile this Daemon instance never wrote", async () => {
    // Simulates the bug: `verona schedule run` builds an ephemeral Daemon
    // that calls bootstrap+runTask+stop but never run() (so never writes a
    // pidfile). The long-running daemon's pidfile must survive.
    const pidFile = path.join(stateDir, "daemon.pid");
    await writeFile(pidFile, "5568\n", "utf8");

    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    await daemon.stop();

    expect(existsSync(pidFile)).toBe(true);
    expect((await readFile(pidFile, "utf8")).trim()).toBe("5568");
  });
});
