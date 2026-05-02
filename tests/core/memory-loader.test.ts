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

describe("loadMemory", () => {
  it("assembles SOUL + framing + INDEX into a single system prompt", async () => {
    await writeFile(path.join(agentDir, "SOUL.md"), "# Soul\nI am test.", "utf8");
    await mkdir(path.join(agentDir, "memory"), { recursive: true });
    await writeFile(
      path.join(agentDir, "memory", "INDEX.md"),
      "# Index\n- foo → memory/learned/facts/foo.md",
      "utf8",
    );

    const result = await loadMemory({
      agentDir,
      agentName: "tester",
      taskId: "scan",
    });

    expect(result.parts.soul).toContain("I am test.");
    expect(result.parts.framing).toContain('agent "tester"');
    expect(result.parts.framing).toContain('task "scan"');
    expect(result.parts.framing).toContain("memory/INDEX.md");
    expect(result.parts.index).toContain("foo");
    expect(result.systemPrompt).toContain(result.parts.soul);
    expect(result.systemPrompt).toContain(result.parts.framing);
    expect(result.systemPrompt).toContain(result.parts.index);
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
