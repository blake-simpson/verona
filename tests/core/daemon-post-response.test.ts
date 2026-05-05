/**
 * runTask + post_response flow:
 *   cron / manual run with `post_response = true` posts the agent's final
 *   assistant message to the agent's configured Slack channel.
 *
 * Also asserts the negative cases (no slack config, post_response unset,
 * connector not running) are warnings, not failures — the task still runs.
 */

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentsAdd } from "../../src/cli/commands/agents.js";
import { runInit } from "../../src/cli/commands/init.js";
import { setSecret } from "../../src/secrets/store.js";
import { statePaths } from "../../src/state/paths.js";

const FAKE_CLAUDE = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-claude.sh");
const FIXTURE_HELLO_BASE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);

let stateDir: string;
let agentSrcDir: string;

async function buildFixture(opts: {
  withSlackConfig: boolean;
  postResponse: boolean;
}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "verona-fixture-postresp-"));
  await cp(FIXTURE_HELLO_BASE, dir, { recursive: true });
  const connectorsBlock = opts.withSlackConfig
    ? '[connectors]\nslack = { channel = "C-DIGEST" }\n'
    : "";
  const postFlag = opts.postResponse ? "post_response = true\n" : "";
  const toml = `
[agent]
name = "hello-world"
description = "post_response fixture"
adapter = "claude-cli"
default_effort = "low"

[soul]
file = "./SOUL.md"

[memory]
index = "./memory/INDEX.md"
self_learning = true

${connectorsBlock}
[[tasks]]
id = "greet"
prompt = "./tasks/greet.md"
schedule = "0 9 * * *"
effort = "low"
${postFlag}`.trimStart();
  await writeFile(path.join(dir, "agent.toml"), toml, "utf8");
  return dir;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-daemon-postresp-"));
  await runInit({ stateDir });
  process.env.VERONA_CLAUDE_BIN = FAKE_CLAUDE;
});

afterEach(async () => {
  delete process.env.VERONA_CLAUDE_BIN;
  await rm(stateDir, { recursive: true, force: true });
  if (agentSrcDir) await rm(agentSrcDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupDaemonWithSlack(opts: {
  withSlackConfig: boolean;
  postResponse: boolean;
  slackTokens: boolean;
}): Promise<{
  daemon: import("../../src/core/daemon.js").Daemon;
  postedMessages: { channel: string; text: string; thread_ts?: string }[];
}> {
  agentSrcDir = await buildFixture({
    withSlackConfig: opts.withSlackConfig,
    postResponse: opts.postResponse,
  });
  await runAgentsAdd({ sourceDir: agentSrcDir, stateDir });

  if (opts.slackTokens) {
    const paths = statePaths(stateDir);
    await setSecret(paths.secrets, { kind: "connector", id: "slack" }, "bot_token", "xoxb-test");
    await setSecret(paths.secrets, { kind: "connector", id: "slack" }, "app_token", "xapp-test");
  }

  const slackModule = await import("../../src/connectors/slack/index.js");
  const realSlackConnector = slackModule.SlackConnector;
  const postedMessages: { channel: string; text: string; thread_ts?: string }[] = [];

  class TestableSlack extends realSlackConnector {
    constructor(init: ConstructorParameters<typeof realSlackConnector>[0]) {
      super({
        ...init,
        socketFactory: () => ({
          on() {},
          async start() {},
          async disconnect() {},
        }),
        webFactory: () => ({
          chat: {
            async postMessage(args: { channel: string; text: string; thread_ts?: string }) {
              postedMessages.push(args);
              return { ok: true };
            },
          },
        }),
      });
    }
  }
  vi.doMock("../../src/connectors/slack/index.js", () => ({
    ...slackModule,
    SlackConnector: TestableSlack,
  }));
  vi.resetModules();
  const { Daemon } = await import("../../src/core/daemon.js");
  const daemon = new Daemon({ stateDir });
  await daemon.bootstrap();
  return { daemon, postedMessages };
}

describe("Daemon runTask + post_response", () => {
  it("posts the agent's final message to the configured Slack channel", async () => {
    const { daemon, postedMessages } = await setupDaemonWithSlack({
      withSlackConfig: true,
      postResponse: true,
      slackTokens: true,
    });
    await daemon.runTask({
      agentName: "hello-world",
      taskId: "greet",
      trigger: { kind: "manual" },
    });
    await daemon.stop();

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]?.channel).toBe("C-DIGEST");
    expect(postedMessages[0]?.text).toBeTypeOf("string");
    expect(postedMessages[0]?.text.length).toBeGreaterThan(0);
    expect(postedMessages[0]?.thread_ts).toBeUndefined();
  });

  it("does not post when post_response is unset (default off for cron/manual)", async () => {
    const { daemon, postedMessages } = await setupDaemonWithSlack({
      withSlackConfig: true,
      postResponse: false,
      slackTokens: true,
    });
    await daemon.runTask({
      agentName: "hello-world",
      taskId: "greet",
      trigger: { kind: "manual" },
    });
    await daemon.stop();
    expect(postedMessages).toHaveLength(0);
  });

  it("warns and skips when post_response is set but no slack channel is configured", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
    const { daemon, postedMessages } = await setupDaemonWithSlack({
      withSlackConfig: false,
      postResponse: true,
      slackTokens: true,
    });
    await daemon.runTask({
      agentName: "hello-world",
      taskId: "greet",
      trigger: { kind: "manual" },
    });
    await daemon.stop();
    stderrSpy.mockRestore();

    expect(postedMessages).toHaveLength(0);
    expect(stderrChunks.join("")).toMatch(/no \[connectors\] slack\.channel configured/);
  });
});
