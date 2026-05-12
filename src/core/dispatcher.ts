/**
 * Dispatcher — orchestrates a single task run.
 *
 *   load memory  →  build hook settings  →  invoke adapter  →  write episodic log
 *
 * In M1 this is offline (called directly from a CLI command or test); in M3
 * the daemon's scheduler / connectors will call it. Audit logging (M4) and
 * git committing (M2) hook in here.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulidx";
import type { AIAdapter, AdapterRequest, AdapterResponse, Effort } from "../adapters/adapter.js";
import type { ConnectorCapability } from "../connectors/capability.js";
import {
  type ConnectorPolicy,
  renderConnectorPolicy,
  renderHookSettings,
} from "../hooks/render-hook-settings.js";
import { AnchorStore, CallsLog } from "../mcp/anchor-store.js";
import { veronaMcpServerScriptPath } from "../mcp/locate.js";
import {
  type SpawnSubscription,
  encodeSubscriptions,
  renderSpawnConfig,
} from "../mcp/spawn-config.js";
import { getBuiltInSpawnFactory } from "../mcp/spawn-factories.js";
import { ConfigError } from "../util/errors.js";
import type { AdapterInvocationRecord, AuditLog } from "./audit-log.js";
import { loadMemory } from "./memory-loader.js";
import { writeEpisodicLog } from "./memory-writer.js";
import type { SessionStore } from "./session-store.js";
import { stageSkills } from "./skill-loader.js";

export interface DispatchTrigger {
  kind: "manual" | "cron" | "message";
  /** For cron: the cron expression. For message: the originating user. */
  detail?: string;
}

export interface DispatchInput {
  agentDir: string;
  agentName: string;
  taskId: string;
  /**
   * Path to the task prompt template (relative to agentDir or absolute).
   * Optional: omit for inbound-message dispatches where the user's message is
   * the entire prompt and no static task body applies (e.g. a Slack thread reply
   * resuming the original session).
   */
  promptPath?: string;
  /** Optional per-task user prompt overlay (e.g. Slack message text). */
  userMessage?: string;
  /**
   * Files the inbound user attached (e.g. Slack uploads). The connector has
   * already downloaded them into <runDir>/inbound/. The dispatcher prepends a
   * manifest to the user prompt so the agent knows where to read each file.
   */
  attachments?: ReadonlyArray<{
    filename: string;
    localPath: string;
    mimeType?: string;
    size: number;
  }>;
  effort: Effort;
  budgetUsd?: number;
  allowedTools?: readonly string[];
  /** Existing session to resume; omitted for a fresh conversation. */
  sessionId?: string;
  trigger: DispatchTrigger;
  adapter: AIAdapter;
  /**
   * Path to memory-guard.sh on this host. Set by daemon/CLI; tests provide a
   * fixture path.
   */
  guardScriptPath: string;
  /**
   * Path to connector-guard.sh on this host. Wired alongside memory-guard
   * so `mcp__verona__*` tool calls are gated by the per-run policy file.
   * Required when `subscriptions` is non-empty; harmless when omitted.
   */
  connectorGuardScriptPath?: string;
  /** Working dir for hook settings + temp files. Defaults to <agentDir>/.verona-tmp. */
  scratchDir?: string;
  /** Caller-controlled cancellation. */
  cancel?: AbortSignal;
  /** Optional. When provided, dispatcher writes an adapter_invocation record per run. */
  auditLog?: AuditLog;
  /**
   * If provided, the dispatcher uses this runId instead of generating one.
   * Used by the daemon's connector inbound flow so the connector_receive
   * record and the adapter_invocation record share the same runId for joining.
   */
  runId?: string;
  /**
   * Connector subscriptions to expose to the agent as MCP tools. Built by the
   * daemon from the agent's `[connectors.<id>]` blocks plus resolved secrets.
   * When non-empty, the dispatcher renders a per-task MCP config and points
   * the adapter at it. When empty, no `--mcp-config` is passed.
   */
  subscriptions?: readonly SpawnSubscription[];
  /**
   * Per-state runs dir, i.e. <state>/runs/. The dispatcher creates a
   * <runs>/<runId>/ scratch dir per task that hosts the rendered MCP config,
   * the connector policy file, the anchors NDJSON, and any inbound
   * attachments. Required when `subscriptions` is non-empty.
   */
  runsDir?: string;
  /**
   * Path to the daemon's audit log file. Passed to the spawn-side MCP server
   * via env so its `connector_call` records land in the same NDJSON. Required
   * when `subscriptions` is non-empty.
   */
  auditLogPath?: string;
  /**
   * <state>/. Passed to the spawn-side MCP server so it can resolve relative
   * subdirs (rotated audit-log shards, secrets). Required when
   * `subscriptions` is non-empty.
   */
  stateDir?: string;
  /**
   * SessionStore used to register thread anchors after the spawn returns.
   * If provided, the dispatcher reads <runDir>/anchors.ndjson and writes
   * (agent, threadKey) → response.sessionId entries.
   */
  sessionStore?: SessionStore;
  /**
   * Names of skills declared in agent.toml's [agent].skills. When non-empty,
   * the dispatcher creates a runDir, symlinks each skill into
   * `<runDir>/.claude/skills/<name>`, and sets the adapter's cwd to runDir so
   * `claude -p` discovers them as project-local skills.
   */
  skills?: readonly string[];
  /**
   * Canonical skills root, e.g. `~/.verona/user/skills/`. Required when
   * `skills` is non-empty. The daemon resolves this via `resolveSkillsDir()`.
   */
  skillsDir?: string;
}

