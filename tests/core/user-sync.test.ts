import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUserInit, runUserPush } from "../../src/cli/commands/user.js";
import { UserSync } from "../../src/core/user-sync.js";

let workspace: string;
let userDir: string;
let bareRemote: string;
let stateDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "verona-user-sync-"));
  userDir = path.join(workspace, "user");
  bareRemote = path.join(workspace, "remote.git");
  stateDir = path.join(workspace, "state");
  await mkdir(stateDir, { recursive: true });
  await simpleGit().init(["--bare", bareRemote]);
  process.env.VERONA_USER_DIR = userDir;
});

afterEach(async () => {
  delete process.env.VERONA_USER_DIR;
  await rm(workspace, { recursive: true, force: true });
});

describe("UserSync.tick()", () => {
  it("does not call onChange when remote HEAD is unchanged", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await runUserPush({ userDir });
    const onChange = vi.fn(async () => {});
    const sync = new UserSync({
      enabled: true,
      interval: "*/5 * * * *",
      reloadOnChange: true,
      stateDir,
      onChange,
    });
    await sync.tick();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onChange after a divergent remote commit lands", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await runUserPush({ userDir });

    // Simulate the laptop pushing
    const otherDir = path.join(workspace, "other");
    await mkdir(otherDir, { recursive: true });
    await simpleGit().clone(bareRemote, otherDir);
    const og = simpleGit(otherDir);
    await og.addConfig("user.name", "other");
    await og.addConfig("user.email", "other@local");
    await mkdir(path.join(otherDir, "agents"), { recursive: true });
    await writeFile(path.join(otherDir, "agents", "x.txt"), "hi", "utf8");
    await og.add(["-A"]);
    await og.commit("from laptop");
    await og.push();

    const onChange = vi.fn(async () => {});
    const sync = new UserSync({
      enabled: true,
      interval: "*/5 * * * *",
      reloadOnChange: true,
      stateDir,
      onChange,
    });
    await sync.tick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("respects reloadOnChange = false (does not call onChange)", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await runUserPush({ userDir });

    const otherDir = path.join(workspace, "other");
    await mkdir(otherDir, { recursive: true });
    await simpleGit().clone(bareRemote, otherDir);
    const og = simpleGit(otherDir);
    await og.addConfig("user.name", "other");
    await og.addConfig("user.email", "other@local");
    await mkdir(path.join(otherDir, "agents"), { recursive: true });
    await writeFile(path.join(otherDir, "agents", "x.txt"), "hi", "utf8");
    await og.add(["-A"]);
    await og.commit("from laptop");
    await og.push();

    const onChange = vi.fn(async () => {});
    const sync = new UserSync({
      enabled: true,
      interval: "*/5 * * * *",
      reloadOnChange: false,
      stateDir,
      onChange,
    });
    await sync.tick();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("swallows pull errors and continues", async () => {
    // Init repo but don't add a remote so pull will fail
    await runUserInit({ userDir });
    const onChange = vi.fn(async () => {});
    const sync = new UserSync({
      enabled: true,
      interval: "*/5 * * * *",
      reloadOnChange: true,
      stateDir,
      onChange,
    });
    // Should not throw
    await expect(sync.tick()).resolves.toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("start() with enabled=false is a no-op", () => {
    const sync = new UserSync({
      enabled: false,
      interval: "*/5 * * * *",
      reloadOnChange: true,
      stateDir,
    });
    sync.start();
    sync.stop();
    // No assertion — just shouldn't throw
  });
});
