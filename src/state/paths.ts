/**
 * Path resolution for Verona's THREE trees:
 *
 *   1. Source tree   — this repo (code + read-only example templates).
 *   2. User agents   — where YOUR agent definitions live. Default
 *                       ~/.verona/agents/<name>/. Override via VERONA_AGENTS_DIR.
 *   3. Runtime state — memory, secrets, sessions, logs. Default
 *                       ~/.verona/state/. Override via VERONA_STATE_DIR.
 *
 * Trees 2 and 3 live outside the deploy tree so `verona deploy` / `git pull`
 * never clobbers them. See knowledge/architecture/two-tree-deploy.md.
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

/**
 * Resolves the user-agents dir. Default: ~/.verona/agents/. Override via
 * VERONA_AGENTS_DIR. This is where YOUR (the user's) agent definitions live —
 * separate from the source repo's read-only `agents/examples/` templates and
 * separate from the runtime `state/` tree.
 */
export function resolveAgentsDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.VERONA_AGENTS_DIR) return path.resolve(process.env.VERONA_AGENTS_DIR);
  return path.join(homedir(), ".verona", "agents");
}

export function userAgentDir(agentsDir: string, name: string): string {
  return path.join(agentsDir, name);
}
