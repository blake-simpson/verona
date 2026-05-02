/**
 * Resolves the runtime state dir. Default: ~/.verona/state. Override via
 * VERONA_STATE_DIR. The state dir holds memory, secrets, sessions, logs, and
 * its own .git — it lives outside the deploy tree so `verona deploy` never
 * clobbers it.
 *
 * See knowledge/architecture/two-tree-deploy.md for the full layout contract.
 */

import { homedir } from "node:os";
import path from "node:path";

export interface StatePaths {
  root: string;
  agents: string;
  secrets: string;
  secretsGlobal: string;
  secretsConnectors: string;
  sessions: string;
  logs: string;
  invocations: string;
  costs: string;
  veronaToml: string;
}

export function resolveStateDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.VERONA_STATE_DIR) return path.resolve(process.env.VERONA_STATE_DIR);
  return path.join(homedir(), ".verona", "state");
}

export function statePaths(stateDir: string): StatePaths {
  const root = path.resolve(stateDir);
  return {
    root,
    agents: path.join(root, "agents"),
    secrets: path.join(root, "secrets"),
    secretsGlobal: path.join(root, "secrets", "_global"),
    secretsConnectors: path.join(root, "secrets", "_connectors"),
    sessions: path.join(root, "sessions"),
    logs: path.join(root, "logs"),
    invocations: path.join(root, "invocations.ndjson"),
    costs: path.join(root, "costs"),
    veronaToml: path.join(root, "verona.toml"),
  };
}

export function agentDir(stateDir: string, agentName: string): string {
  return path.join(stateDir, "agents", agentName);
}
