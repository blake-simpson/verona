import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/init.js";
import { runReload } from "../../src/cli/commands/reload.js";
import { statePaths } from "../../src/state/paths.js";
import { StateError } from "../../src/util/errors.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-reload-"));
  await runInit({ stateDir });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("verona reload", () => {
  it("throws StateError when no pidfile exists", async () => {
    await expect(runReload({ stateDir })).rejects.toBeInstanceOf(StateError);
  });

  it("throws StateError when pidfile points to a dead process", async () => {
    // Write a clearly nonexistent pid (very high number unlikely to exist).
    const paths = statePaths(stateDir);
    await writeFile(paths.daemonPid, "999999\n", "utf8");
    await expect(runReload({ stateDir })).rejects.toBeInstanceOf(StateError);
  });

  it("throws StateError on non-numeric pidfile contents", async () => {
    const paths = statePaths(stateDir);
    await writeFile(paths.daemonPid, "not-a-pid", "utf8");
    await expect(runReload({ stateDir })).rejects.toBeInstanceOf(StateError);
  });

  it("sends SIGHUP to a live process whose pid is in the pidfile", async () => {
    // Spawn a child that:
    //   1. installs SIGHUP handler that writes a marker + exits
    //   2. prints "READY" on stdout once the handler is wired
    //   3. otherwise sleeps forever
    // We wait for "READY" before sending SIGHUP so the test isn't timing-bound.
    const markerFile = path.join(stateDir, "sighup.marker");
    const childScript = `
      process.on("SIGHUP", () => {
        require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "got it");
        process.exit(0);
      });
      process.stdout.write("READY\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn("node", ["-e", childScript], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: false,
    });

    try {
      // Wait until the child confirms it's ready.
      await new Promise<void>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("READY")) {
            child.stdout?.off("data", onData);
            resolve();
          }
        };
        child.stdout?.on("data", onData);
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`child exited early (${code})`)));
        setTimeout(() => reject(new Error("child never reported READY")), 5000);
      });

      const paths = statePaths(stateDir);
      await writeFile(paths.daemonPid, `${child.pid}\n`, "utf8");

      const result = await runReload({ stateDir });
      expect(result.pid).toBe(child.pid);

      // Wait for the child's exit (its handler exits after writing the marker).
      await new Promise<void>((resolve, reject) => {
        child.on("exit", () => resolve());
        setTimeout(() => reject(new Error("child did not exit after SIGHUP")), 5000);
      });

      const fs = await import("node:fs/promises");
      const marker = await fs.readFile(markerFile, "utf8");
      expect(marker).toBe("got it");
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
  });
});
