/**
 * `verona service install` — register the daemon with the host's service
 * manager (systemd user-mode on Linux, launchd on macOS) using the templates
 * shipped in `deploy/`.
 *
 * Resolves paths in both source-tree and built-artifact contexts so it works
 * for both `npm install -g verona-ai` and an in-repo `npm run dev`.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, VeronaError } from "../../util/errors.js";
import { resolveStateDir } from "../../state/paths.js";

export interface ServiceOptions {
  stateDir?: string;
  /** Override the auto-detected node binary (default: `process.execPath`). */
  nodeBin?: string;
  /** Skip running the loader commands (write the unit file but don't enable). */
  dryRun?: boolean;
}

export interface ServiceInstallResult {
  platform: "linux" | "darwin";
  unitPath: string;
  runtimeDir: string;
  stateDir: string;
  nodeBin: string;
  loaderOutput: string[];
  postInstallHints: string[];
}

export async function runServiceInstall(opts: ServiceOptions = {}): Promise<ServiceInstallResult> {
  const ctx = await resolveServiceContext(opts);

  if (ctx.platform === "linux") {
    return installLinux(ctx, opts.dryRun ?? false);
  }
  return installDarwin(ctx, opts.dryRun ?? false);
}

export async function runServiceUninstall(opts: ServiceOptions = {}): Promise<{
  platform: "linux" | "darwin";
  unitPath: string;
  loaderOutput: string[];
}> {
  const ctx = await resolveServiceContext(opts);

  if (ctx.platform === "linux") {
    const unitPath = path.join(homedir(), ".config", "systemd", "user", "verona-daemon.service");
    const out: string[] = [];
    out.push(await runChecked("systemctl", ["--user", "disable", "--now", "verona-daemon.service"]));
    await safeUnlink(unitPath);
    out.push(await runChecked("systemctl", ["--user", "daemon-reload"]));
    return { platform: "linux", unitPath, loaderOutput: out };
  }

  const unitPath = path.join(homedir(), "Library", "LaunchAgents", "com.verona.daemon.plist");
  const out: string[] = [];
  const uid = userInfo().uid;
  out.push(await runChecked("launchctl", ["bootout", `gui/${uid}/com.verona.daemon`], { allowFail: true }));
  await safeUnlink(unitPath);
  return { platform: "darwin", unitPath, loaderOutput: out };
}

export async function runServiceStatus(opts: ServiceOptions = {}): Promise<string> {
  const ctx = await resolveServiceContext(opts);
  if (ctx.platform === "linux") {
    return runChecked("systemctl", ["--user", "status", "verona-daemon", "--no-pager"], {
      allowFail: true,
    });
  }
  const uid = userInfo().uid;
  return runChecked("launchctl", ["print", `gui/${uid}/com.verona.daemon`], { allowFail: true });
}

interface ServiceContext {
  platform: "linux" | "darwin";
  runtimeDir: string;
  stateDir: string;
  nodeBin: string;
  user: string;
}

