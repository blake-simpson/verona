/**
 * `verona costs` — read-only rollup over the audit log.
 *
 * Subscription-covered (claude-cli) runs report tokens only — never an
 * estimated $. Metered (API-key) runs report real $ from the adapter.
 */

import path from "node:path";
import { AuditLog } from "../../core/audit-log.js";
import { buildRollup, formatRollup } from "../../core/cost-tracker.js";
import { resolveStateDir, statePaths } from "../../state/paths.js";

export interface CostsOptions {
  stateDir?: string;
}

export async function runCosts(opts: CostsOptions = {}): Promise<string> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);
  const log = new AuditLog({
    filePath: paths.invocations,
    rotatedDir: path.join(paths.logs, "invocations"),
  });
  const rollup = await buildRollup(log);
  if (rollup.total.invocations === 0) return "(no invocations recorded yet)";
  return formatRollup(rollup);
}
