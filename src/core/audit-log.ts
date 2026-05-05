/**
 * AuditLog — append-only NDJSON record of every adapter and connector call.
 *
 * Path: <state>/invocations.ndjson
 * Each line is one JSON record (see schemas below). Joined by `runId` so a
 * task run's connector_receive → adapter_invocation → connector_send chain
 * can be reconstructed.
 *
 * Rotation: when the active file exceeds `rotateAtBytes` it's renamed into
 * `<state>/logs/invocations/YYYY-MM-DD.ndjson` and a new active file starts.
 *
 * See knowledge/architecture/observability is documented in the plan + this file.
 */

import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AdapterId, AdapterTokenUsage, Effort } from "../adapters/adapter.js";

export type AuditRecordType =
  | "adapter_invocation"
  | "connector_send"
  | "connector_receive"
  | "connector_call";

interface AuditRecordBase {
  ts: string;
  type: AuditRecordType;
  runId: string;
  agent?: string;
  ok: boolean;
  errorClass?: string;
}

export interface AdapterInvocationRecord extends AuditRecordBase {
  type: "adapter_invocation";
  agent: string;
  task: string;
  trigger: { kind: "cron"; expr: string } | { kind: "manual" } | { kind: "message"; from: string };
  adapter: AdapterId;
  modelUsed: string;
  effort: Effort;
  tokens: AdapterTokenUsage;
  costUsd: number | null;
  subscriptionCovered: boolean;
  durationMs: number;
  toolCalls: number;
}

export interface ConnectorSendRecord extends AuditRecordBase {
  type: "connector_send";
  connector: string;
  destination: string;
  threadKey?: string;
  messageBytes: number;
}

export interface ConnectorReceiveRecord extends AuditRecordBase {
  type: "connector_receive";
  connector: string;
  fromUser?: string;
  threadKey?: string;
  messageBytes: number;
}

/**
 * Agent-driven outbound: one record per `mcp__verona__<connector>__<capability>`
 * tool call. Joined to the parent `adapter_invocation` by runId.
 *
 * Distinct from `connector_send`, which is the system's daemon-side outbound
 * (legacy auto-post, daemon notifications). `connector_call` means the agent
 * itself decided to invoke the capability.
 */
export interface ConnectorCallRecord extends AuditRecordBase {
  type: "connector_call";
  connector: string;
  capability: string;
  destination?: string;
  threadKey?: string;
  messageBytes: number;
}

export type AuditRecord =
  | AdapterInvocationRecord
  | ConnectorSendRecord
  | ConnectorReceiveRecord
  | ConnectorCallRecord;

export interface AuditLogInit {
  /** Active log file path, e.g. <state>/invocations.ndjson */
  filePath: string;
  /** Where rotated shards go: <state>/logs/invocations/. */
  rotatedDir: string;
  /** Bytes — when active file exceeds, rotate. Default 50 MB. */
  rotateAtBytes?: number;
}

export class AuditLog {
  private readonly filePath: string;
  private readonly rotatedDir: string;
  private readonly rotateAtBytes: number;
  /**
   * In-flight `append()` promises. Tracked so callers that fire-and-forget
   * (`void log.append(...)`) can still be drained before process exit. Each
   * entry self-evicts via the .finally() in `append()`, so this list stays
   * proportional to current concurrency, not lifetime call count.
   */
  private readonly pending: Set<Promise<void>> = new Set();

  constructor(init: AuditLogInit) {
    this.filePath = init.filePath;
    this.rotatedDir = init.rotatedDir;
    this.rotateAtBytes = init.rotateAtBytes ?? 50 * 1024 * 1024;
  }

  async append(record: AuditRecord): Promise<void> {
    const p = this.doAppend(record);
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {
      /* swallow — caller awaiting `p` directly will see the error */
    });
    await p;
  }

  private async doAppend(record: AuditRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.maybeRotate();
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(this.filePath, line, "utf8");
  }

  /**
   * Await every in-flight append(), including fire-and-forget ones from
   * `void log.append(...)` callers. Used by Daemon.stop() so the CLI's
   * `process.exit()` doesn't drop records that were dispatched but not
   * yet flushed to disk. Always resolves; never throws.
   */
  async drain(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.allSettled(this.pending);
  }

  /**
   * Stream all records, optionally filtered. Reads the active file plus all
   * rotated shards (chronologically: oldest shard first, newest last).
   */
  async *iterate(filter?: AuditFilter): AsyncGenerator<AuditRecord> {
    const sources: string[] = [];
    try {
      const shards = await import("node:fs/promises").then((m) =>
        m.readdir(this.rotatedDir).catch(() => [] as string[]),
      );
      shards.sort();
      for (const s of shards) sources.push(path.join(this.rotatedDir, s));
    } catch {
      // ignore — rotated dir may not exist
    }
    sources.push(this.filePath);

    for (const file of sources) {
      let exists = false;
      try {
        await stat(file);
        exists = true;
      } catch {
        // skip missing
      }
      if (!exists) continue;

      const stream = createReadStream(file, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let record: AuditRecord;
        try {
          record = JSON.parse(line) as AuditRecord;
        } catch {
          continue; // skip malformed lines
        }
        if (filter && !matchesFilter(record, filter)) continue;
        yield record;
      }
    }
  }

  async readAll(filter?: AuditFilter): Promise<AuditRecord[]> {
    const out: AuditRecord[] = [];
    for await (const r of this.iterate(filter)) out.push(r);
    return out;
  }

  private async maybeRotate(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return;
    }
    if (size < this.rotateAtBytes) return;

    await mkdir(this.rotatedDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    let target = path.join(this.rotatedDir, `${stamp}.ndjson`);
    let n = 1;
    while (await pathExists(target)) {
      target = path.join(this.rotatedDir, `${stamp}-${n}.ndjson`);
      n += 1;
    }
    await rename(this.filePath, target);
  }
}

export interface AuditFilter {
  type?: AuditRecordType;
  agent?: string;
  task?: string;
  connector?: string;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (exclusive). */
  until?: string;
  ok?: boolean;
}

function matchesFilter(r: AuditRecord, f: AuditFilter): boolean {
  if (f.type && r.type !== f.type) return false;
  if (f.agent && r.agent !== f.agent) return false;
  if (f.task && r.type === "adapter_invocation" && r.task !== f.task) return false;
  if (f.task && r.type !== "adapter_invocation") return false;
  if (f.connector) {
    if (r.type === "adapter_invocation") return false;
    // ConnectorSend/Receive/Call all carry `connector` field
    if (r.connector !== f.connector) return false;
  }
  if (f.since && r.ts < f.since) return false;
  if (f.until && r.ts >= f.until) return false;
  if (f.ok !== undefined && r.ok !== f.ok) return false;
  return true;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
