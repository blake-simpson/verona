import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnchorStore, CallsLog } from "../../src/mcp/anchor-store.js";

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), "verona-runs-"));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

describe("AnchorStore", () => {
  it("returns [] when no anchors have been written", async () => {
    const store = new AnchorStore(runDir);
    expect(await store.drain()).toEqual([]);
  });

  it("round-trips appended records", async () => {
    const store = new AnchorStore(runDir);
    await store.append({
      threadKey: "T1",
      connectorId: "slack",
      capability: "send_message",
      ts: "2026-05-05T18:00:00Z",
    });
    await store.append({
      threadKey: "T2",
      connectorId: "slack",
      capability: "send_message",
      ts: "2026-05-05T18:01:00Z",
    });
    const records = await store.drain();
    expect(records).toHaveLength(2);
    expect(records[0]?.threadKey).toBe("T1");
    expect(records[1]?.threadKey).toBe("T2");
  });

  it("skips malformed lines and entries missing required fields", async () => {
    const store = new AnchorStore(runDir);
    await store.append({
      threadKey: "OK",
      connectorId: "slack",
      capability: "send_message",
      ts: "2026-05-05T18:00:00Z",
    });
    // Manually inject a bad line.
    const fs = await import("node:fs/promises");
    await fs.appendFile(path.join(runDir, "anchors.ndjson"), "{not-json}\n");
    await fs.appendFile(
      path.join(runDir, "anchors.ndjson"),
      `${JSON.stringify({ threadKey: 7 })}\n`,
    );
    const records = await store.drain();
    expect(records).toHaveLength(1);
    expect(records[0]?.threadKey).toBe("OK");
  });
});

describe("CallsLog", () => {
  it("returns [] when no calls have been written", async () => {
    const log = new CallsLog(runDir);
    expect(await log.drain()).toEqual([]);
  });

  it("round-trips appended call records", async () => {
    const log = new CallsLog(runDir);
    await log.append({
      connectorId: "slack",
      capability: "send_message",
      ts: "2026-05-05T18:00:00Z",
    });
    await log.append({
      connectorId: "quickbooks",
      capability: "create_transaction",
      ts: "2026-05-05T18:00:01Z",
    });
    const records = await log.drain();
    expect(records.map((r) => r.connectorId)).toEqual(["slack", "quickbooks"]);
    expect(records.map((r) => r.capability)).toEqual(["send_message", "create_transaction"]);
  });
});
