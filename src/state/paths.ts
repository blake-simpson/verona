/**
 * Path resolution for Verona's THREE trees:
 *
 *   1. Source tree   — this repo (code + read-only example templates).
 *   2. User content  — where YOUR agents and connectors live. One git repo
 *                       at ~/.verona/user/ containing agents/ and connectors/.
 *                       Override the root via VERONA_USER_DIR; override the
 *                       subdirs individually via VERONA_AGENTS_DIR /
 *                       VERONA_CONNECTORS_DIR.
 *   3. Runtime state — memory, secrets, sessions, logs. Default
 *                       ~/.verona/state/. Override via VERONA_STATE_DIR.
 *
 * Trees 2 and 3 live outside the deploy tree so `verona deploy` / `git pull`
 * never clobbers them. See knowledge/architecture/two-tree-deploy.md.
 *
 * Legacy note: prior to v0.3, agents lived at ~/.verona/agents/. That path
 * is still honoured if VERONA_AGENTS_DIR is set explicitly, so existing
 * deployments don't break — but the new default is ~/.verona/user/agents/.
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
  /** Pidfile written by `verona daemon` so `verona reload` can find it. */
  daemonPid: string;
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
    daemonPid: path.join(root, "daemon.pid"),
  };
}

export function agentDir(stateDir: string, agentName: string): string {
  return path.join(stateDir, "agents", agentName);
}

/**
 * Resolves the user-content root. Default ~/.verona/user/. Holds two subdirs:
 * `agents/` and `connectors/`. Intended to be a single git repo so a user can
 * back up + sync their authored content with one push/pull.
 */
export function resolveUserDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.VERONA_USER_DIR) return path.resolve(process.env.VERONA_USER_DIR);
  return path.join(homedir(), ".verona", "user");
}

/**
 * Resolves the user-agents dir. Default: <user>/agents/. Override via
 * VERONA_AGENTS_DIR. This is where YOUR (the user's) agent definitions live —
 * separate from the source repo's read-only `agents/examples/` templates and
 * separate from the runtime `state/` tree.
 */
export function resolveAgentsDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.VERONA_AGENTS_DIR) return path.resolve(process.env.VERONA_AGENTS_DIR);
  return path.join(resolveUserDir(), "agents");
}

/**
 * Resolves the user-connectors dir. Default: <user>/connectors/. Override via
 * VERONA_CONNECTORS_DIR. Each subdirectory is one connector with a
 * connector.toml manifest at its root. Loaded by the daemon at startup and on
 * SIGHUP. See src/core/connector-loader.ts.
 */
export function resolveConnectorsDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.VERONA_CONNECTORS_DIR) return path.resolve(process.env.VERONA_CONNECTORS_DIR);
  return path.join(resolveUserDir(), "connectors");
}

export function userAgentDir(agentsDir: string, name: string): string {
  return path.join(agentsDir, name);
}

export function userConnectorDir(connectorsDir: string, id: string): string {
  return path.join(connectorsDir, id);
}

/**
 * Legacy ~/.verona/agents/ location used before v0.3. Surfaced for the
 * doctor check that warns users with content there to migrate.
 */
export function legacyAgentsDir(): string {
  return path.join(homedir(), ".verona", "agents");
}
