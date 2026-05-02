/**
 * `verona logs <agent>` — surfaces episodic logs the daemon writes for each
 * task run. These are the agent's per-run summaries (timestamp, tokens, $,
 * response text). The structured audit log via `verona invocations` (M4) is a
 * separate machine-readable view.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { agentDir as resolveAgentDir, resolveStateDir } from "../../state/paths.js";

export interface LogsOptions {
  agentName: string;
  taskId?: string;
  /** When set, only return the latest N logs. */
  limit?: number;
  stateDir?: string;
}

export interface LogEntry {
  filePath: string;
  /** ISO timestamp parsed from the filename. */
  timestamp: string;
  taskId: string;
  runId: string;
  size: number;
}

export async function listLogs(opts: LogsOptions): Promise<LogEntry[]> {
  const stateDir = resolveStateDir(opts.stateDir);
  const dir = path.join(resolveAgentDir(stateDir, opts.agentName), "memory", "learned", "episodic");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed: LogEntry[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const m = file.match(
      /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})-(.+)-([0-9A-HJKMNP-TV-Z]{26})\.md$/,
    );
    if (!m) continue;
    const [, ts, taskId, runId] = m;
    if (opts.taskId && taskId !== opts.taskId) continue;
    const full = path.join(dir, file);
    const st = await stat(full);
    parsed.push({ filePath: full, timestamp: ts!, taskId: taskId!, runId: runId!, size: st.size });
  }
  parsed.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (opts.limit) return parsed.slice(0, opts.limit);
  return parsed;
}

export async function readLatestLog(opts: LogsOptions): Promise<string> {
  const all = await listLogs({ ...opts, limit: 1 });
  if (all.length === 0) return "";
  return await readFile(all[0]!.filePath, "utf8");
}

export function formatLogList(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return "(no logs)";
  return entries
    .map((e) => `${e.timestamp}  ${e.taskId.padEnd(20)}  run=${e.runId.slice(0, 8)}  ${e.size}b`)
    .join("\n");
}
