import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeSubscriptions,
  encodeSubscriptions,
  renderSpawnConfig,
  type SpawnSubscription,
} from "../../src/mcp/spawn-config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-spawncfg-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("renderSpawnConfig", () => {
  it("writes a valid claude --mcp-config JSON pointing at the verona MCP server", async () => {
    const outputPath = path.join(dir, "mcp.json");
    await renderSpawnConfig({
      outputPath,
      serverScriptPath: "/opt/verona/runtime/dist/mcp/verona-mcp-server.js",
      nodeBin: "/usr/bin/node",
      env: {
        agent: "test-agent",
        runId: "01HRUNID",
        agentDir: "/state/agents/test-agent",
        runDir: "/state/runs/01HRUNID",
        stateDir: "/state",
        auditLogPath: "/state/invocations.ndjson",
        subscriptionsJson: encodeSubscriptions([
          { id: "slack", config: { channel: "C1" }, secrets: { bot_token: "xoxb-x" } },
        ]),
      },
    });
    const json = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(json).toHaveProperty("mcpServers.verona");
    const server = (json.mcpServers as { verona: Record<string, unknown> }).verona;
    expect(server.command).toBe("/usr/bin/node");
    expect(server.args).toEqual(["/opt/verona/runtime/dist/mcp/verona-mcp-server.js"]);
    const env = server.env as Record<string, string>;
    expect(env.VERONA_AGENT).toBe("test-agent");
    expect(env.VERONA_RUN_ID).toBe("01HRUNID");
    expect(env.VERONA_RUN_DIR).toBe("/state/runs/01HRUNID");
    expect(env.VERONA_AUDIT_LOG_PATH).toBe("/state/invocations.ndjson");
    expect(env.VERONA_SUBSCRIPTIONS_JSON).toBeDefined();
  });
});

describe("encode/decodeSubscriptions", () => {
  it("round-trips a non-empty subscription list", () => {
    const subs: readonly SpawnSubscription[] = [
      { id: "slack", config: { channel: "C1" }, secrets: { bot_token: "xoxb" } },
      { id: "quickbooks", config: { company: "COQB" }, secrets: { token: "QB" } },
    ];
    const encoded = encodeSubscriptions(subs);
    const decoded = decodeSubscriptions(encoded);
    expect(decoded).toEqual(subs);
  });

  it("returns [] for empty / malformed input", () => {
    expect(decodeSubscriptions("")).toEqual([]);
    expect(decodeSubscriptions("[]")).toEqual([]);
    // not an array
    expect(decodeSubscriptions("{}")).toEqual([]);
    // entries missing id are skipped
    expect(decodeSubscriptions(JSON.stringify([{ config: {} }]))).toEqual([]);
  });

  it("normalises missing config/secrets to empty objects", () => {
    const decoded = decodeSubscriptions(JSON.stringify([{ id: "x" }]));
    expect(decoded).toEqual([{ id: "x", config: {}, secrets: {} }]);
  });
});
