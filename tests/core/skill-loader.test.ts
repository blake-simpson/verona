import { mkdir, mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSkill, stageSkills } from "../../src/core/skill-loader.js";
import { ConfigError } from "../../src/util/errors.js";

let rootDir: string;
let skillsDir: string;
let runDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "verona-skills-"));
  skillsDir = path.join(rootDir, "skills");
  runDir = path.join(rootDir, "run");
  await mkdir(skillsDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function makeSkill(name: string, body = "# skill body"): Promise<string> {
  const dir = path.join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

describe("resolveSkill", () => {
  it("returns the canonical dir when SKILL.md exists", async () => {
    const expected = await makeSkill("copywriting");
    const result = await resolveSkill("copywriting", { skillsDir });
    expect(result).toEqual({ name: "copywriting", dir: expected });
  });

  it("throws ConfigError with a pointing message when the skill is missing", async () => {
    await expect(resolveSkill("nope", { skillsDir })).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError when SKILL.md is a directory rather than a file", async () => {
    const dir = path.join(skillsDir, "wonky");
    await mkdir(path.join(dir, "SKILL.md"), { recursive: true });
    await expect(resolveSkill("wonky", { skillsDir })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("stageSkills", () => {
  it("creates <runDir>/.claude/skills/<name> symlinks pointing at canonical skill dirs", async () => {
    const copyDir = await makeSkill("copywriting");
    const uxDir = await makeSkill("ux-designer");

    await stageSkills({
      skills: ["copywriting", "ux-designer"],
      skillsDir,
      runDir,
    });

    const target = path.join(runDir, ".claude", "skills");
    const st = await stat(target);
    expect(st.isDirectory()).toBe(true);

    expect(await readlink(path.join(target, "copywriting"))).toBe(copyDir);
    expect(await readlink(path.join(target, "ux-designer"))).toBe(uxDir);
  });

  it("is a no-op when skills is empty", async () => {
    await stageSkills({ skills: [], skillsDir, runDir });
    // .claude/skills should NOT exist when no skills declared.
    await expect(stat(path.join(runDir, ".claude", "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("is idempotent — re-staging the same skills replaces stale links cleanly", async () => {
    const copyDir = await makeSkill("copywriting");
    await stageSkills({ skills: ["copywriting"], skillsDir, runDir });
    await stageSkills({ skills: ["copywriting"], skillsDir, runDir });
    expect(await readlink(path.join(runDir, ".claude", "skills", "copywriting"))).toBe(copyDir);
  });

  it("throws ConfigError when a declared skill does not exist on disk", async () => {
    await makeSkill("present");
    await expect(
      stageSkills({ skills: ["present", "absent"], skillsDir, runDir }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
