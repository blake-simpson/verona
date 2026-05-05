import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { checkSecretsPerms } from "../../secrets/store.js";
import { legacyAgentsDir, resolveStateDir, statePaths } from "../../state/paths.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** "error" → fails the run; "warn" → reported but exit code stays 0. Default error. */
  severity?: "error" | "warn";
  detail: string;
}

export interface DoctorOptions {
  stateDir?: string;
  /** If true, runs `claude --version` to verify the binary. */
  checkClaude?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);
  const checks: DoctorCheck[] = [];

  // 1. State dir exists.
  checks.push(await checkPath("state dir exists", paths.root, "directory"));

  // 2. State dir is a git repo.
  checks.push(
    await checkPath("state dir is a git repo", path.join(paths.root, ".git"), "directory"),
  );

  // 3. Secrets dir perms.
  const permsOk = await safe(async () => {
    const result = await checkSecretsPerms(paths.secrets);
    return result.ok
      ? { ok: true, detail: "0700/0600 throughout" }
      : { ok: false, detail: result.issues.join("; ") };
  });
  checks.push({ name: "secrets perms", ...permsOk });

  // 4. claude binary present + responsive.
  if (opts.checkClaude !== false) {
    checks.push(await checkClaudeBinary());
  }

  // 5. Claude Code plugin (warning — optional).
  checks.push(await checkClaudePlugin());

  // 6. Legacy ~/.verona/agents/ — warn if it has content the user might want
  //    to migrate into ~/.verona/user/agents/.
  checks.push(await checkLegacyAgentsDir());

  return checks;
}

async function checkPath(
  name: string,
  p: string,
  expect: "file" | "directory",
): Promise<DoctorCheck> {
  try {
    const st = await stat(p);
    const isDir = st.isDirectory();
    const isFile = st.isFile();
    if (expect === "directory" && !isDir) {
      return { name, ok: false, detail: `${p} is not a directory` };
    }
    if (expect === "file" && !isFile) {
      return { name, ok: false, detail: `${p} is not a file` };
    }
    return { name, ok: true, detail: p };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { name, ok: false, detail: `${p} not found — run \`verona init\`` };
    }
    return { name, ok: false, detail: String(err) };
  }
}

async function checkClaudeBinary(): Promise<DoctorCheck> {
  const bin = process.env.VERONA_CLAUDE_BIN ?? "claude";
  return new Promise((resolve) => {
    const proc = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      resolve({
        name: "claude binary",
        ok: false,
        detail: `failed to spawn ${bin}: ${err.message}. Install with \`npm i -g @anthropic-ai/claude-code\` and run \`claude login\`.`,
      });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({
          name: "claude binary",
          ok: false,
          detail: `${bin} --version exited ${code}: ${stderr.trim() || "no stderr"}`,
        });
        return;
      }
      const version = stdout.trim() || "unknown version";
      resolve({
        name: "claude binary",
        ok: true,
        detail: `${version} (subscription auth via \`claude login\` required for the claude-cli adapter)`,
      });
    });
  });
}

async function safe<T extends { ok: boolean; detail: string }>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, detail: String(err) } as T;
  }
}

/**
 * Look for the Verona Claude Code plugin under ~/.claude/plugins/. Reports a
 * warning (not an error) if absent — the plugin is optional; users can author
 * agents and connectors entirely via the CLI.
 */
async function checkClaudePlugin(): Promise<DoctorCheck> {
  const candidates = [
    path.join(homedir(), ".claude", "plugins"),
    path.join(homedir(), ".claude-code", "plugins"),
  ];
  for (const root of candidates) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (entries.some((e) => e === "verona" || e.startsWith("verona@") || e.startsWith("verona-"))) {
      return {
        name: "claude code plugin",
        ok: true,
        detail: `installed under ${root}`,
      };
    }
  }
  return {
    name: "claude code plugin",
    ok: false,
    severity: "warn",
    detail:
      "not installed. For the /verona:* skills run `/plugin marketplace add blake-simpson/verona && /plugin install verona@verona` inside Claude Code. Optional — skip if you'll author by hand.",
  };
}

/**
 * Warn if the pre-v0.3 location ~/.verona/agents/ exists with subdirectories
 * (suggesting registered agents that haven't been migrated to ~/.verona/user/agents/).
 */
async function checkLegacyAgentsDir(): Promise<DoctorCheck> {
  const legacy = legacyAgentsDir();
  let entries: string[];
  try {
    entries = await readdir(legacy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "legacy agents dir", ok: true, detail: "not present" };
    }
    throw err;
  }
  const subDirs = entries.filter((e) => !e.startsWith("."));
  if (subDirs.length === 0) {
    return { name: "legacy agents dir", ok: true, detail: `${legacy} (empty)` };
  }
  return {
    name: "legacy agents dir",
    ok: false,
    severity: "warn",
    detail: `${legacy} contains ${subDirs.length} subdir(s). The default moved to ~/.verona/user/agents/ — either set VERONA_AGENTS_DIR=${legacy} or move the contents into ~/.verona/user/agents/.`,
  };
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    const mark = c.ok ? "[ok]" : c.severity === "warn" ? "[!!]" : "[--]";
    lines.push(`${mark} ${c.name}: ${c.detail}`);
  }
  const errored = checks.some((c) => !c.ok && c.severity !== "warn");
  const warned = checks.some((c) => !c.ok && c.severity === "warn");
  lines.push("");
  if (errored) {
    lines.push("one or more checks failed; resolve before running the daemon.");
  } else if (warned) {
    lines.push("checks passed (with warnings — see [!!] above).");
  } else {
    lines.push("all checks passed.");
  }
  return lines.join("\n");
}
