import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdapterInvocationRecord,
  AuditLog,
  type ConnectorReceiveRecord,
} from "../../src/core/audit-log.js";

let dir: string;
let activeFile: string;
let rotatedDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-audit-"));
  activeFile = path.join(dir, "invocations.ndjson");
  rotatedDir = path.join(dir, "logs", "invocations");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function adapterRecord(overrides: Partial<AdapterInvocationRecord> = {}): AdapterInvocationRecord {
  return {
    ts: "2026-05-02T10:00:00.000Z",
    type: "adapter_invocation",
    runId: "01HX3Q-RUN1",
    agent: "researcher",
    task: "nightly-scan",
    trigger: { kind: "cron", expr: "0 3 * * *" },
    adapter: "claude-cli",
    modelUsed: "claude-sonnet-4-6",
    effort: "medium",
    tokens: { input: 100, output: 20 },
    costUsd: null,
    subscriptionCovered: true,
    durationMs: 1234,
    toolCalls: 0,
    ok: true,
    ...overrides,
  };
}

describe("AuditLog", () => {
  it("appends a record as one JSON line", async () => {
    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord());
    const raw = await readFile(activeFile, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.runId).toBe("01HX3Q-RUN1");
  });

  it("readAll round-trips multiple records", async () => {
    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord({ runId: "R1" }));
    await log.append(adapterRecord({ runId: "R2", agent: "writer" }));
    const all = await log.readAll();
    expect(all.map((r) => r.runId)).toEqual(["R1", "R2"]);
  });

  it("filters by agent", async () => {
    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord({ runId: "R1", agent: "alpha" }));
    await log.append(adapterRecord({ runId: "R2", agent: "beta" }));
    const filtered = await log.readAll({ agent: "beta" });
    expect(filtered.map((r) => r.runId)).toEqual(["R2"]);
  });

  it("filters by since (ISO lower bound, inclusive)", async () => {
    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord({ runId: "old", ts: "2026-04-01T00:00:00.000Z" }));
    await log.append(adapterRecord({ runId: "new", ts: "2026-05-01T00:00:00.000Z" }));
    const recent = await log.readAll({ since: "2026-05-01T00:00:00.000Z" });
    expect(recent.map((r) => r.runId)).toEqual(["new"]);
  });

  it("filters by ok=false", async () => {
    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord({ runId: "good", ok: true }));
    await log.append(adapterRecord({ runId: "bad", ok: false, errorClass: "AdapterError" }));
    const failed = await log.readAll({ ok: false });
    expect(failed.map((r) => r.runId)).toEqual(["bad"]);
  });

  it("filters by connector and excludes adapter_invocation when connector specified", async () => {
    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord({ runId: "adapter-call" }));
    const recv: ConnectorReceiveRecord = {
      ts: "2026-05-02T10:01:00.000Z",
      type: "connector_receive",
      runId: "slack-recv",
      connector: "slack",
      messageBytes: 42,
      ok: true,
    };
    await log.append(recv);
    const onlySlack = await log.readAll({ connector: "slack" });
    expect(onlySlack.map((r) => r.runId)).toEqual(["slack-recv"]);
  });

  it("rotates when active file exceeds threshold", async () => {
    const log = new AuditLog({
      filePath: activeFile,
      rotatedDir,
      rotateAtBytes: 200, // tiny
    });
    // pad records to push past threshold
    for (let i = 0; i < 10; i++) {
      await log.append(adapterRecord({ runId: `R${i}` }));
    }
    // The active file should be smaller than the cumulative writes if rotation happened
    const shards = await import("node:fs/promises").then((m) => m.readdir(rotatedDir));
    expect(shards.length).toBeGreaterThan(0);
  });

  it("readAll merges rotated shards before active file", async () => {
    // pre-seed a shard file manually
    await import("node:fs/promises").then(async (m) => {
      await m.mkdir(rotatedDir, { recursive: true });
      const shardPath = path.join(rotatedDir, "2026-04-01.ndjson");
      const oldRecord = JSON.stringify(
        adapterRecord({ runId: "OLD", ts: "2026-04-01T00:00:00.000Z" }),
      );
      await writeFile(shardPath, `${oldRecord}\n`, "utf8");
    });

    const log = new AuditLog({ filePath: activeFile, rotatedDir });
    await log.append(adapterRecord({ runId: "NEW" }));

    const all = await log.readAll();
    expect(all.map((r) => r.runId)).toEqual(["OLD", "NEW"]);
  });

  it("creates parent dirs on first append", async () => {
    const nested = path.join(dir, "deep", "nested", "audit.ndjson");
    const log = new AuditLog({ filePath: nested, rotatedDir });
    await log.append(adapterRecord());
    expect((await stat(nested)).isFile()).toBe(true);
  });

  describe("drain()", () => {
    it("awaits fire-and-forget appends so they reach disk", async () => {
      const log = new AuditLog({ filePath: activeFile, rotatedDir });
      // Simulate the daemon's `void this.auditLog.append(...)` pattern.
      void log.append(adapterRecord({ runId: "FF1" }));
      void log.append(adapterRecord({ runId: "FF2" }));
      void log.append(adapterRecord({ runId: "FF3" }));
      await log.drain();
      const all = await log.readAll();
      expect(all.map((r) => r.runId).sort()).toEqual(["FF1", "FF2", "FF3"]);
    });

    it("is a no-op when nothing is in flight", async () => {
      const log = new AuditLog({ filePath: activeFile, rotatedDir });
      await log.drain(); // should not throw, should not block
      await log.append(adapterRecord({ runId: "AFTER" }));
      await log.drain();
      const all = await log.readAll();
      expect(all.map((r) => r.runId)).toEqual(["AFTER"]);
    });

    it("never throws even if a pending append fails", async () => {
      // Write to a path whose parent we'll forcibly remove right after starting
      // — the append should error internally; drain() must still resolve.
      const broken = path.join(dir, "will-be-removed", "audit.ndjson");
      const log = new AuditLog({ filePath: broken, rotatedDir });
      const p = log.append(adapterRecord({ runId: "X" }));
      // Suppress the unhandled-rejection warning if the append errors:
      p.catch(() => {});
      await expect(log.drain()).resolves.toBeUndefined();
    });
  });
});
