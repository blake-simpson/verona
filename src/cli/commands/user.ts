/**
 * `verona user {init,push,pull,status}` — manage the user content git repo at
 * ~/.verona/user/. One repo holds two subdirs: `agents/` (your agent
 * definitions) and `connectors/` (your authored connectors).
 *
 *   init   — `git init`, scaffold subdirs, write a sane .gitignore. Optional
 *            `--remote <url>` adds an origin so you can `verona user push`.
 *   push   — stage everything, commit if dirty, push to origin.
 *   pull   — `git pull --ff-only`, then trigger `verona reload` if HEAD moved.
 *   status — terse `git status` summary.
 *
 * Secrets live in <state>/secrets/, never in the user repo. Tokens are
 * captured per-machine via `verona connectors add <id>`.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { resolveUserDir } from "../../state/paths.js";
import { ConfigError, StateError } from "../../util/errors.js";
import { runReload } from "./reload.js";

const DEFAULT_GITIGNORE = [
  "# Verona user content gitignore",
  "# Authored agents and connectors are committed; build/runtime artefacts are not.",
  "",
  "node_modules/",
  ".DS_Store",
  "*.log",
  "",
  "# By default, build outputs (dist/) ARE committed so the server doesn't",
  "# need a build toolchain. Uncomment if you'd rather build on the server:",
  "# **/dist/",
  "",
].join("\n");

const DEFAULT_README = [
  "# Verona — user content",
  "",
  "This repo holds your authored agents and connectors. Verona's daemon",
  "reads from here at startup and on `verona reload`.",
  "",
  "Layout:",
  "",
  "    agents/<name>/      one directory per agent (SOUL.md, agent.toml, tasks/)",
  "    connectors/<id>/    one directory per connector (connector.toml, src/, dist/)",
  "",
  "Secrets are NOT stored here — they live per-machine in `~/.verona/state/secrets/`,",
  "captured via `verona connectors add <id>`.",
  "",
].join("\n");

export interface UserInitOptions {
  userDir?: string;
  /** Optional git remote URL. If provided, `git remote add origin <url>` runs. */
  remote?: string;
}

export interface UserInitResult {
  userDir: string;
  /** True if .git/ was created during this run. False if the dir was already a repo. */
  initialized: boolean;
  remote: string | null;
}

export async function runUserInit(opts: UserInitOptions = {}): Promise<UserInitResult> {
  const userDir = resolveUserDir(opts.userDir);
  await mkdir(userDir, { recursive: true });
  await mkdir(path.join(userDir, "agents"), { recursive: true });
  await mkdir(path.join(userDir, "connectors"), { recursive: true });

  const git = simpleGit(userDir);
  const wasRepo = await isGitRepo(userDir);
  if (!wasRepo) {
    await git.init();
    await ensureCommitIdentity(git);
    // Force the initial branch to `main` regardless of git's
    // `init.defaultBranch` setting. Sidesteps master/main mismatches when
    // the GitHub remote defaults to main but the local git is older.
    // `symbolic-ref` works before the first commit; non-fatal if it fails.
    try {
      await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    } catch {
      /* leave whatever git's default produced */
    }
  }

  const gitignorePath = path.join(userDir, ".gitignore");
  if (!(await pathExists(gitignorePath))) {
    await writeFile(gitignorePath, DEFAULT_GITIGNORE, "utf8");
  }
  const readmePath = path.join(userDir, "README.md");
  if (!(await pathExists(readmePath))) {
    await writeFile(readmePath, DEFAULT_README, "utf8");
  }

  if (!wasRepo) {
    await git.add([".gitignore", "README.md"]);
    await git.commit("verona: initialize user content repo");
  }

  let remote: string | null = null;
  if (opts.remote) {
    const remotes = await git.getRemotes(true);
    const existing = remotes.find((r) => r.name === "origin");
    if (existing) {
      if (existing.refs.fetch !== opts.remote) {
        await git.remote(["set-url", "origin", opts.remote]);
      }
    } else {
      await git.addRemote("origin", opts.remote);
    }
    remote = opts.remote;
  } else {
    const remotes = await git.getRemotes(true);
    const existing = remotes.find((r) => r.name === "origin");
    remote = existing?.refs.fetch ?? null;
  }

  return { userDir, initialized: !wasRepo, remote };
}

export interface UserPushOptions {
  userDir?: string;
  message?: string;
}

export interface UserPushResult {
  userDir: string;
  committed: boolean;
  pushed: boolean;
  commit: string | null;
}

