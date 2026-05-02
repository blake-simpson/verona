import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { checkSecretsPerms } from "../../secrets/store.js";
import { resolveStateDir, statePaths } from "../../state/paths.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
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

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    const mark = c.ok ? "[ok]" : "[--]";
    lines.push(`${mark} ${c.name}: ${c.detail}`);
  }
  const allOk = checks.every((c) => c.ok);
  lines.push("");
  lines.push(
    allOk ? "all checks passed." : "one or more checks failed; resolve before running the daemon.",
  );
  return lines.join("\n");
}
