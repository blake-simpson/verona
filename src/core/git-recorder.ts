/**
 * GitRecorder — auto-commits state-dir changes (memory writes, agent registrations).
 *
 * The state dir is its own git repo. Every memory mutation lands as a commit
 * so users can `git log` to see what happened, `git diff` to see what changed,
 * and `git revert` to undo a bad agent run. Local-only by default; the user
 * can add a remote themselves if they want backup.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { StateError } from "../util/errors.js";

const DEFAULT_GITIGNORE = [
  "# Verona state-tree gitignore",
  "# Most things should be committed (memory is the audit trail). Exceptions:",
  "secrets/",
  "*.log",
  ".verona-tmp/",
  "logs/",
  "",
].join("\n");

export interface GitRecorderInit {
  stateDir: string;
}

export class GitRecorder {
  private readonly stateDir: string;
  private readonly git: SimpleGit;

  constructor(init: GitRecorderInit) {
    this.stateDir = init.stateDir;
    this.git = simpleGit(init.stateDir);
  }

  async ensureRepo(): Promise<void> {
    const gitDir = path.join(this.stateDir, ".git");
    let exists = false;
    try {
      const st = await stat(gitDir);
      exists = st.isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!exists) {
      await mkdir(this.stateDir, { recursive: true });
      await this.git.init();
      await this.writeDefaultGitignore();
      await this.git.add([".gitignore"]);
      await this.commit({
        message: "verona: initialize state tree",
        paths: [".gitignore"],
        skipIfClean: true,
      });
    }
  }

  private async writeDefaultGitignore(): Promise<void> {
    const file = path.join(this.stateDir, ".gitignore");
    try {
      await stat(file);
      // already exists; leave it alone
    } catch {
      await writeFile(file, DEFAULT_GITIGNORE, "utf8");
    }
  }

  /**
   * Stage given paths and commit. Returns the commit SHA, or null if
   * nothing-to-commit and `skipIfClean` is true.
   */
  async commit(opts: { message: string; paths: readonly string[]; skipIfClean?: boolean }): Promise<
    string | null
  > {
    if (opts.paths.length > 0) {
      await this.git.add(opts.paths.slice());
    }
    const status = await this.git.status();
    if (status.isClean()) {
      if (opts.skipIfClean) return null;
      throw new StateError("nothing to commit but skipIfClean was not set");
    }
    const result = await this.git.commit(opts.message);
    return result.commit;
  }

  /**
   * Records a memory mutation from a task run. Stages the agent's dir and
   * commits with a structured message.
   */
  async recordMemoryUpdate(opts: {
    agentName: string;
    taskId: string;
    runId: string;
  }): Promise<string | null> {
    const agentRel = path.join("agents", opts.agentName);
    return this.commit({
      message: `agent:${opts.agentName} task:${opts.taskId} run:${opts.runId}`,
      paths: [agentRel],
      skipIfClean: true,
    });
  }
}
