/**
 * Skill loader — stages declared skills into a per-run dir so `claude -p`
 * discovers them via its native project-skill mechanism.
 *
 *   ~/.verona/user/skills/<name>/SKILL.md       (canonical, global pool)
 *      ↓ symlink per declared name
 *   <runDir>/.claude/skills/<name>              (per-spawn, lifetime = the run)
 *
 * The adapter passes `<runDir>` as the subprocess CWD so Claude Code picks up
 * `<runDir>/.claude/skills/*` as project-local skills (descriptions surface
 * in the worker's available-skills list; the agent invokes via the Skill
 * tool when relevant).
 *
 * Skills are read-only context: no per-agent copies, no edits at runtime.
 */

import { mkdir, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../util/errors.js";

export interface StageSkillsInput {
  skills: readonly string[];
  /** Canonical skills root, e.g. `~/.verona/user/skills/`. */
  skillsDir: string;
  /** Per-run dir, e.g. `<state>/runs/<runId>/`. The function creates `.claude/skills/` inside it. */
  runDir: string;
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
 * Symlink each declared skill into `<runDir>/.claude/skills/<name>`.
 *
 * Idempotent: if a symlink already exists at the target it's replaced. This
 * lets the dispatcher call stageSkills before the spawn without worrying
 * about whether runDir was reused (it isn't today, but the invariant is
 * cheap to maintain).
 */
export async function stageSkills(input: StageSkillsInput): Promise<void> {
  if (input.skills.length === 0) return;

  const targetDir = path.join(input.runDir, ".claude", "skills");
  await mkdir(targetDir, { recursive: true });

  for (const name of input.skills) {
    const resolved = await resolveSkill(name, { skillsDir: input.skillsDir });
    const linkPath = path.join(targetDir, name);
    try {
      await unlink(linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await symlink(resolved.dir, linkPath, "dir");
  }
}
