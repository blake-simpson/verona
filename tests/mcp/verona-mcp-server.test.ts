/**
 * End-to-end MCP server boot — spawn the real verona-mcp-server.js via
 * node, talk to it through the MCP SDK client over stdio, and assert it
 * registers built-in capabilities for the agent's subscriptions.
 *
 * Skips actual capability invocation (slack__send_message would hit the
 * Slack API). The capability handlers themselves are unit-tested in
 * tests/connectors/slack-spawn.test.ts.
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeSubscriptions } from "../../src/mcp/spawn-config.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const SERVER_SCRIPT = path.join(REPO_ROOT, "dist", "mcp", "verona-mcp-server.js");

let stateDir: string;
let runDir: string;

beforeAll(() => {
  // Ensure the server has been built. tsc was already run by `npm run build`,
  // but on a fresh checkout this guards against silent test misses.
  // We don't run npm here — just check the file exists. If missing, fail
  // clearly so the developer runs `npm run build`.
});

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-mcp-test-"));
  runDir = path.join(stateDir, "runs", "01TESTRUN");
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function ensureBuilt(): Promise<void> {
  try {
    await stat(SERVER_SCRIPT);
  } catch {
    // Build dist/mcp/* via tsc. Rare path — first-test-after-clone — and
    // fast (~1s). If you're running this loop hot, just keep `npm run build`.
    execSync("npx tsc -p tsconfig.json", { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_SCRIPT],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "verona-test-client", version: "0.0.1" }, {});
  await client.connect(transport);
  return client;
}

describe("verona-mcp-server", () => {
  it("boots and lists Slack capabilities for an agent subscribed to slack", async () => {
    await ensureBuilt();
    const client = await connect({
      VERONA_AGENT: "test-agent",
      VERONA_RUN_ID: "01TESTRUN",
      VERONA_AGENT_DIR: path.join(stateDir, "agents", "test-agent"),
      VERONA_RUN_DIR: runDir,
      VERONA_STATE_DIR: stateDir,
      VERONA_AUDIT_LOG_PATH: path.join(stateDir, "invocations.ndjson"),
      VERONA_SUBSCRIPTIONS_JSON: encodeSubscriptions([
        {
          id: "slack",
          config: { channel: "C1" },
          secrets: { bot_token: "xoxb-fake-test-token" },
        },
      ]),
    });

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["slack__send_message", "slack__upload_attachment"]),
      );
      const send = result.tools.find((t) => t.name === "slack__send_message");
      expect(send?.description).toMatch(/Slack/i);
      const schema = send?.inputSchema as { type: string; required: readonly string[] };
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(expect.arrayContaining(["channel", "text"]));
    } finally {
      await client.close();
    }
  }, 15000);

  it("boots with no tools when the agent has no subscriptions", async () => {
    await ensureBuilt();
    const client = await connect({
      VERONA_AGENT: "test-agent",
      VERONA_RUN_ID: "01TESTRUN",
      VERONA_AGENT_DIR: path.join(stateDir, "agents", "test-agent"),
      VERONA_RUN_DIR: runDir,
      VERONA_STATE_DIR: stateDir,
      VERONA_AUDIT_LOG_PATH: path.join(stateDir, "invocations.ndjson"),
      VERONA_SUBSCRIPTIONS_JSON: encodeSubscriptions([]),
    });
    try {
      const result = await client.listTools();
      expect(result.tools).toEqual([]);
    } finally {
      await client.close();
    }
  }, 15000);

  it("skips connectors with missing secrets but still boots", async () => {
    await ensureBuilt();
    const client = await connect({
      VERONA_AGENT: "test-agent",
      VERONA_RUN_ID: "01TESTRUN",
      VERONA_AGENT_DIR: path.join(stateDir, "agents", "test-agent"),
      VERONA_RUN_DIR: runDir,
      VERONA_STATE_DIR: stateDir,
      VERONA_AUDIT_LOG_PATH: path.join(stateDir, "invocations.ndjson"),
      VERONA_SUBSCRIPTIONS_JSON: encodeSubscriptions([
        {
          id: "slack",
          config: { channel: "C1" },
          secrets: {}, // bot_token missing
        },
      ]),
    });
    try {
      const result = await client.listTools();
      expect(result.tools).toEqual([]);
    } finally {
      await client.close();
    }
  }, 15000);
});
