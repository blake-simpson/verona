import { mkdir, stat, writeFile } from "node:fs/promises";
import { GitRecorder } from "../../core/git-recorder.js";
import { ensureSecretsRootPerms } from "../../secrets/store.js";
import { resolveStateDir, statePaths } from "../../state/paths.js";

const DEFAULT_VERONA_TOML = `# Verona daemon config (state-dir-scoped).
# Override per host. Edit and restart \`verona daemon\` to pick up changes.

[daemon]
log_level = "info"
webhook_listen_port = 0   # 0 disables inbound webhook listener

[adapters]
  # Per-adapter effort -> model overrides go here, e.g.:
  # [adapters.effort_mapping.openrouter]
  # high = "anthropic/claude-opus-4-7"

[cost_tracker]
rollup_interval_seconds = 300
rotate_invocations_at_mb = 50
`;

export interface InitOptions {
  stateDir?: string;
}

export interface InitResult {
  stateDir: string;
  created: boolean;
  veronaTomlPath: string;
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);
  const created = !(await pathExists(paths.root));

  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.agents, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  await mkdir(paths.costs, { recursive: true });

  // Secrets dir + scoping subdirs with strict perms.
  await ensureSecretsRootPerms(paths.secrets);
  await mkdir(paths.secretsGlobal, { recursive: true, mode: 0o700 });
  await mkdir(paths.secretsConnectors, { recursive: true, mode: 0o700 });

  // Default verona.toml (don't overwrite if it already exists).
  if (!(await pathExists(paths.veronaToml))) {
    await writeFile(paths.veronaToml, DEFAULT_VERONA_TOML, "utf8");
  }

  // Initialize state-dir as a git repo.
  const recorder = new GitRecorder({ stateDir });
  await recorder.ensureRepo();
  await recorder.commit({
    message: "verona: initial state scaffold",
    paths: ["verona.toml"],
    skipIfClean: true,
  });

  return { stateDir, created, veronaTomlPath: paths.veronaToml };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function describeInit(result: InitResult): string {
  const status = result.created ? "created" : "ensured";
  return [
    `state dir ${status} at ${result.stateDir}`,
    "  - agents/      (empty)",
    "  - secrets/     (chmod 700; per-agent + _global + _connectors scoping)",
    "  - sessions/    (claude -p session map per agent)",
    "  - logs/        (per-run logs)",
    "  - costs/       (cost rollups; will populate once tasks run)",
    "  - .git/        (memory/run audit trail; local-only)",
    `  - verona.toml  (${result.veronaTomlPath})`,
    "",
    "Next: register an agent with `verona agents add <path>` and run `verona doctor` to verify the host.",
  ].join("\n");
}
