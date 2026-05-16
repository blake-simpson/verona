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

  it("flags AdapterError.sessionNotFound when claude reports a missing session", async () => {
    process.env.VERONA_FAKE_CLAUDE_EXIT = "1";
    process.env.VERONA_FAKE_CLAUDE_STDERR =
      "No conversation found with session ID: f0797f3a-7cc8-41bc-ab56-0c46a2f6b893";
    const adapter = new ClaudeCliAdapter();
    try {
      await adapter.invoke(buildRequest({ sessionId: "f0797f3a-7cc8-41bc-ab56-0c46a2f6b893" }));
      throw new Error("expected throw");
    } catch (err) {
      const { AdapterError } = await import("../../src/util/errors.js");
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as InstanceType<typeof AdapterError>).sessionNotFound).toBe(true);
    } finally {
      delete process.env.VERONA_FAKE_CLAUDE_STDERR;
    }
  });

  it("surfaces the stdout result event when claude exits non-zero with empty stderr", async () => {
    process.env.VERONA_FAKE_CLAUDE_EXIT = "1";
    process.env.VERONA_FAKE_CLAUDE_STDOUT_JSON = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "image exceeds 8000x8000 pixel limit",
    });
    const adapter = new ClaudeCliAdapter();
    try {
      await expect(adapter.invoke(buildRequest())).rejects.toThrow(
        /error_during_execution[\s\S]*image exceeds 8000x8000 pixel limit/,
      );
    } finally {
      delete process.env.VERONA_FAKE_CLAUDE_STDOUT_JSON;
    }
  });

  it("leaves AdapterError.sessionNotFound false for generic adapter failures", async () => {
    process.env.VERONA_FAKE_CLAUDE_EXIT = "1";
    const adapter = new ClaudeCliAdapter();
    try {
      await adapter.invoke(buildRequest());
      throw new Error("expected throw");
    } catch (err) {
      const { AdapterError } = await import("../../src/util/errors.js");
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as InstanceType<typeof AdapterError>).sessionNotFound).toBe(false);
    }
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
