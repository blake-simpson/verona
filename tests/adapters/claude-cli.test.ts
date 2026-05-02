import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterRequest } from "../../src/adapters/adapter.js";
import { ClaudeCliAdapter } from "../../src/adapters/claude-cli.js";

const FAKE_CLAUDE_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/fake-claude.sh",
);

let workDir: string;
let logPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "verona-claude-cli-"));
  logPath = path.join(workDir, "fake-claude.log");
  // Point the adapter at our stub.
  process.env.VERONA_CLAUDE_BIN = FAKE_CLAUDE_PATH;
  process.env.VERONA_FAKE_CLAUDE_LOG = logPath;
});

afterEach(async () => {
  delete process.env.VERONA_CLAUDE_BIN;
  delete process.env.VERONA_FAKE_CLAUDE_LOG;
  delete process.env.VERONA_FAKE_CLAUDE_EXIT;
  await rm(workDir, { recursive: true, force: true });
});

function buildRequest(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    agentName: "test-agent",
    taskId: "test-task",
    systemPrompt: "you are test",
    userPrompt: "do the thing",
    effort: "medium",
    workingDir: workDir,
    cancel: new AbortController().signal,
    ...overrides,
  };
}

describe("ClaudeCliAdapter", () => {
  it("scrubs ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from subprocess env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-be-passed";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-not-be-passed-either";
    try {
      const adapter = new ClaudeCliAdapter();
      await adapter.invoke(buildRequest());
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("ANTHROPIC_API_KEY=__UNSET__");
    expect(log).toContain("ANTHROPIC_AUTH_TOKEN=__UNSET__");
  });

  it("sets VERONA_AGENT_DIR for memory-guard.sh", async () => {
    const adapter = new ClaudeCliAdapter();
    await adapter.invoke(buildRequest());
    const log = await readFile(logPath, "utf8");
    expect(log).toContain(`VERONA_AGENT_DIR=${workDir}`);
  });

  it("does NOT pass --bare flag (would force API-key auth)", async () => {
    const adapter = new ClaudeCliAdapter();
    await adapter.invoke(buildRequest());
    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain("--bare");
  });

  it("passes the expected flags: -p, --output-format stream-json, --add-dir, --model", async () => {
    const adapter = new ClaudeCliAdapter();
    await adapter.invoke(buildRequest());
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("-p");
    expect(log).toContain("--output-format");
    expect(log).toContain("stream-json");
    expect(log).toContain("--add-dir");
    expect(log).toContain(workDir);
    expect(log).toContain("--model");
  });

  it("uses --resume when sessionId is provided, --session-id otherwise", async () => {
    const adapter = new ClaudeCliAdapter();
    await adapter.invoke(buildRequest());
    let log = await readFile(logPath, "utf8");
    expect(log).toContain("--session-id");
    expect(log).not.toContain("--resume");

    // Reset log
    await rm(logPath, { force: true });
    await adapter.invoke(buildRequest({ sessionId: "prev-session-123" }));
    log = await readFile(logPath, "utf8");
    expect(log).toContain("--resume");
    expect(log).toContain("prev-session-123");
  });

  it("returns subscriptionCovered=true and costUsd=null", async () => {
    const adapter = new ClaudeCliAdapter();
    const response = await adapter.invoke(buildRequest());
    expect(response.subscriptionCovered).toBe(true);
    expect(response.costUsd).toBe(null);
    expect(response.text).toBe("hello from fake claude");
    expect(response.tokens.input).toBe(100);
    expect(response.tokens.output).toBe(20);
    expect(response.sessionId).toBe("fake-session-out");
  });

  it("throws AdapterError when claude exits non-zero", async () => {
    process.env.VERONA_FAKE_CLAUDE_EXIT = "1";
    const adapter = new ClaudeCliAdapter();
    await expect(adapter.invoke(buildRequest())).rejects.toThrow(/claude exited with code 1/);
  });

  it("resolves effort to a model name (medium → sonnet)", async () => {
    const adapter = new ClaudeCliAdapter();
    const response = await adapter.invoke(buildRequest({ effort: "medium" }));
    expect(response.modelUsed).toBe("claude-sonnet-4-6");
  });

  it("resolves effort low → haiku", async () => {
    const adapter = new ClaudeCliAdapter();
    const response = await adapter.invoke(buildRequest({ effort: "low" }));
    expect(response.modelUsed).toContain("haiku");
  });
});