async function resolveServiceContext(opts: ServiceOptions): Promise<ServiceContext> {
  const plat = platform();
  if (plat !== "linux" && plat !== "darwin") {
    throw new ConfigError(
      `verona service is only supported on linux (systemd) and darwin (launchd); got ${plat}`,
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const runtimeDir = path.resolve(here, "..", "..", "..");
  const stateDir = resolveStateDir(opts.stateDir);
  const nodeBin = opts.nodeBin ?? process.execPath;
  const user = userInfo().username;

  return { platform: plat, runtimeDir, stateDir, nodeBin, user };
}

async function installLinux(ctx: ServiceContext, dryRun: boolean): Promise<ServiceInstallResult> {
  const templatePath = path.join(
    ctx.runtimeDir,
    "deploy",
    "systemd",
    "verona-daemon.service.template",
  );
  const rendered = (await readFile(templatePath, "utf8"))
    .replaceAll("{{VERONA_RUNTIME}}", ctx.runtimeDir)
    .replaceAll("{{VERONA_STATE_DIR}}", ctx.stateDir)
    .replaceAll("{{NODE_BIN}}", ctx.nodeBin);

  const unitDir = path.join(homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, "verona-daemon.service");
  await mkdir(unitDir, { recursive: true });
  await writeFile(unitPath, rendered, "utf8");

  const loaderOutput: string[] = [];
  if (!dryRun) {
    loaderOutput.push(await runChecked("systemctl", ["--user", "daemon-reload"]));
    loaderOutput.push(
      await runChecked("systemctl", ["--user", "enable", "--now", "verona-daemon.service"]),
    );
  }

  const lingerEnabled = await isLingerEnabled(ctx.user);
  const hints: string[] = [];
  if (!lingerEnabled) {
    hints.push(
      `Enable lingering so the daemon survives logout: \`sudo loginctl enable-linger ${ctx.user}\``,
    );
  }
  hints.push("Tail logs: `journalctl --user -u verona-daemon -f`");
  hints.push("Stop service: `systemctl --user stop verona-daemon`");

  return {
    platform: "linux",
    unitPath,
    runtimeDir: ctx.runtimeDir,
    stateDir: ctx.stateDir,
    nodeBin: ctx.nodeBin,
    loaderOutput,
    postInstallHints: hints,
  };
}

async function installDarwin(ctx: ServiceContext, dryRun: boolean): Promise<ServiceInstallResult> {
  const templatePath = path.join(
    ctx.runtimeDir,
    "deploy",
    "launchd",
    "com.verona.daemon.plist.template",
  );
  const rendered = (await readFile(templatePath, "utf8"))
    .replaceAll("{{VERONA_RUNTIME}}", ctx.runtimeDir)
    .replaceAll("{{VERONA_STATE_DIR}}", ctx.stateDir)
    .replaceAll("{{NODE_BIN}}", ctx.nodeBin)
    .replaceAll("{{USER}}", ctx.user);

  const unitDir = path.join(homedir(), "Library", "LaunchAgents");
  const unitPath = path.join(unitDir, "com.verona.daemon.plist");
  await mkdir(unitDir, { recursive: true });
  await writeFile(unitPath, rendered, "utf8");

  const loaderOutput: string[] = [];
  if (!dryRun) {
    const uid = userInfo().uid;
    loaderOutput.push(
      await runChecked("launchctl", ["bootstrap", `gui/${uid}`, unitPath], { allowFail: true }),
    );
    loaderOutput.push(await runChecked("launchctl", ["enable", `gui/${uid}/com.verona.daemon`]));
    loaderOutput.push(
      await runChecked("launchctl", ["kickstart", "-k", `gui/${uid}/com.verona.daemon`]),
    );
  }

  const hints = [
    `Tail logs: \`tail -f ${ctx.stateDir}/logs/daemon.stdout.log\``,
    "Stop service: `launchctl bootout gui/$(id -u)/com.verona.daemon`",
  ];

  return {
    platform: "darwin",
    unitPath,
    runtimeDir: ctx.runtimeDir,
    stateDir: ctx.stateDir,
    nodeBin: ctx.nodeBin,
    loaderOutput,
    postInstallHints: hints,
  };
}

async function isLingerEnabled(user: string): Promise<boolean> {
  try {
    const out = await runChecked("loginctl", ["show-user", user, "--property=Linger"], {
      allowFail: true,
    });
    return /Linger=yes/i.test(out);
  } catch {
    return false;
  }
}

interface RunOptions {
  allowFail?: boolean;
}

function runChecked(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      if (opts.allowFail) {
        resolve(`${cmd} ${args.join(" ")}\n  (skipped: ${err.message})`);
        return;
      }
      reject(
        new VeronaError(
          "config",
          `failed to spawn \`${cmd}\`: ${err.message}. Is it on PATH?`,
          { cause: err },
        ),
      );
    });
    proc.on("close", (code) => {
      const summary = `$ ${cmd} ${args.join(" ")}`;
      const tail = [stdout, stderr].filter((s) => s.trim()).join("\n").trim();
      const block = tail ? `${summary}\n${tail}` : summary;
      if (code === 0 || opts.allowFail) {
        resolve(block);
        return;
      }
      reject(
        new VeronaError(
          "config",
          `\`${cmd} ${args.join(" ")}\` exited ${code}: ${stderr.trim() || "no stderr"}`,
        ),
      );
    });
  });
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function formatInstallResult(r: ServiceInstallResult): string {
  const lines: string[] = [];
  lines.push(`installed verona daemon (${r.platform})`);
  lines.push(`  unit:    ${r.unitPath}`);
  lines.push(`  runtime: ${r.runtimeDir}`);
  lines.push(`  state:   ${r.stateDir}`);
  lines.push(`  node:    ${r.nodeBin}`);
  if (r.loaderOutput.length > 0) {
    lines.push("");
    for (const block of r.loaderOutput) {
      lines.push(block);
    }
  }
  if (r.postInstallHints.length > 0) {
    lines.push("");
    lines.push("Next:");
    for (const hint of r.postInstallHints) {
      lines.push(`  ${hint}`);
    }
  }
  return lines.join("\n");
}
