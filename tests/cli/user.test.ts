import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runUserInit,
  runUserPull,
  runUserPush,
  runUserStatus,
} from "../../src/cli/commands/user.js";

let workspace: string;
let userDir: string;
let bareRemote: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "verona-user-cli-"));
  userDir = path.join(workspace, "user");
  bareRemote = path.join(workspace, "remote.git");
  await simpleGit().init(["--bare", bareRemote]);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("verona user init", () => {
  it("creates the user dir, agents/ connectors/ skills/ subdirs, and a git repo", async () => {
    const result = await runUserInit({ userDir });
    expect(result.initialized).toBe(true);
    expect(result.userDir).toBe(userDir);
    await stat(path.join(userDir, "agents"));
    await stat(path.join(userDir, "connectors"));
    await stat(path.join(userDir, "skills"));
    await stat(path.join(userDir, ".git"));
    const gi = await readFile(path.join(userDir, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/");
    const log = await simpleGit(userDir).log();
    expect(log.latest?.message).toContain("initialize user content repo");
  });

  it("is idempotent — second call leaves the existing repo intact", async () => {
    await runUserInit({ userDir });
    const headBefore = (await simpleGit(userDir).revparse(["HEAD"])).trim();
    const result2 = await runUserInit({ userDir });
    expect(result2.initialized).toBe(false);
    const headAfter = (await simpleGit(userDir).revparse(["HEAD"])).trim();
    expect(headAfter).toBe(headBefore);
  });

  it("adds origin when --remote is provided", async () => {
    const result = await runUserInit({ userDir, remote: bareRemote });
    expect(result.remote).toBe(bareRemote);
    const remotes = await simpleGit(userDir).getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    expect(origin?.refs.fetch).toBe(bareRemote);
  });
});

describe("verona user push", () => {
  it("commits pending changes and pushes to origin", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await writeFile(path.join(userDir, "agents", "demo.txt"), "hi", "utf8");
    const result = await runUserPush({ userDir });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commit).toBeTruthy();

    // confirm the bare remote received it
    const log = await simpleGit(bareRemote).log();
    expect(log.total).toBeGreaterThanOrEqual(1);
  });

  it("pushes even when there's nothing new to commit", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    const result = await runUserPush({ userDir });
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(true);
  });

  it("errors if no origin is configured", async () => {
    await runUserInit({ userDir });
    await expect(runUserPush({ userDir })).rejects.toThrow(/origin/);
  });
});

describe("verona user pull", () => {
  it("reports `changed: false` when HEAD is unchanged", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await runUserPush({ userDir }); // seed remote
    const result = await runUserPull({ userDir, noReload: true });
    expect(result.changed).toBe(false);
  });

  it("reports `changed: true` after a divergent commit on the remote", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await runUserPush({ userDir }); // seed

    // Simulate a different machine pushing to the same remote
    const otherDir = path.join(workspace, "other");
    await mkdir(otherDir, { recursive: true });
    await simpleGit().clone(bareRemote, otherDir);
    const otherGit = simpleGit(otherDir);
    await otherGit.addConfig("user.name", "other");
    await otherGit.addConfig("user.email", "other@local");
    await mkdir(path.join(otherDir, "agents"), { recursive: true });
    await writeFile(path.join(otherDir, "agents", "from-laptop.txt"), "edits", "utf8");
    await otherGit.add(["-A"]);
    await otherGit.commit("changes from laptop");
    await otherGit.push();

    const result = await runUserPull({ userDir, noReload: true });
    expect(result.changed).toBe(true);
    expect(result.before).not.toBe(result.after);
    // reloaded=false because noReload is set
    expect(result.reloaded).toBe(false);
  });
});

describe("verona user status", () => {
  it("returns branch, remote, ahead/behind, and dirty counts", async () => {
    await runUserInit({ userDir, remote: bareRemote });
    await writeFile(path.join(userDir, "connectors", "x.txt"), "untracked", "utf8");
    const result = await runUserStatus({ userDir });
    expect(result.userDir).toBe(userDir);
    expect(result.remote).toBe(bareRemote);
    expect(result.untracked).toBeGreaterThanOrEqual(1);
  });
});
