/**
 * `verona invocations` — query the audit log.
 */

import path from "node:path";
import { type AuditFilter, AuditLog, type AuditRecord } from "../../core/audit-log.js";
import { resolveStateDir, statePaths } from "../../state/paths.js";

export interface InvocationsOptions {
  stateDir?: string;
  agent?: string;
  task?: string;
  connector?: string;
  /** Relative duration like "1d", "7d", "1h", "30m". */
  since?: string;
  limit?: number;
  ok?: boolean;
  /** Stream raw NDJSON (one record per line) instead of formatted table. */
  json?: boolean;
}

export async function runInvocations(opts: InvocationsOptions = {}): Promise<string> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);
  const log = new AuditLog({
    filePath: paths.invocations,
    rotatedDir: path.join(paths.logs, "invocations"),
  });

  const filter: AuditFilter = {};
  if (opts.agent !== undefined) filter.agent = opts.agent;
  if (opts.task !== undefined) filter.task = opts.task;
  if (opts.connector !== undefined) filter.connector = opts.connector;
  if (opts.ok !== undefined) filter.ok = opts.ok;
  if (opts.since !== undefined) {
    const sinceIso = parseDurationToSinceIso(opts.since);
    filter.since = sinceIso;
  }

  const records = await log.readAll(filter);
  // newest first
  records.sort((a, b) => b.ts.localeCompare(a.ts));
  const sliced = opts.limit ? records.slice(0, opts.limit) : records.slice(0, 50);

  if (opts.json) {
    return sliced.map((r) => JSON.stringify(r)).join("\n");
  }
  if (sliced.length === 0) return "(no invocations)";
  return sliced.map(formatRecord).join("\n");
}

function formatRecord(r: AuditRecord): string {
  const ok = r.ok ? "ok " : "ERR";
  const ts = r.ts.replace("T", " ").slice(0, 19);
  // For failed records, surface the reason on an indented continuation line so
  // the table stays scannable but the failure is diagnosable without journald.
  const detail =
    !r.ok && r.errorMessage
      ? `\n    ↳ ${r.errorMessage.replace(/\n/g, "\n      ")}`
      : !r.ok && r.errorClass
        ? `\n    ↳ ${r.errorClass}`
        : "";
  if (r.type === "adapter_invocation") {
    const cost = r.subscriptionCovered ? "subscription" : `$${r.costUsd?.toFixed(4) ?? "?"}`;
    return `${ts} ${ok} ${r.type.padEnd(20)} ${r.agent}:${r.task} adapter=${r.adapter} model=${r.modelUsed} tokens=${r.tokens.input}/${r.tokens.output} ${cost} ${r.durationMs}ms run=${r.runId.slice(0, 8)}${detail}`;
  }
  if (r.type === "connector_send") {
    return `${ts} ${ok} ${r.type.padEnd(20)} ${r.agent ?? "?"} via=${r.connector} dest=${r.destination} ${r.messageBytes}b run=${r.runId.slice(0, 8)}${detail}`;
  }
  if (r.type === "connector_call") {
    const dest = r.destination ? ` dest=${r.destination}` : "";
    const thread = r.threadKey ? ` thread=${r.threadKey}` : "";
    return `${ts} ${ok} ${r.type.padEnd(20)} ${r.agent ?? "?"} via=${r.connector} cap=${r.capability}${dest}${thread} ${r.messageBytes}b run=${r.runId.slice(0, 8)}${detail}`;
  }
  // connector_receive
  return `${ts} ${ok} ${r.type.padEnd(20)} ${r.agent ?? "(unrouted)"} via=${r.connector} from=${r.fromUser ?? "?"} ${r.messageBytes}b run=${r.runId.slice(0, 8)}${detail}`;
}

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/;

function parseDurationToSinceIso(raw: string): string {
  const match = DURATION_RE.exec(raw.trim());
  if (!match) {
    // assume already an ISO string
    return raw;
  }
  const n = Number(match[1]);
  const unit = match[2];
  const seconds = unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
  return new Date(Date.now() - seconds * 1000).toISOString();
}
