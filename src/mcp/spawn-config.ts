/**
 * spawn-config — renders the per-task MCP config file claude reads via
 * `claude -p --mcp-config <path>`.
 *
 * Shape (claude-cli expects this exact structure):
 *
 *   {
 *     "mcpServers": {
 *       "verona": {
 *         "command": "node",
 *         "args": ["/abs/path/to/verona-mcp-server.js"],
 *         "env": { VERONA_AGENT: "...", VERONA_RUN_ID: "...", ... }
 *       }
 *     }
 *   }
 *
 * Tools the server registers under name `slack__send_message` appear to the
 * agent as `mcp__verona__slack__send_message`. The dispatcher's allowed_tools
 * list extends to include the matching `mcp__verona__*` patterns.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SpawnConfigEnv {
  /** Agent name. */
  agent: string;
  /** Parent task spawn runId (ULID). Threaded into every connector_call audit record. */
  runId: string;
  /** Absolute path to the agent's state dir, e.g. <state>/agents/<name>. */
  agentDir: string;
  /** Absolute path to the per-run scratch dir, e.g. <state>/runs/<runId>. */
  runDir: string;
  /** Absolute path to <state>/. The MCP server resolves secrets/audit-log relative to this. */
  stateDir: string;
  /** Absolute path to the active audit log file. */
  auditLogPath: string;
  /**
   * JSON-encoded array of subscribed connectors:
   *   [{ id: "slack", config: { channel: "C123" }, secrets: { bot_token: "..." } }]
   * The MCP server uses this to instantiate spawn-side connectors and
   * enumerate capabilities. Encoded as JSON because env vars are flat strings.
   */
  subscriptionsJson: string;
}

export interface RenderSpawnConfigInput {
  /** Where to write the JSON file. The adapter passes this path to --mcp-config. */
  outputPath: string;
  /** Absolute path to the verona-mcp-server entry script (`dist/mcp/verona-mcp-server.js`). */
  serverScriptPath: string;
  /** Node binary path. Defaults to `process.execPath`. */
  nodeBin?: string;
  /** Env vars passed to the spawn-side MCP server. */
  env: SpawnConfigEnv;
}

export async function renderSpawnConfig(input: RenderSpawnConfigInput): Promise<void> {
  const config = {
    mcpServers: {
      verona: {
        command: input.nodeBin ?? process.execPath,
        args: [input.serverScriptPath],
        env: {
          VERONA_AGENT: input.env.agent,
          VERONA_RUN_ID: input.env.runId,
          VERONA_AGENT_DIR: input.env.agentDir,
          VERONA_RUN_DIR: input.env.runDir,
          VERONA_STATE_DIR: input.env.stateDir,
          VERONA_AUDIT_LOG_PATH: input.env.auditLogPath,
          VERONA_SUBSCRIPTIONS_JSON: input.env.subscriptionsJson,
        },
      },
    },
  };

  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, JSON.stringify(config, null, 2), "utf8");
}

/**
 * Subscription record passed to the MCP server via VERONA_SUBSCRIPTIONS_JSON.
 * Built by the dispatcher from the agent's [connectors.<id>] blocks plus the
 * connector's manifest secrets.
 */
export interface SpawnSubscription {
  /** Connector id, e.g. "slack". */
  id: string;
  /** Raw `[connectors.<id>]` block from the agent's agent.toml. */
  config: Readonly<Record<string, unknown>>;
  /** Resolved secrets for this connector, key → value. */
  secrets: Readonly<Record<string, string>>;
}

export function encodeSubscriptions(subs: readonly SpawnSubscription[]): string {
  return JSON.stringify(subs);
}

export function decodeSubscriptions(json: string): SpawnSubscription[] {
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return [];
  const out: SpawnSubscription[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { id?: unknown; config?: unknown; secrets?: unknown };
    if (typeof r.id !== "string") continue;
    out.push({
      id: r.id,
      config: (r.config && typeof r.config === "object" ? r.config : {}) as Readonly<
        Record<string, unknown>
      >,
      secrets: (r.secrets && typeof r.secrets === "object" ? r.secrets : {}) as Readonly<
        Record<string, string>
      >,
    });
  }
  return out;
}
