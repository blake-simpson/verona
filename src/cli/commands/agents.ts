import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitRecorder } from "../../core/git-recorder.js";
import {
  listRegisteredAgents,
  registerAgent,
  removeRegisteredAgent,
  scaffoldAgentFromTemplate,
} from "../../state/agent-registry.js";
import { resolveAgentsDir, resolveStateDir, userAgentDir } from "../../state/paths.js";
import { ConfigError } from "../../util/errors.js";

export interface AgentsAddOptions {
  sourceDir: string;
  stateDir?: string;
}

export interface AgentsAddResult {
  agentName: string;
  destination: string;
  fresh: boolean;
  commit: string | null;
}

export async function runAgentsAdd(opts: AgentsAddOptions): Promise<AgentsAddResult> {
  const stateDir = resolveStateDir(opts.stateDir);
  const result = await registerAgent({
    sourceDir: path.resolve(opts.sourceDir),
    stateDir,
  });

  const recorder = new GitRecorder({ stateDir });
  await recorder.ensureRepo();
  const commit = await recorder.commit({
    message: result.fresh
      ? `verona: register agent ${result.agentName}`
      : `verona: update agent ${result.agentName}`,
    paths: [path.join("agents", result.agentName)],
    skipIfClean: true,
  });

  return {
    agentName: result.agentName,
    destination: result.destination,
    fresh: result.fresh,
    commit,
  };
}

export interface AgentsListOptions {
  stateDir?: string;
}

export async function runAgentsList(opts: AgentsListOptions = {}): Promise<string[]> {
  const stateDir = resolveStateDir(opts.stateDir);
  return listRegisteredAgents(stateDir);
}

export interface AgentsRemoveOptions {
  name: string;
  stateDir?: string;
}

export interface AgentsRemoveResult {
  agentName: string;
  removedDir: string;
  commit: string | null;
}

/**
 * Remove an agent from the state tree. DELETES the agent's memory.
 * Recoverable via the state dir's git history (the deletion is committed).
 *
 * Note: a running daemon won't drop the agent's schedule until it's reloaded
 * (`verona reload`) or restarted.
 */
export async function runAgentsRemove(opts: AgentsRemoveOptions): Promise<AgentsRemoveResult> {
  const stateDir = resolveStateDir(opts.stateDir);
  const removedDir = path.join(stateDir, "agents", opts.name);
  await removeRegisteredAgent(stateDir, opts.name);

  const recorder = new GitRecorder({ stateDir });
  await recorder.ensureRepo();
  const commit = await recorder.commit({
    message: `verona: remove agent ${opts.name}`,
    paths: [path.join("agents", opts.name)],
    skipIfClean: true,
  });

  return { agentName: opts.name, removedDir, commit };
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface AgentsInitOptions {
  /** New agent name (kebab-case). Becomes the dir name and [agent].name. */
  name: string;
  /** Bundled template to copy from, e.g. "researcher" or "hello-world". */
  template: string;
  /** Override target root; defaults to resolveAgentsDir(). */
  agentsDir?: string;
}

export interface AgentsInitResult {
  agentName: string;
  templateDir: string;
  targetDir: string;
}

export async function runAgentsInit(opts: AgentsInitOptions): Promise<AgentsInitResult> {
  if (!NAME_RE.test(opts.name)) {
    throw new ConfigError(
      `invalid agent name "${opts.name}" — must be kebab-case starting with a letter`,
    );
  }
  if (!NAME_RE.test(opts.template)) {
    throw new ConfigError(`invalid template name "${opts.template}"`);
  }

  const agentsDir = resolveAgentsDir(opts.agentsDir);
  const targetDir = userAgentDir(agentsDir, opts.name);
  const templateDir = templatePathFor(opts.template);

  await scaffoldAgentFromTemplate({
    templateDir,
    targetDir,
    newAgentName: opts.name,
  });

  return { agentName: opts.name, templateDir, targetDir };
}

/**
 * Resolves a bundled template's absolute path. Templates ship with the source
 * tree at <root>/agents/examples/<name>/ AND with the build artifact at
 * <runtime>/agents/examples/<name>/. Resolution is relative to this module's
 * file URL so it works in both contexts.
 *
 * In dev (tsx running src/cli/commands/agents.ts):
 *   here = <root>/src/cli/commands → ../../../agents/examples/<name>
 * In artifact (compiled dist/cli/commands/agents.js):
 *   here = <runtime>/dist/cli/commands → ../../../agents/examples/<name>
 *
 * Both resolve to the same `<root>/agents/examples/<name>` shape.
 */
export function templatePathFor(template: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "agents", "examples", template);
}
