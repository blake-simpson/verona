#!/usr/bin/env node
/**
 * verona-mcp-server — per-spawn stdio MCP server.
 *
 * Lifetime: one process per `claude -p` task spawn. Started by claude itself
 * via `--mcp-config`. Exits when claude closes the stdio transport.
 *
 * Responsibilities:
 *   1. Read env (VERONA_AGENT, VERONA_RUN_ID, VERONA_RUN_DIR, …) injected by
 *      the dispatcher's renderSpawnConfig().
 *   2. Decode the agent's connector subscriptions from
 *      VERONA_SUBSCRIPTIONS_JSON.
 *   3. Build a capability list per subscription via the spawn-factory registry
 *      (built-ins) or dynamic-import (user connectors).
 *   4. Register each capability as MCP tool `<connectorId>__<capability.name>`
 *      (the agent sees it as `mcp__verona__<connectorId>__<capability.name>`).
 *   5. On `tools/call`: invoke the capability, append a `connector_call`
 *      audit record (joined to the parent adapter_invocation by runId), and
 *      return the result.
 *   6. On `ctx.anchorThread(threadKey)`: append to the run's anchors.ndjson;
 *      the dispatcher drains it post-spawn and writes SessionStore entries.
 *
 * No long-lived I/O lives here. No Socket Mode. No webhook listener. The
 * daemon's connector instance owns all of that and is unaffected by spawn
 * lifetime.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  CapabilityCallContext,
  CapabilityResult,
  ConnectorCapability,
} from "../connectors/capability.js";
import { AuditLog } from "../core/audit-log.js";
import { AnchorStore, CallsLog } from "./anchor-store.js";
import { type SpawnSubscription, decodeSubscriptions } from "./spawn-config.js";
import { getBuiltInSpawnFactory } from "./spawn-factories.js";

interface RegisteredTool {
  /** MCP-side tool name, `<connectorId>__<capability.name>`. */
  fullName: string;
  connectorId: string;
  capability: ConnectorCapability;
  /**
   * Whether the subscribing agent set `allow_destructive=true` in
   * `[connectors.<id>]`. Used to gate destructive capabilities at invoke
   * time. Layer-B defence-in-depth alongside connector-guard.sh.
   */
  allowDestructive: boolean;
}

interface SpawnEnv {
  agent: string;
  runId: string;
  runDir: string;
  agentDir: string;
  stateDir: string;
  auditLogPath: string;
  subscriptionsJson: string;
}

function readEnv(): SpawnEnv | null {
  const required = [
    "VERONA_AGENT",
    "VERONA_RUN_ID",
    "VERONA_RUN_DIR",
    "VERONA_AGENT_DIR",
    "VERONA_STATE_DIR",
    "VERONA_AUDIT_LOG_PATH",
  ] as const;
  for (const key of required) {
    if (!process.env[key]) {
      process.stderr.write(`[verona-mcp] missing required env: ${key}\n`);
      return null;
    }
  }
  return {
    agent: process.env.VERONA_AGENT as string,
    runId: process.env.VERONA_RUN_ID as string,
    runDir: process.env.VERONA_RUN_DIR as string,
    agentDir: process.env.VERONA_AGENT_DIR as string,
    stateDir: process.env.VERONA_STATE_DIR as string,
    auditLogPath: process.env.VERONA_AUDIT_LOG_PATH as string,
    subscriptionsJson: process.env.VERONA_SUBSCRIPTIONS_JSON ?? "[]",
  };
}

