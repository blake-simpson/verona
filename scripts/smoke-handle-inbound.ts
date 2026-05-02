#!/usr/bin/env node
/**
 * One-shot smoke test for daemon.handleInbound() against the REAL claude
 * binary. No Slack tokens needed — the daemon's bootstrapConnectors() will
 * skip Slack since secrets aren't set, but handleInbound() can still be
 * called programmatically.
 *
 *   npx tsx scripts/smoke-handle-inbound.ts
 *
 * Verifies: an inbound message with no `on_message` task on the agent still
 * dispatches a synthetic "reply" run, the agent responds, and the audit log
 * captures the chain.
 */

import { ulid } from "ulidx";
import type { InboundEvent } from "../src/connectors/connector.js";
import { Daemon } from "../src/core/daemon.js";

const stateDir = process.env.VERONA_STATE_DIR ?? `${process.env.HOME}/.verona/state`;
const daemon = new Daemon({ stateDir });
await daemon.bootstrap();

const before = (await daemon.audit().readAll({ type: "adapter_invocation", agent: "hello-world" }))
  .length;

const event: InboundEvent = {
  connectorId: "smoke-test",
  runId: ulid(),
  agentTarget: "hello-world",
  text: "Hello hello-world. Reply with a single short sentence including the current ISO timestamp. No tool use needed.",
  raw: {},
};

const startedAt = Date.now();
await daemon.handleInbound(event);
const elapsedMs = Date.now() - startedAt;

const after = await daemon.audit().readAll({ type: "adapter_invocation", agent: "hello-world" });
const newRecord = after[after.length - 1];
const beforeMatch = after.length === before + 1;

console.log(`elapsed: ${elapsedMs}ms`);
console.log(`audit records added: ${after.length - before} (expected 1)`);
if (newRecord && beforeMatch) {
  console.log(
    `task: ${newRecord.type === "adapter_invocation" ? newRecord.task : "?"}  (expected "reply")`,
  );
  console.log(`runId match: ${newRecord.runId === event.runId} (expected true)`);
  if (newRecord.type === "adapter_invocation") {
    console.log(`tokens: in=${newRecord.tokens.input} out=${newRecord.tokens.output}`);
    console.log(`subscriptionCovered: ${newRecord.subscriptionCovered}`);
  }
}
await daemon.stop();