export interface DispatchResult {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  response: AdapterResponse;
  episodicLogPath: string;
  /**
   * Set of connector ids the agent invoked at least one capability against
   * during this run. Built from the per-run calls.ndjson written by the MCP
   * server. Used by `Daemon.handleInbound` to suppress legacy auto-post when
   * the agent already spoke for itself via a tool call.
   *
   * Empty when the agent had no subscriptions or made no tool calls.
   */
  connectorIdsCalled: ReadonlySet<string>;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const runId = input.runId ?? ulid();
  const startedAt = new Date();

  const skills = input.skills ?? [];

  const memory = await loadMemory({
    agentDir: input.agentDir,
    agentName: input.agentName,
    taskId: input.taskId,
    skills,
  });

  const userPrompt = await composeUserPrompt({
    agentDir: input.agentDir,
    ...(input.promptPath !== undefined && { promptPath: input.promptPath }),
    ...(input.userMessage !== undefined && { userMessage: input.userMessage }),
    ...(input.attachments &&
      input.attachments.length > 0 && {
        attachments: input.attachments,
      }),
  });

  const scratch = input.scratchDir ?? path.join(input.agentDir, ".verona-tmp");
  await mkdir(scratch, { recursive: true });
  const hookSettingsPath = path.join(scratch, `hook-settings-${runId}.json`);
  // The connector-guard hook is wired regardless; if subscriptions are empty
  // it will never match. When required (subs present) the daemon supplies a
  // real script path; tests can omit and we fall back to a no-op stub path.
  const connectorGuardScriptPath = input.connectorGuardScriptPath ?? input.guardScriptPath;
  await renderHookSettings({
    guardScriptPath: input.guardScriptPath,
    connectorGuardScriptPath,
    outputPath: hookSettingsPath,
  });

  // If the agent has connector subscriptions, render a per-run MCP config so
  // the agent can invoke `mcp__verona__<connector>__<capability>` tools.
  // Otherwise the spawn behaves like before — no MCP server, no tool plane.
  // A runDir is also created when skills are declared, so they can be
  // symlinked into <runDir>/.claude/skills/ for `claude -p` to discover.
  let mcpConfigPath: string | undefined;
  let runDir: string | undefined;
  let connectorPolicyPath: string | undefined;
  const hasSubs = (input.subscriptions?.length ?? 0) > 0;
  const hasSkills = skills.length > 0;
  if (hasSubs || hasSkills) {
    if (!input.runsDir) {
      throw new ConfigError(
        "dispatch: runDir required for subscriptions or skills (daemon should provide runsDir)",
      );
    }
    runDir = path.join(input.runsDir, runId);
    await mkdir(runDir, { recursive: true });
  }
  if (hasSubs) {
    if (!input.auditLogPath || !input.stateDir || !runDir) {
      throw new ConfigError(
        "dispatch: subscriptions require auditLogPath + stateDir (daemon should provide them)",
      );
    }
    mcpConfigPath = path.join(runDir, "mcp-config.json");
    await renderSpawnConfig({
      outputPath: mcpConfigPath,
      serverScriptPath: veronaMcpServerScriptPath(),
      env: {
        agent: input.agentName,
        runId,
        agentDir: input.agentDir,
        runDir,
        stateDir: input.stateDir,
        auditLogPath: input.auditLogPath,
        subscriptionsJson: encodeSubscriptions(input.subscriptions ?? []),
      },
    });

    connectorPolicyPath = path.join(runDir, "connector-policy.json");
    await renderConnectorPolicy({
      outputPath: connectorPolicyPath,
      policy: buildConnectorPolicy(input.subscriptions ?? []),
    });
  }

