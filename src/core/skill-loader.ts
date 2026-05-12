/**
 * Skill loader — stages declared skills into the agent's state dir so
 * `claude -p` discovers them via its native project-skill mechanism.
 *
 *   ~/.verona/user/skills/<name>/SKILL.md         (canonical, global pool)
 *      ↓ symlink per declared name
 *   <agentDir>/.claude/skills/<name>              (stable per-agent location)
 *
 * The adapter passes `<agentDir>` as the subprocess CWD so Claude Code picks
 * up `<agentDir>/.claude/skills/*` as project-local skills. The CWD must be
 * **stable per agent** — `claude -p` keys session history on CWD and would
 * otherwise refuse `--resume <id>` when an inbound Slack reply lands.
 *
 * Skills are read-only context: no per-agent copies, no edits at runtime.
 * Staging is idempotent and clears stale links so removing a skill from
 * agent.toml takes effect on the next spawn.
 */

import { mkdir, readdir, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../util/errors.js";

export interface StageSkillsInput {
  skills: readonly string[];
  /** Canonical skills root, e.g. `~/.verona/user/skills/`. */
  skillsDir: string;
  /** Agent's state dir, e.g. `<state>/agents/<name>/`. The function creates `.claude/skills/` inside it and used as the subprocess CWD. */
  agentDir: string;
}

/**
 * Verify a skill exists at `<skillsDir>/<name>/SKILL.md`. Returns the canonical
 * dir path. Throws ConfigError if missing — we'd rather fail loudly at spawn
 * time than silently drop the skill and have the agent miss it.
 */
export async function resolveSkill(
  name: string,
  opts: { skillsDir: string },
): Promise<{ name: string; dir: string }> {
  const dir = path.join(opts.skillsDir, name);
  const skillFile = path.join(dir, "SKILL.md");
  try {
    const st = await stat(skillFile);
    if (!st.isFile()) {
      throw new ConfigError(`skill "${name}": ${skillFile} exists but is not a regular file`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ConfigError(
        `skill "${name}" not found at ${skillFile}. Add it under ${opts.skillsDir} or remove it from agent.skills.`,
      );
    }
    throw err;
  }
  return { name, dir };
}

/**
 * Symlink each declared skill into `<agentDir>/.claude/skills/<name>`.
 *
 * Idempotent and self-pruning: before writing, every existing symlink in the
 * target dir is removed. That way a skill dropped from agent.toml disappears
 * from the worker's view on the next spawn without leaving a stale link.
 */
export async function stageSkills(input: StageSkillsInput): Promise<void> {
  const targetDir = path.join(input.agentDir, ".claude", "skills");

  if (input.skills.length === 0) {
    await pruneSymlinks(targetDir);
    return;
  }

  await mkdir(targetDir, { recursive: true });
  await pruneSymlinks(targetDir);

  for (const name of input.skills) {
    const resolved = await resolveSkill(name, { skillsDir: input.skillsDir });
    const linkPath = path.join(targetDir, name);
    await symlink(resolved.dir, linkPath, "dir");
  }
}

async function pruneSymlinks(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      await unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
