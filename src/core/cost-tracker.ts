/**
 * Cost tracker — rolls up per-agent / per-adapter / per-month totals from the
 * audit log. The rollups are regenerable (read-only views over invocations.ndjson),
 * not authoritative state.
 *
 * Reporting nuance: claude-cli is subscription-covered, so we report tokens
 * but not $. API-key adapters report real $. Don't conflate.
 */

import type { AdapterId } from "../adapters/adapter.js";
import type { AuditLog } from "./audit-log.js";

export interface CostBucket {
  invocations: number;
  tokensInput: number;
  tokensOutput: number;
  /** Sum of $ for metered (API-key) adapter calls. */
  meteredUsd: number;
  /** Count of subscription-covered (claude-cli) calls (no $ to sum). */
  subscriptionInvocations: number;
}

export interface CostRollup {
  total: CostBucket;
  byAgent: Record<string, CostBucket>;
  byAdapter: Partial<Record<AdapterId, CostBucket>>;
  byMonth: Record<string, CostBucket>; // "YYYY-MM"
}

const emptyBucket = (): CostBucket => ({
  invocations: 0,
  tokensInput: 0,
  tokensOutput: 0,
  meteredUsd: 0,
  subscriptionInvocations: 0,
});

export async function buildRollup(log: AuditLog): Promise<CostRollup> {
  const rollup: CostRollup = {
    total: emptyBucket(),
    byAgent: {},
    byAdapter: {},
    byMonth: {},
  };

  for await (const r of log.iterate({ type: "adapter_invocation" })) {
    if (r.type !== "adapter_invocation") continue;
    const month = r.ts.slice(0, 7);
    const buckets = [
      rollup.total,
      bucket(rollup.byAgent, r.agent),
      bucketAdapter(rollup.byAdapter, r.adapter),
      bucket(rollup.byMonth, month),
    ];
    for (const b of buckets) {
      b.invocations += 1;
      b.tokensInput += r.tokens.input;
      b.tokensOutput += r.tokens.output;
      if (r.subscriptionCovered) {
        b.subscriptionInvocations += 1;
      } else if (typeof r.costUsd === "number") {
        b.meteredUsd += r.costUsd;
      }
    }
  }

  return rollup;
}

function bucket(rec: Record<string, CostBucket>, key: string): CostBucket {
  let b = rec[key];
  if (!b) {
    b = emptyBucket();
    rec[key] = b;
  }
  return b;
}

function bucketAdapter(rec: Partial<Record<AdapterId, CostBucket>>, key: AdapterId): CostBucket {
  let b = rec[key];
  if (!b) {
    b = emptyBucket();
    rec[key] = b;
  }
  return b;
}

export function formatBucket(label: string, b: CostBucket): string {
  const tokens = `tokens in/out: ${b.tokensInput.toLocaleString()} / ${b.tokensOutput.toLocaleString()}`;
  const metered = b.meteredUsd > 0 ? `metered: $${b.meteredUsd.toFixed(4)}` : null;
  const sub =
    b.subscriptionInvocations > 0 ? `subscription: ${b.subscriptionInvocations} runs` : null;
  const parts = [label, `${b.invocations} invocations`, tokens, metered, sub].filter(Boolean);
  return parts.join("  |  ");
}

export function formatRollup(rollup: CostRollup): string {
  const lines: string[] = [];
  lines.push(formatBucket("ALL TIME", rollup.total));
  lines.push("");
  lines.push("By agent:");
  for (const [agent, b] of Object.entries(rollup.byAgent)) {
    lines.push(`  ${formatBucket(agent, b)}`);
  }
  if (Object.keys(rollup.byAdapter).length > 0) {
    lines.push("");
    lines.push("By adapter:");
    for (const [adapter, b] of Object.entries(rollup.byAdapter)) {
      if (b) lines.push(`  ${formatBucket(adapter, b)}`);
    }
  }
  if (Object.keys(rollup.byMonth).length > 0) {
    lines.push("");
    lines.push("By month:");
    const months = Object.keys(rollup.byMonth).sort();
    for (const m of months) {
      const b = rollup.byMonth[m];
      if (b) lines.push(`  ${formatBucket(m, b)}`);
    }
  }
  return lines.join("\n");
}
