import { mkdir, mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSkill, stageSkills } from "../../src/core/skill-loader.js";
import { ConfigError } from "../../src/util/errors.js";

let rootDir: string;
let skillsDir: string;
let agentDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "verona-skills-"));
  skillsDir = path.join(rootDir, "skills");
  agentDir = path.join(rootDir, "agent");
  await mkdir(skillsDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
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
  it("creates <agentDir>/.claude/skills/<name> symlinks pointing at canonical skill dirs", async () => {
    const copyDir = await makeSkill("copywriting");
    const uxDir = await makeSkill("ux-designer");

    await stageSkills({
      skills: ["copywriting", "ux-designer"],
      skillsDir,
      agentDir,
    });

    const target = path.join(agentDir, ".claude", "skills");
    const st = await stat(target);
    expect(st.isDirectory()).toBe(true);

    expect(await readlink(path.join(target, "copywriting"))).toBe(copyDir);
    expect(await readlink(path.join(target, "ux-designer"))).toBe(uxDir);
  });

  it("is a no-op (no skills dir created) when none are declared and none were staged before", async () => {
    await stageSkills({ skills: [], skillsDir, agentDir });
    await expect(stat(path.join(agentDir, ".claude", "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prunes stale symlinks when a skill is removed from agent.toml between spawns", async () => {
    await makeSkill("copywriting");
    await makeSkill("ux-designer");
    await stageSkills({ skills: ["copywriting", "ux-designer"], skillsDir, agentDir });
    await stageSkills({ skills: ["copywriting"], skillsDir, agentDir });

    const target = path.join(agentDir, ".claude", "skills");
    await stat(path.join(target, "copywriting"));
    await expect(stat(path.join(target, "ux-designer"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("clears every staged skill when the agent's list is emptied", async () => {
    await makeSkill("copywriting");
    await stageSkills({ skills: ["copywriting"], skillsDir, agentDir });
    await stageSkills({ skills: [], skillsDir, agentDir });

    await expect(
      stat(path.join(agentDir, ".claude", "skills", "copywriting")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent — re-staging the same skills leaves the link intact", async () => {
    const copyDir = await makeSkill("copywriting");
    await stageSkills({ skills: ["copywriting"], skillsDir, agentDir });
    await stageSkills({ skills: ["copywriting"], skillsDir, agentDir });
    expect(await readlink(path.join(agentDir, ".claude", "skills", "copywriting"))).toBe(copyDir);
  });

  it("throws ConfigError when a declared skill does not exist on disk", async () => {
    await makeSkill("present");
    await expect(
      stageSkills({ skills: ["present", "absent"], skillsDir, agentDir }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
