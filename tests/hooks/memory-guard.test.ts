import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD = path.resolve(fileURLToPath(import.meta.url), "../../../src/hooks/memory-guard.sh");

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "verona-guard-"));
  await mkdir(path.join(agentDir, "memory", "core"), { recursive: true });
  await mkdir(path.join(agentDir, "memory", "learned", "facts"), { recursive: true });
  await mkdir(path.join(agentDir, "memory", "learned", "episodic"), { recursive: true });
  await mkdir(path.join(agentDir, "memory", "learned", "working"), { recursive: true });
  await mkdir(path.join(agentDir, "tasks"), { recursive: true });
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function runGuard(filePath: string): { stdout: string; status: number } {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  const result = spawnSync(GUARD, [], {
    input,
    env: { ...process.env, VERONA_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status ?? -1 };
}

function runGuardWrite(filePath: string, content: string): { stdout: string; status: number } {
  const input = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  });
  const result = spawnSync(GUARD, [], {
    input,
    env: { ...process.env, VERONA_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status ?? -1 };
}

function runGuardEdit(
  filePath: string,
  oldString: string,
  newString: string,
): { stdout: string; status: number } {
  const input = JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
  });
  const result = spawnSync(GUARD, [], {
    input,
    env: { ...process.env, VERONA_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status ?? -1 };
}

function isDeny(stdout: string): boolean {
  if (!stdout.trim()) return false;
  const json = JSON.parse(stdout);
  return json?.hookSpecificOutput?.permissionDecision === "deny";
}

describe("memory-guard.sh", () => {
  it("ALLOWS writes to memory/INDEX.md", () => {
    const { stdout, status } = runGuard(path.join(agentDir, "memory", "INDEX.md"));
    expect(status).toBe(0);
    expect(isDeny(stdout)).toBe(false);
  });

  it("ALLOWS writes to memory/learned/facts/something.md", () => {
    const { stdout, status } = runGuard(
      path.join(agentDir, "memory", "learned", "facts", "alpha.md"),
    );
    expect(status).toBe(0);
    expect(isDeny(stdout)).toBe(false);
  });

  it("ALLOWS writes to memory/learned/episodic/run.md", () => {
    const { stdout, status } = runGuard(
      path.join(agentDir, "memory", "learned", "episodic", "run-123.md"),
    );
    expect(status).toBe(0);
    expect(isDeny(stdout)).toBe(false);
  });

  it("DENIES writes to SOUL.md", () => {
    const { stdout, status } = runGuard(path.join(agentDir, "SOUL.md"));
    expect(status).toBe(0);
    expect(isDeny(stdout)).toBe(true);
  });

  it("DENIES writes to agent.toml", () => {
    const { stdout } = runGuard(path.join(agentDir, "agent.toml"));
    expect(isDeny(stdout)).toBe(true);
  });

  it("DENIES writes to memory/core/identity.md", () => {
    const { stdout } = runGuard(path.join(agentDir, "memory", "core", "identity.md"));
    expect(isDeny(stdout)).toBe(true);
  });

  it("DENIES writes to tasks/scan.md", () => {
    const { stdout } = runGuard(path.join(agentDir, "tasks", "scan.md"));
    expect(isDeny(stdout)).toBe(true);
  });

  it("DENIES writes to a path outside the agent dir entirely", () => {
    const { stdout } = runGuard("/etc/passwd");
    expect(isDeny(stdout)).toBe(true);
  });

  it("DENIES when VERONA_AGENT_DIR is unset", () => {
    const result = spawnSync(
      GUARD,
      [],
      // intentionally omitting VERONA_AGENT_DIR
      { input: JSON.stringify({ tool_input: { file_path: "/anything" } }), encoding: "utf8" },
    );
    expect(isDeny(result.stdout)).toBe(true);
  });

  describe("preferences.md 60-line cap", () => {
    const prefsRel = path.join("memory", "learned", "facts", "preferences.md");

    it("ALLOWS a Write of exactly 60 lines", () => {
      const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
      const { stdout, status } = runGuardWrite(path.join(agentDir, prefsRel), content);
      expect(status).toBe(0);
      expect(isDeny(stdout)).toBe(false);
    });

    it("DENIES a Write of 61 lines", () => {
      const content = Array.from({ length: 61 }, (_, i) => `line ${i + 1}`).join("\n");
      const { stdout } = runGuardWrite(path.join(agentDir, prefsRel), content);
      expect(isDeny(stdout)).toBe(true);
      const json = JSON.parse(stdout);
      expect(json.hookSpecificOutput.permissionDecisionReason).toContain("60 lines");
    });

    it("ALLOWS an Edit that keeps file under 60 lines", async () => {
      const existing = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
      await writeFile(path.join(agentDir, prefsRel), existing, "utf8");

      const { stdout } = runGuardEdit(
        path.join(agentDir, prefsRel),
        "line 5",
        "line 5 (edited)",
      );
      expect(isDeny(stdout)).toBe(false);
    });

    it("DENIES an Edit whose net effect pushes the file past 60 lines", async () => {
      const existing = Array.from({ length: 55 }, (_, i) => `line ${i + 1}`).join("\n");
      await writeFile(path.join(agentDir, prefsRel), existing, "utf8");

      const newBlock = ["line 5", "added 1", "added 2", "added 3", "added 4", "added 5", "added 6"].join("\n");
      const { stdout } = runGuardEdit(path.join(agentDir, prefsRel), "line 5", newBlock);
      expect(isDeny(stdout)).toBe(true);
    });

    it("does NOT apply the cap to other learned/facts files", () => {
      const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
      const { stdout } = runGuardWrite(
        path.join(agentDir, "memory", "learned", "facts", "leads.md"),
        content,
      );
      expect(isDeny(stdout)).toBe(false);
    });
  });
});