  if (hasSkills) {
    if (!input.skillsDir || !runDir) {
      throw new ConfigError(
        "dispatch: skills require skillsDir (daemon should provide resolveSkillsDir())",
      );
    }
    await stageSkills({ skills, skillsDir: input.skillsDir, runDir });
  }

  // Extend allowedTools so the agent can call its MCP-exposed verona tools.
  // The model needs `mcp__verona__*` (or specific names) in its allowlist;
  // we add the wildcard alongside whatever the task already declared.
  const baseAllowed = input.allowedTools ?? [];
  const allowedTools = hasSubs ? [...baseAllowed, "mcp__verona__*"] : baseAllowed;

  const adapterRequest: AdapterRequest = {
    agentName: input.agentName,
    taskId: input.taskId,
    systemPrompt: memory.systemPrompt,
    userPrompt,
    effort: input.effort,
    workingDir: input.agentDir,
    hookSettingsPath,
    cancel: input.cancel ?? new AbortController().signal,
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    ...(input.budgetUsd !== undefined && { budgetUsd: input.budgetUsd }),
    ...(allowedTools.length > 0 && { allowedTools }),
    ...(mcpConfigPath !== undefined && { mcpConfigPath }),
    ...(runDir !== undefined && { runDir }),
    ...(connectorPolicyPath !== undefined && { connectorPolicyPath }),
    // When skills are staged, set cwd so `claude -p` discovers
    // <runDir>/.claude/skills/ as project-local. No-op when runDir is unset.
    ...(hasSkills && runDir !== undefined && { cwd: runDir }),
  };

  let response: AdapterResponse;
  let auditError: { class: string } | null = null;
  try {
    response = await input.adapter.invoke(adapterRequest);
  } catch (err) {
    if (input.auditLog) {
      const failedRecord: AdapterInvocationRecord = {
        ts: startedAt.toISOString(),
        type: "adapter_invocation",
        runId,
        agent: input.agentName,
        task: input.taskId,
        trigger: triggerForRecord(input.trigger),
        adapter: input.adapter.id,
        modelUsed: "(unknown)",
        effort: input.effort,
        tokens: { input: 0, output: 0 },
        costUsd: null,
        subscriptionCovered: false,
        durationMs: Date.now() - startedAt.getTime(),
        toolCalls: 0,
        ok: false,
        errorClass: err instanceof Error ? err.name : "Error",
      };
      await input.auditLog.append(failedRecord);
    }
    auditError = { class: err instanceof Error ? err.name : "Error" };
    throw err;
  } finally {
    void auditError;
  }
  const finishedAt = new Date();

  // Drain anchors written by the per-spawn MCP server's ctx.anchorThread()
  // calls and persist them to SessionStore. The spawn cannot write to the
  // SessionStore directly (single-writer invariant); the dispatcher does it
  // here, with response.sessionId in hand.
  if (runDir && input.sessionStore && response.sessionId) {
    const anchors = await new AnchorStore(runDir).drain();
    for (const a of anchors) {
      try {
        await input.sessionStore.setSession(input.agentName, a.threadKey, response.sessionId);
      } catch (err) {
        process.stderr.write(
          `[dispatcher] failed to register anchor for ${input.agentName}/${a.threadKey}: ${String(err)}\n`,
        );
      }
    }
  }

  // Drain per-run calls log; surfaces which connectors the agent invoked
  // capabilities against this run.
  const connectorIdsCalled = new Set<string>();
  if (runDir) {
    const callRecords = await new CallsLog(runDir).drain();
    for (const r of callRecords) connectorIdsCalled.add(r.connectorId);
  }

  const trigger =
    input.trigger.kind === "cron"
      ? ({ kind: "cron", expr: input.trigger.detail ?? "" } as const)
      : input.trigger.kind === "message"
        ? ({ kind: "message", from: input.trigger.detail ?? "unknown" } as const)
        : ({ kind: "manual" } as const);

  const { filePath: episodicLogPath } = await writeEpisodicLog({
    agentDir: input.agentDir,
    agentName: input.agentName,
    taskId: input.taskId,
    runId,
    trigger,
    startedAt,
    finishedAt,
    response,
    userPrompt,
  });

  if (input.auditLog) {
    const record: AdapterInvocationRecord = {
      ts: startedAt.toISOString(),
      type: "adapter_invocation",
      runId,
      agent: input.agentName,
      task: input.taskId,
      trigger: triggerForRecord(input.trigger),
      adapter: input.adapter.id,
      modelUsed: response.modelUsed,
      effort: input.effort,
      tokens: response.tokens,
      costUsd: response.costUsd,
      subscriptionCovered: response.subscriptionCovered,
      durationMs: response.durationMs,
      toolCalls: response.toolCalls,
      ok: true,
    };
    await input.auditLog.append(record);
  }

