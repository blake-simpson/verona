import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMemory } from "../../src/core/memory-loader.js";
import { ConfigError } from "../../src/util/errors.js";

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "verona-mem-"));
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

async function seedAgent(opts: {
  soul?: string;
  index?: string;
  preferences?: string;
}): Promise<void> {
  await writeFile(path.join(agentDir, "SOUL.md"), opts.soul ?? "# Soul\nI am test.", "utf8");
  await mkdir(path.join(agentDir, "memory", "learned", "facts"), { recursive: true });
  await writeFile(
    path.join(agentDir, "memory", "INDEX.md"),
    opts.index ?? "# Index\n- foo → memory/learned/facts/foo.md",
    "utf8",
  );
  if (opts.preferences !== undefined) {
    await writeFile(
      path.join(agentDir, "memory", "learned", "facts", "preferences.md"),
      opts.preferences,
      "utf8",
    );
  }
}

describe("loadMemory", () => {
  it("assembles SOUL + framing + INDEX into a single system prompt when no preferences file exists", async () => {
    await seedAgent({});

    const result = await loadMemory({
      agentDir,
      agentName: "tester",
      taskId: "scan",
    });

    expect(result.parts.soul).toContain("I am test.");
    expect(result.parts.framing).toContain('agent "tester"');
    expect(result.parts.framing).toContain('task "scan"');
    expect(result.parts.framing).toContain("memory/INDEX.md");
    expect(result.parts.preferences).toBeNull();
    expect(result.parts.index).toContain("foo");
    expect(result.systemPrompt).toContain(result.parts.soul);
    expect(result.systemPrompt).toContain(result.parts.framing);
    expect(result.systemPrompt).toContain(result.parts.index);
  });

  it("eagerly loads preferences.md between framing and INDEX on a fresh session", async () => {
    await seedAgent({
      preferences: "# Preferences\n- No em-dashes anywhere.",
    });

    const result = await loadMemory({
      agentDir,
      agentName: "tester",
      taskId: "scan",
    });

    expect(result.parts.preferences).toContain("No em-dashes");

    const idxFraming = result.systemPrompt.indexOf(result.parts.framing);
    const idxPrefs = result.systemPrompt.indexOf(result.parts.preferences!);
    const idxIndex = result.systemPrompt.indexOf(result.parts.index);
    expect(idxFraming).toBeGreaterThanOrEqual(0);
    expect(idxPrefs).toBeGreaterThan(idxFraming);
    expect(idxIndex).toBeGreaterThan(idxPrefs);
  });

  it("skips preferences.md when isResume=true", async () => {
    await seedAgent({
      preferences: "# Preferences\n- No em-dashes anywhere.",
    });

    const result = await loadMemory({
      agentDir,
      agentName: "tester",
      taskId: "scan",
      isResume: true,
    });

    expect(result.parts.preferences).toBeNull();
    expect(result.systemPrompt).not.toContain("No em-dashes");
  });

  it("treats an empty preferences.md as absent", async () => {
    await seedAgent({ preferences: "   \n  \n" });

    const result = await loadMemory({
      agentDir,
      agentName: "tester",
      taskId: "scan",
    });

    expect(result.parts.preferences).toBeNull();
  });

  it("framing block mentions preferences.md as eagerly loaded", async () => {
    await seedAgent({});
    const result = await loadMemory({
      agentDir,
      agentName: "tester",
      taskId: "scan",
    });
    expect(result.parts.framing).toContain("preferences.md");
    expect(result.parts.framing).toContain("60 lines");
  });

  it("throws ConfigError if SOUL.md is missing", async () => {
    await mkdir(path.join(agentDir, "memory"), { recursive: true });
    await writeFile(path.join(agentDir, "memory", "INDEX.md"), "x", "utf8");

    await expect(
      loadMemory({ agentDir, agentName: "tester", taskId: "scan" }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError if memory/INDEX.md is missing", async () => {
    await writeFile(path.join(agentDir, "SOUL.md"), "x", "utf8");

    await expect(
      loadMemory({ agentDir, agentName: "tester", taskId: "scan" }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