export async function runUserPush(opts: UserPushOptions = {}): Promise<UserPushResult> {
  const userDir = resolveUserDir(opts.userDir);
  await ensureRepo(userDir);
  const git = simpleGit(userDir);
  await ensureCommitIdentity(git);

  const status = await git.status();
  let commit: string | null = null;
  let committed = false;
  if (!status.isClean()) {
    await git.add(["-A"]);
    const commitMessage =
      opts.message ?? `verona user push @ ${new Date().toISOString().slice(0, 19)}Z`;
    const result = await git.commit(commitMessage);
    commit = result.commit || null;
    committed = true;
  }

  const remotes = await git.getRemotes(true);
  if (!remotes.some((r) => r.name === "origin")) {
    throw new StateError(
      `no \`origin\` remote configured for ${userDir}. Set one with \`git -C ${userDir} remote add origin <url>\` or rerun \`verona user init --remote <url>\`.`,
    );
  }
  // Always pass --set-upstream so the first push works without depending on
  // the host's `push.autoSetupRemote` config (default since git 2.37, but
  // missing on older systems and CI runners). Idempotent: re-confirms the
  // tracking ref on subsequent pushes.
  const currentBranch = (await git.status()).current;
  if (!currentBranch) {
    throw new StateError(`could not determine current branch in ${userDir}`);
  }
  await git.push(["--set-upstream", "origin", currentBranch]);
  return { userDir, committed, pushed: true, commit };
}

export interface UserPullOptions {
  userDir?: string;
  stateDir?: string;
  /** When true, does NOT signal the daemon even if HEAD changed. */
  noReload?: boolean;
}

export interface UserPullResult {
  userDir: string;
  before: string | null;
  after: string | null;
  changed: boolean;
  reloaded: boolean;
}

export async function runUserPull(opts: UserPullOptions = {}): Promise<UserPullResult> {
  const userDir = resolveUserDir(opts.userDir);
  await ensureRepo(userDir);
  const git = simpleGit(userDir);
  const before = await currentHead(git);
  try {
    await git.pull(undefined, undefined, ["--ff-only"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new StateError(`git pull failed in ${userDir}: ${msg}`, { cause: err });
  }
  const after = await currentHead(git);
  const changed = before !== after;
  let reloaded = false;
  if (changed && !opts.noReload) {
    try {
      await runReload({
        ...(opts.stateDir !== undefined && { stateDir: opts.stateDir }),
      });
      reloaded = true;
    } catch (err) {
      // Daemon may not be running — pull still succeeded; just don't reload.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`note: pulled changes but did not reload daemon — ${msg}\n`);
    }
  }
  return { userDir, before, after, changed, reloaded };
}

export interface UserStatusOptions {
  userDir?: string;
}

export interface UserStatusResult {
  userDir: string;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  remote: string | null;
}

export async function runUserStatus(opts: UserStatusOptions = {}): Promise<UserStatusResult> {
  const userDir = resolveUserDir(opts.userDir);
  await ensureRepo(userDir);
  const git = simpleGit(userDir);
  const status = await git.status();
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  return {
    userDir,
    branch: status.current,
    ahead: status.ahead,
    behind: status.behind,
    staged: status.staged.length,
    unstaged: status.modified.length + status.deleted.length,
    untracked: status.not_added.length,
    remote: origin?.refs.fetch ?? null,
  };
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const st = await stat(path.join(dir, ".git"));
    return st.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function ensureRepo(userDir: string): Promise<void> {
  if (!(await isGitRepo(userDir))) {
    throw new ConfigError(
      `${userDir} is not a git repo — run \`verona user init\` first (optionally with --remote).`,
    );
  }
}

async function ensureCommitIdentity(git: SimpleGit): Promise<void> {
  if (!(await hasGitConfig(git, "user.name"))) {
    await git.addConfig("user.name", "Verona");
  }
  if (!(await hasGitConfig(git, "user.email"))) {
    await git.addConfig("user.email", "verona@local");
  }
}

async function hasGitConfig(git: SimpleGit, key: string): Promise<boolean> {
  try {
    const value = await git.raw(["config", "--get", key]);
    return value.trim().length > 0;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function currentHead(git: SimpleGit): Promise<string | null> {
  try {
    const sha = await git.revparse(["HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}

export function describeUserStatus(s: UserStatusResult): string {
  const lines = [
    `user dir: ${s.userDir}`,
    `branch:   ${s.branch ?? "(detached / none)"}`,
    `remote:   ${s.remote ?? "(none configured)"}`,
    `tracking: ${s.ahead} ahead, ${s.behind} behind`,
    `staged:   ${s.staged}`,
    `unstaged: ${s.unstaged}`,
    `untracked:${s.untracked}`,
  ];
  return lines.join("\n");
}
