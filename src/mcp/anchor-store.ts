/**
 * AnchorStore + CallsLog — per-run append-only NDJSON files used as the IPC
 * channel between the spawn-side MCP server and the daemon.
 *
 * When a capability succeeds with a `threadKey`, the MCP server appends a line
 * here. After `claude` exits, the dispatcher reads the file and, for each
 * record, calls SessionStore.setSession(agent, threadKey, response.sessionId)
 * — registering the future inbound thread for session resume.
 *
 * Why a file instead of a socket: keeps SessionStore writes serialised in the
 * daemon (single writer); needs no port allocation; survives spawn crash for
 * post-mortem; per-run scope means no cross-spawn locking.
 *
 * Crash recovery: orphan dirs older than TTL are dropped on daemon startup
 * (see Daemon.recoverStaleRunDirs). An anchor whose owning spawn never
 * returned a sessionId never reaches SessionStore — correct, because the
 * user replying to that orphan thread should get a fresh session.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AnchorRecord {
  /** Stable conversation key the inbound side will use for lookup. */
  threadKey: string;
  /** Connector id that produced the anchor. Diagnostic only. */
  connectorId: string;
  /** Capability name that produced it. Diagnostic only. */
  capability: string;
  /** ISO timestamp of the anchor write. */
  ts: string;
}

export class AnchorStore {
  private readonly filePath: string;

  /**
   * @param runDir per-run scratch dir, e.g. <state>/runs/<runId>/
   */
  constructor(runDir: string) {
    this.filePath = path.join(runDir, "anchors.ndjson");
  }

  /** Append a single anchor record. Creates the directory if needed. */
  async append(record: AnchorRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(this.filePath, line, "utf8");
  }

  /**
   * Drain — return every record written so far. Returns [] if the file does
   * not exist (no anchors were written this run). Does not delete the file;
   * the dispatcher cleans the run dir as a whole after draining.
   */
  async drain(): Promise<AnchorRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AnchorRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AnchorRecord;
        if (
          parsed &&
          typeof parsed.threadKey === "string" &&
          typeof parsed.connectorId === "string"
        ) {
          out.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return out;
  }
}

export interface CallRecord {
  /** Connector id whose capability was invoked. */
  connectorId: string;
  /** Capability name (without the connector prefix). */
  capability: string;
  /** ISO timestamp. */
  ts: string;
}

/**
 * CallsLog — per-run record of every successful capability invocation.
 *
 * Written by the spawn-side MCP server after each tool-call success; read
 * synchronously by the dispatcher post-spawn. Parallel sink to the daemon's
 * audit log: the audit log is the canonical record (long-lived, joinable
 * across runs by runId), this file exists so the dispatcher can answer "did
 * the agent invoke any tool from connector X during this run?" without
 * scanning the entire audit NDJSON.
 *
 * Used by Daemon.handleInbound to suppress the legacy auto-post when the
 * agent already spoke for itself via a capability.
 */
export class CallsLog {
  private readonly filePath: string;

  constructor(runDir: string) {
    this.filePath = path.join(runDir, "calls.ndjson");
  }

  async append(record: CallRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(this.filePath, line, "utf8");
  }

  async drain(): Promise<CallRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: CallRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CallRecord;
        if (
          parsed &&
          typeof parsed.connectorId === "string" &&
          typeof parsed.capability === "string"
        ) {
          out.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return out;
  }
}
