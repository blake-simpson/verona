/**
 * End-to-end inbound flow test:
 *   Slack app_mention (mocked) → daemon.handleInbound → dispatcher → fake claude
 *     → daemon posts response back via mocked Slack web client
 *     → audit log captures connector_receive + adapter_invocation + connector_send
 *     → all three records share the same runId
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function buildSlackEnabledFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "verona-fixture-slack-"));
  // Copy hello-world fixture, then patch agent.toml to declare a Slack
  // channel. Notably: NO on_message task — replies should still flow via
  // session resume / synthetic "reply" dispatch.
  const cp = (await import("node:fs/promises")).cp;
  await cp(FIXTURE_HELLO_BASE, dir, { recursive: true });
  const slackToml = `
[agent]
name = "hello-world"
description = "Slack-enabled fixture for inbound test"
adapter = "claude-cli"
default_effort = "low"

[soul]
file = "./SOUL.md"

[memory]
index = "./memory/INDEX.md"
self_learning = true

[connectors]
slack = { channel = "C-FEED" }

[[tasks]]
id = "greet"
prompt = "./tasks/greet.md"
schedule = "0 9 * * *"
effort = "low"
`;
  await writeFile(path.join(dir, "agent.toml"), `${slackToml.trim()}\n`, "utf8");
  return dir;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-daemon-inbound-"));
  agentSrcDir = await buildSlackEnabledFixture();
  await runInit({ stateDir });
  await runAgentsAdd({ sourceDir: agentSrcDir, stateDir });

  // Stash slack tokens in the secrets store so daemon will pick them up.
  const paths = statePaths(stateDir);
  await setSecret(paths.secrets, { kind: "connector", id: "slack" }, "bot_token", "xoxb-test");
  await setSecret(paths.secrets, { kind: "connector", id: "slack" }, "app_token", "xapp-test");

  process.env.VERONA_CLAUDE_BIN = FAKE_CLAUDE;
});

afterEach(async () => {
  delete process.env.VERONA_CLAUDE_BIN;
  await rm(stateDir, { recursive: true, force: true });
  await rm(agentSrcDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Daemon inbound flow (Slack mocked)", () => {
  it("connector_receive → adapter_invocation → connector_send share the same runId", async () => {
    // We mock the Slack module so SlackConnector uses our injected factories.
    // Daemon constructs SlackConnector directly via `new SlackConnector(...)`.
    // We import the daemon AFTER mocking so it picks up the mock.
    const slackModule = await import("../../src/connectors/slack/index.js");
    const realSlackConnector = slackModule.SlackConnector;

    const postedMessages: { channel: string; text: string; thread_ts?: string }[] = [];
    const handlers = new Map<string, (args: unknown) => Promise<void> | void>();

    // monkeypatch SlackConnector by subclassing — we override the protected start()
    // with our injected factories. This avoids a vitest mock dance.
    class TestableSlack extends realSlackConnector {
      constructor(init: ConstructorParameters<typeof realSlackConnector>[0]) {
        super({
          ...init,
          socketFactory: () => ({
            on(event, h) {
              handlers.set(event, h as never);
            },
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
    // Replace the module export so daemon picks up our subclass.
    vi.doMock("../../src/connectors/slack/index.js", () => ({
      ...slackModule,
      SlackConnector: TestableSlack,
    }));
    // Reset module cache so daemon re-imports the mocked SlackConnector.
    vi.resetModules();
    const { Daemon } = await import("../../src/core/daemon.js");

    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();

    // Simulate Slack delivering an app_mention.
    const appMentionHandler = handlers.get("app_mention");
    expect(appMentionHandler).toBeDefined();
    let acked = false;
    await appMentionHandler!({
      event: {
        type: "app_mention",
        text: "<@U_BOT> hi there",
        user: "U_USER",
        channel: "C-FEED",
        ts: "1714632859.000100",
      },
      ack: async () => {
        acked = true;
      },
    });

    expect(acked).toBe(true);
    // The reply was posted back to Slack
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]?.channel).toBe("C-FEED");
    expect(postedMessages[0]?.thread_ts).toBe("1714632859.000100");

    // Audit records share the same runId
    const { runInvocations } = await import("../../src/cli/commands/invocations.js");
    const json = await runInvocations({ stateDir, json: true });
    const records = json
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    const types = records.map((r) => r.type).sort();
    expect(types).toEqual(["adapter_invocation", "connector_receive", "connector_send"]);

    const runIds = new Set(records.map((r) => r.runId));
    expect(runIds.size).toBe(1);

    // No on_message task was configured, so the synthetic taskId is "reply".
    const adapterRec = records.find((r) => r.type === "adapter_invocation");
    expect(adapterRec.task).toBe("reply");
    expect(adapterRec.agent).toBe("hello-world");

    await daemon.stop();
  });
});
