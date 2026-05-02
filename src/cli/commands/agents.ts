import path from "node:path";
import { GitRecorder } from "../../core/git-recorder.js";
import { listRegisteredAgents, registerAgent } from "../../state/agent-registry.js";
import { resolveStateDir } from "../../state/paths.js";

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
