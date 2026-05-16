import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AIAdapter, AdapterRequest, AdapterResponse } from "../../src/adapters/adapter.js";
import { dispatch } from "../../src/core/dispatcher.js";

const GUARD = path.resolve(fileURLToPath(import.meta.url), "../../../src/hooks/memory-guard.sh");

class StubAdapter implements AIAdapter {
  readonly id = "claude-cli" as const;
  lastRequest?: AdapterRequest;
  constructor(private readonly fixedResponse: AdapterResponse) {}
  async invoke(req: AdapterRequest): Promise<AdapterResponse> {
    this.lastRequest = req;
    return this.fixedResponse;
  }
}

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "verona-dispatch-"));
  await mkdir(path.join(agentDir, "memory"), { recursive: true });
  await mkdir(path.join(agentDir, "tasks"), { recursive: true });
  await writeFile(path.join(agentDir, "SOUL.md"), "I am the test soul.", "utf8");
  await writeFile(path.join(agentDir, "memory", "INDEX.md"), "Empty index.", "utf8");
  await writeFile(path.join(agentDir, "tasks", "scan.md"), "Run a scan and report.", "utf8");
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

describe("dispatch", () => {
  it("loads memory, invokes adapter, writes episodic log", async () => {
    const adapter = new StubAdapter({
      text: "scan complete",
      tokens: { input: 50, output: 10 },
      costUsd: null,
      subscriptionCovered: true,
      modelUsed: "claude-sonnet-4-6",
      toolCalls: 1,
      durationMs: 1234,
      sessionId: "ses-1",
    });

    const result = await dispatch({
      agentDir,
      agentName: "tester",
      taskId: "scan",
      promptPath: "./tasks/scan.md",
      effort: "medium",
      trigger: { kind: "manual" },
      adapter,
      guardScriptPath: GUARD,
    });

    expect(adapter.lastRequest).toBeDefined();
    expect(adapter.lastRequest?.systemPrompt).toContain("I am the test soul.");
    expect(adapter.lastRequest?.systemPrompt).toContain("Empty index.");
    expect(adapter.lastRequest?.userPrompt).toContain("Run a scan and report.");
    expect(adapter.lastRequest?.hookSettingsPath).toBeDefined();

    expect(result.response.text).toBe("scan complete");
    expect(result.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Episodic log written
    const episodicDir = path.join(agentDir, "memory", "learned", "episodic");
    const files = await readdir(episodicDir);
    expect(files).toHaveLength(1);
    const episodic = await readFile(path.join(episodicDir, files[0]!), "utf8");
    expect(episodic).toContain("scan complete");
    expect(episodic).toContain(result.runId);
    expect(episodic).toContain("subscription-covered");
  });

  it("composes user prompt from task + Slack-style userMessage when provided", async () => {
    const adapter = new StubAdapter({
      text: "ok",
      tokens: { input: 1, output: 1 },
      costUsd: null,
      subscriptionCovered: true,
      modelUsed: "claude-sonnet-4-6",
      toolCalls: 0,
      durationMs: 1,
    });

    await dispatch({
      agentDir,
      agentName: "tester",
      taskId: "scan",
      promptPath: "./tasks/scan.md",
      userMessage: "@tester dive deeper on project 2",
      effort: "medium",
      trigger: { kind: "message", detail: "U02ABC" },
      adapter,
      guardScriptPath: GUARD,
    });

    expect(adapter.lastRequest?.userPrompt).toContain("Run a scan and report.");
    expect(adapter.lastRequest?.userPrompt).toContain("dive deeper on project 2");
  });

  it("stages declared skills in the agent dir and sets cwd=agentDir for stable session keying", async () => {
    const adapter = new StubAdapter({
      text: "ok",
      tokens: { input: 1, output: 1 },
      costUsd: null,
      subscriptionCovered: true,
      modelUsed: "claude-sonnet-4-6",
      toolCalls: 0,
      durationMs: 1,
    });

    const skillsDir = await mkdtemp(path.join(tmpdir(), "verona-skillsroot-"));
    const skillSrc = path.join(skillsDir, "copywriting");
    await mkdir(skillSrc, { recursive: true });
    await writeFile(path.join(skillSrc, "SKILL.md"), "# copywriting", "utf8");

    try {
      await dispatch({
        agentDir,
        agentName: "tester",
        taskId: "scan",
        promptPath: "./tasks/scan.md",
        effort: "medium",
        trigger: { kind: "manual" },
        adapter,
        guardScriptPath: GUARD,
        skills: ["copywriting"],
        skillsDir,
      });

      const req = adapter.lastRequest!;
      // CWD must be the stable per-agent dir, NOT runDir — `claude -p` keys
      // session history on CWD, and per-spawn CWD breaks --resume for
      // anchored Slack threads.
      expect(req.cwd).toBe(agentDir);
      expect(req.runDir).toBeUndefined();

      const staged = path.join(agentDir, ".claude", "skills", "copywriting");
      const st = await stat(staged);
      expect(st.isDirectory()).toBe(true);
      expect(await readlink(staged)).toBe(skillSrc);

      // Framing block lists the declared skills so the model knows they exist.
      expect(req.systemPrompt).toContain("Available skills");
      expect(req.systemPrompt).toContain("copywriting");

      // The Skill tool must be allowlisted, else `claude -p` auto-denies the
      // call non-interactively and the agent proceeds without the skill.
      expect(req.allowedTools).toContain("Skill");
    } finally {
      await rm(skillsDir, { recursive: true, force: true });
    }
  });

  it("does not allowlist Skill when no skills are declared", async () => {
    const adapter = new StubAdapter({
      text: "ok",
      tokens: { input: 1, output: 1 },
      costUsd: null,
      subscriptionCovered: true,
      modelUsed: "claude-sonnet-4-6",
      toolCalls: 0,
      durationMs: 1,
    });

    await dispatch({
      agentDir,
      agentName: "tester",
      taskId: "scan",
      promptPath: "./tasks/scan.md",
      effort: "medium",
      trigger: { kind: "manual" },
      adapter,
      guardScriptPath: GUARD,
      allowedTools: ["Read", "Write"],
    });

    const req = adapter.lastRequest!;
    expect(req.allowedTools).toEqual(["Read", "Write"]);
    expect(req.allowedTools).not.toContain("Skill");
  });

  it("propagates sessionId for resume", async () => {
    const adapter = new StubAdapter({
      text: "ok",
      tokens: { input: 1, output: 1 },
      costUsd: null,
      subscriptionCovered: true,
      modelUsed: "claude-sonnet-4-6",
      toolCalls: 0,
      durationMs: 1,
    });

    await dispatch({
      agentDir,
      agentName: "tester",
      taskId: "scan",
      promptPath: "./tasks/scan.md",
      effort: "medium",
      sessionId: "prev-ses-42",
      trigger: { kind: "manual" },
      adapter,
      guardScriptPath: GUARD,
    });

    expect(adapter.lastRequest?.sessionId).toBe("prev-ses-42");
  });
});
