/**
 * Session store — persists `claude -p` session IDs keyed by (agent, threadKey)
 * so a Slack thread reply (or other inbound continuation) resumes the same
 * conversation via `claude -p --resume <session-id>`.
 *
 * One JSON file per agent: <state>/sessions/<agent>.json
 * Schema: { [threadKey]: { sessionId, lastUsedAt } }
 *
 * threadKey is connector-defined (e.g. Slack thread_ts). For cron-triggered
 * runs that don't continue, the key can be a synthetic per-run ULID or omitted.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface SessionFile {
  [threadKey: string]: { sessionId: string; lastUsedAt: string };
}

export interface SessionStoreInit {
  /** Absolute path to <state>/sessions. */
  sessionsDir: string;
}

export class SessionStore {
  private readonly dir: string;

  constructor(init: SessionStoreInit) {
    this.dir = init.sessionsDir;
  }

  async getSession(agentName: string, threadKey: string): Promise<string | null> {
    const file = await this.read(agentName);
    return file[threadKey]?.sessionId ?? null;
  }

  async setSession(agentName: string, threadKey: string, sessionId: string): Promise<void> {
    const file = await this.read(agentName);
    file[threadKey] = { sessionId, lastUsedAt: new Date().toISOString() };
    await this.write(agentName, file);
  }

  async forgetSession(agentName: string, threadKey: string): Promise<void> {
    const file = await this.read(agentName);
    if (!(threadKey in file)) return;
    delete file[threadKey];
    await this.write(agentName, file);
  }

  /**
   * Cross-agent lookup: which agent (if any) has anchored this threadKey?
   * Used by the inbound dispatch path for thread replies that don't @-mention
   * the bot — Slack only tells us the parent message's thread_ts; we ask the
   * SessionStore "who anchored this?" and route there.
   *
   * Scans every <state>/sessions/<agent>.json. v1 acceptable: N agents per host
   * is small. If this becomes a hot path, build an in-memory reverse index.
   */
  async findByThreadKey(
    threadKey: string,
  ): Promise<{ agentName: string; sessionId: string } | null> {
    let entries: string[];
    try {
      entries = (await readdir(this.dir)) as string[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const agentName = name.slice(0, -".json".length);
      const file = await this.read(agentName);
      const entry = file[threadKey];
      if (entry) return { agentName, sessionId: entry.sessionId };
    }
    return null;
  }

  private filePath(agentName: string): string {
    return path.join(this.dir, `${agentName}.json`);
  }

  private async read(agentName: string): Promise<SessionFile> {
    try {
      const raw = await readFile(this.filePath(agentName), "utf8");
      return JSON.parse(raw) as SessionFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  private async write(agentName: string, file: SessionFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(agentName), JSON.stringify(file, null, 2), "utf8");
  }
}