  return { runId, startedAt, finishedAt, response, episodicLogPath, connectorIdsCalled };
}

function triggerForRecord(t: DispatchTrigger): AdapterInvocationRecord["trigger"] {
  if (t.kind === "cron") return { kind: "cron", expr: t.detail ?? "" };
  if (t.kind === "message") return { kind: "message", from: t.detail ?? "unknown" };
  return { kind: "manual" };
}

/**
 * Build the connector-guard policy from spawn subscriptions.
 *
 * The policy is consumed by `hooks/connector-guard.sh` which reads the JSON
 * file at $VERONA_CONNECTOR_POLICY. Two layers of gating live here:
 *
 *   Layer A — destination allowlist (Slack `channels`).
 *   Layer B — sideEffect class enforcement: destructive capabilities are
 *             denied unless the agent's `[connectors.<id>] allow_destructive`
 *             is true.
 *
 * The dispatcher enumerates each subscription's capability set via the same
 * spawn-factory registry the MCP server uses. That gives us per-capability
 * sideEffect metadata to bake into the policy.
 */
function buildConnectorPolicy(subs: readonly SpawnSubscription[]): ConnectorPolicy {
  const out: Record<
    string,
    {
      channels?: readonly string[];
      allow_destructive?: boolean;
      capabilities?: Record<string, { sideEffect: "read" | "write" | "destructive" }>;
    }
  > = {};
  for (const sub of subs) {
    const allowDestructive =
      typeof (sub.config as { allow_destructive?: unknown }).allow_destructive === "boolean"
        ? Boolean((sub.config as { allow_destructive?: unknown }).allow_destructive)
        : false;

    let channels: string[] | undefined;
    if (sub.id === "slack") {
      const cfg = sub.config as { channel?: unknown; channels?: unknown };
      channels = [];
      if (typeof cfg.channel === "string") channels.push(cfg.channel);
      if (Array.isArray(cfg.channels)) {
        for (const c of cfg.channels) if (typeof c === "string") channels.push(c);
      }
    }

    const capabilities: Record<string, { sideEffect: "read" | "write" | "destructive" }> = {};
    const factory = getBuiltInSpawnFactory(sub.id);
    if (factory) {
      let caps: readonly ConnectorCapability[];
      try {
        caps = factory({ config: sub.config, secrets: sub.secrets });
      } catch {
        caps = [];
      }
      for (const c of caps) {
        capabilities[c.name] = { sideEffect: c.sideEffect };
      }
    }

    out[sub.id] = {
      ...(channels !== undefined && { channels }),
      allow_destructive: allowDestructive,
      capabilities,
    };
  }
  return out;
}

async function readTaskPrompt(agentDir: string, promptPath: string): Promise<string> {
  const abs = path.isAbsolute(promptPath) ? promptPath : path.resolve(agentDir, promptPath);
  try {
    return (await readFile(abs, "utf8")).trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`task prompt not found at ${abs}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Compose the user-side prompt for the adapter.
 *
 *   promptPath + userMessage  → task body, then "## Current message" + user msg
 *   promptPath only           → task body
 *   userMessage only          → user msg verbatim (e.g. Slack reply resuming a session)
 *
 * If attachments are present, an "## Attached files" manifest is prepended.
 * The agent reads each file via its existing Read tool (the dispatcher adds
 * the per-run dir to --add-dir so absolute paths inside it resolve).
 *
 * Throws if both promptPath and userMessage are absent — there's nothing to send.
 */
async function composeUserPrompt(input: {
  agentDir: string;
  promptPath?: string;
  userMessage?: string;
  attachments?: ReadonlyArray<{
    filename: string;
    localPath: string;
    mimeType?: string;
    size: number;
  }>;
}): Promise<string> {
  const taskPrompt = input.promptPath
    ? await readTaskPrompt(input.agentDir, input.promptPath)
    : null;
  const msg = input.userMessage?.trim();

  let body: string;
  if (taskPrompt && msg) {
    body = [taskPrompt, "", "## Current message", "", msg].join("\n");
  } else if (taskPrompt) {
    body = taskPrompt;
  } else if (msg) {
    body = msg;
  } else {
    throw new ConfigError("dispatch requires either promptPath or userMessage (or both)");
  }

  if (input.attachments && input.attachments.length > 0) {
    const lines = ["## Attached files (saved locally)", ""];
    let i = 1;
    for (const a of input.attachments) {
      const mime = a.mimeType ?? "application/octet-stream";
      lines.push(`${i}. ${a.filename} — ${mime} — ${a.localPath} — ${a.size} bytes`);
      i += 1;
    }
    lines.push("");
    return [lines.join("\n"), body].join("\n");
  }

  return body;
}
