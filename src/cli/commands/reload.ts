/**
 * `verona reload` — sends SIGHUP to the running daemon, asking it to
 * re-read agent configs and re-apply the schedule.
 *
 * Reads the pidfile at <state>/daemon.pid (written by `verona daemon` at
 * startup, removed at shutdown). Verifies the process exists with `kill -0`
 * before signaling.
 *
 * Note: connector wiring (Slack tokens, channel→agent map) is NOT reloaded;
 * those changes still need a full daemon restart.
 */

import { readFile } from "node:fs/promises";
import { resolveStateDir, statePaths } from "../../state/paths.js";
import { StateError } from "../../util/errors.js";

export interface ReloadOptions {
  stateDir?: string;
}

export interface ReloadResult {
  pid: number;
  pidFilePath: string;
}

export async function runReload(opts: ReloadOptions = {}): Promise<ReloadResult> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);

  let raw: string;
  try {
    raw = await readFile(paths.daemonPid, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateError(
        `daemon does not appear to be running (no pidfile at ${paths.daemonPid}). Start it with \`verona daemon\` or via launchd/systemd.`,
      );
    }
    throw err;
  }

  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new StateError(
      `pidfile at ${paths.daemonPid} contains invalid pid: ${JSON.stringify(raw)}`,
    );
  }

  // Probe — does the process actually exist?
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      throw new StateError(
        `pidfile at ${paths.daemonPid} points to pid ${pid}, but no such process exists. Daemon may have crashed without cleaning up; remove the pidfile and restart.`,
      );
    }
    throw err;
  }

  process.kill(pid, "SIGHUP");
  return { pid, pidFilePath: paths.daemonPid };
}
