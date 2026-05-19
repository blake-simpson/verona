/**
 * Generates the per-task `--settings` JSON file passed to `claude -p`, plus
 * (optionally) the connector policy file consumed by connector-guard.sh.
 *
 * Three PreToolUse hooks are wired:
 *   1. matcher "Write|Edit"           → memory-guard.sh   (FS write boundary)
 *   2. matcher "Bash"                 → bash-guard.sh     (command boundary)
 *   3. matcher "mcp__verona__.*"      → connector-guard.sh (Layer A gating)
 *
 * Workers run under --permission-mode bypassPermissions (the interactive
 * prompt can't be answered headlessly), so these hooks ARE the boundary, not
 * a backstop. We always wire all three even when a given matcher won't fire
 * for this agent — the matcher is cheap and a safety net against
 * misconfigured spawns.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface HookSettingsRenderInput {
  /** Absolute path to memory-guard.sh on this host. */
  guardScriptPath: string;
  /** Absolute path to connector-guard.sh on this host. */
  connectorGuardScriptPath: string;
  /** Absolute path to bash-guard.sh on this host. */
  bashGuardScriptPath: string;
  /** Where to write the settings file. The adapter passes this to --settings. */
  outputPath: string;
}

export async function renderHookSettings(input: HookSettingsRenderInput): Promise<void> {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [
            {
              type: "command",
              command: input.guardScriptPath,
            },
          ],
        },
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: input.bashGuardScriptPath,
            },
          ],
        },
        {
          matcher: "mcp__verona__.*",
          hooks: [
            {
              type: "command",
              command: input.connectorGuardScriptPath,
            },
          ],
        },
      ],
    },
  };

  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Per-connector policy consumed by connector-guard.sh.
 *
 *   channels         — Slack-only destination allowlist (Layer A).
 *   allow_destructive— Whether the agent has opted in to destructive
 *                      capabilities for this connector (Phase 5 Layer B).
 *   capabilities     — Per-capability metadata used by the hook to decide
 *                      whether a call needs the allow_destructive flag.
 */
export interface ConnectorPolicyEntry {
  channels?: readonly string[];
  allow_destructive?: boolean;
  capabilities?: Readonly<Record<string, { sideEffect: "read" | "write" | "destructive" }>>;
}

export type ConnectorPolicy = Readonly<Record<string, ConnectorPolicyEntry>>;

export interface ConnectorPolicyRenderInput {
  outputPath: string;
  policy: ConnectorPolicy;
}

export async function renderConnectorPolicy(input: ConnectorPolicyRenderInput): Promise<void> {
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, JSON.stringify(input.policy, null, 2), "utf8");
}
