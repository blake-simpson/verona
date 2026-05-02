import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
});