function buildCapabilities(subscriptions: readonly SpawnSubscription[]): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  for (const sub of subscriptions) {
    const factory = getBuiltInSpawnFactory(sub.id);
    // User connectors are loaded from disk in a follow-up phase; built-ins
    // cover Phase 1.
    if (!factory) {
      process.stderr.write(
        `[verona-mcp] no spawn factory for connector "${sub.id}" — skipping (user connectors not yet wired)\n`,
      );
      continue;
    }
    let caps: readonly ConnectorCapability[];
    try {
      caps = factory({ config: sub.config, secrets: sub.secrets });
    } catch (err) {
      process.stderr.write(`[verona-mcp] factory for "${sub.id}" threw: ${String(err)}\n`);
      continue;
    }
    const allowDestructive =
      typeof (sub.config as { allow_destructive?: unknown }).allow_destructive === "boolean"
        ? Boolean((sub.config as { allow_destructive?: unknown }).allow_destructive)
        : false;
    for (const cap of caps) {
      out.push({
        fullName: `${sub.id}__${cap.name}`,
        connectorId: sub.id,
        capability: cap,
        allowDestructive,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const env = readEnv();
  if (!env) {
    process.exit(1);
  }

  const subscriptions = decodeSubscriptions(env.subscriptionsJson);
  const tools = buildCapabilities(subscriptions);

  // The capability ctx points capabilities at the per-run scratch dir for
  // attachment I/O. Created up-front so handlers don't need to.
  const attachmentsDir = path.join(env.runDir, "attachments");
  await mkdir(attachmentsDir, { recursive: true });

  const auditLog = new AuditLog({
    filePath: env.auditLogPath,
    rotatedDir: path.join(env.stateDir, "logs", "invocations"),
  });
  const anchors = new AnchorStore(env.runDir);
  const calls = new CallsLog(env.runDir);

  const server = new Server({ name: "verona", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.fullName,
      description: t.capability.description,
      inputSchema: t.capability.inputSchema as { type: "object" } & Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawInput } = req.params;
    const tool = tools.find((t) => t.fullName === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown verona tool: ${name}` }],
        isError: true,
      };
    }

    // Layer B: deny destructive capabilities unless the agent opted in.
    if (tool.capability.sideEffect === "destructive" && !tool.allowDestructive) {
      return {
        content: [
          {
            type: "text",
            text: `${tool.fullName} is a destructive capability and the agent's [connectors.${tool.connectorId}] block does not set allow_destructive=true. Add the flag (and accept the risk) or refactor to a non-destructive capability.`,
          },
        ],
        isError: true,
      };
    }

    const ctx: CapabilityCallContext = {
      runId: env.runId,
      agentName: env.agent,
      attachmentsDir,
      anchorThread: (threadKey: string): void => {
        // Fire-and-forget; await would defeat the sync API. The dispatcher
        // drains the file after the spawn exits.
        void anchors
          .append({
            threadKey,
            connectorId: tool.connectorId,
            capability: tool.capability.name,
            ts: new Date().toISOString(),
          })
          .catch((err) => {
            process.stderr.write(`[verona-mcp] anchor write failed: ${String(err)}\n`);
          });
      },
    };

    let result: CapabilityResult;
    const startedAt = Date.now();
    try {
      result = await tool.capability.invoke(rawInput ?? {}, ctx);
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : "Error";
      void auditLog.append({
        ts: new Date(startedAt).toISOString(),
        type: "connector_call",
        runId: env.runId,
        agent: env.agent,
        connector: tool.connectorId,
        capability: tool.capability.name,
        messageBytes: 0,
        ok: false,
        errorClass,
      });
      return {
        content: [
          {
            type: "text",
            text: `verona capability ${tool.fullName} threw ${errorClass}: ${String(err)}`,
          },
        ],
        isError: true,
      };
    }

    const messageBytes =
      result.messageBytes ?? Buffer.byteLength(JSON.stringify(result.output ?? null), "utf8");
    void auditLog.append({
      ts: new Date(startedAt).toISOString(),
      type: "connector_call",
      runId: env.runId,
      agent: env.agent,
      connector: tool.connectorId,
      capability: tool.capability.name,
      ...(result.destination !== undefined && { destination: result.destination }),
      ...(result.threadKey !== undefined && { threadKey: result.threadKey }),
      messageBytes,
      ok: true,
    });
    // Per-run calls log so the dispatcher can answer "did the agent invoke
    // any tool from connector X this run?" without scanning the audit log.
    // Awaited (cheap fs.appendFile) to avoid losing it when claude tears the
    // MCP server down on exit.
    try {
      await calls.append({
        connectorId: tool.connectorId,
        capability: tool.capability.name,
        ts: new Date(startedAt).toISOString(),
      });
    } catch (err) {
      process.stderr.write(`[verona-mcp] calls.ndjson append failed: ${String(err)}\n`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
      structuredContent:
        typeof result.output === "object" && result.output !== null
          ? (result.output as Record<string, unknown>)
          : undefined,
    };
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[verona-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
