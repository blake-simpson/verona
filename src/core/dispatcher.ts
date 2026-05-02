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
import { renderHookSettings } from "../hooks/render-hook-settings.js";
import { ConfigError } from "../util/errors.js";
import type { AdapterInvocationRecord, AuditLog } from "./audit-log.js";
import { loadMemory } from "./memory-loader.js";
import { writeEpisodicLog } from "./memory-writer.js";

export interface DispatchTrigger {
  kind: "manual" | "cron" | "message";
  /** For cron: the cron expression. For message: the originating user. */
  detail?: string;
}

export interface DispatchInput {
  agentDir: string;
  agentName: string;
  taskId: string;
  /** Path to the task prompt template (relative to agentDir or absolute). */
  promptPath: string;
  /** Optional per-task user prompt overlay (e.g. Slack message text). */
  userMessage?: string;
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
}

export interface DispatchResult {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  response: AdapterResponse;
  episodicLogPath: string;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const runId = input.runId ?? ulid();
  const startedAt = new Date();

  const memory = await loadMemory({
    agentDir: input.agentDir,
    agentName: input.agentName,
    taskId: input.taskId,
  });

  const taskPrompt = await readTaskPrompt(input.agentDir, input.promptPath);
  const userPrompt = composeUserPrompt(taskPrompt, input.userMessage);

  const scratch = input.scratchDir ?? path.join(input.agentDir, ".verona-tmp");
  await mkdir(scratch, { recursive: true });
  const hookSettingsPath = path.join(scratch, `hook-settings-${runId}.json`);
  await renderHookSettings({
    guardScriptPath: input.guardScriptPath,
    outputPath: hookSettingsPath,
  });

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
    ...(input.allowedTools && { allowedTools: input.allowedTools }),
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

  return { runId, startedAt, finishedAt, response, episodicLogPath };
}

function triggerForRecord(t: DispatchTrigger): AdapterInvocationRecord["trigger"] {
  if (t.kind === "cron") return { kind: "cron", expr: t.detail ?? "" };
  if (t.kind === "message") return { kind: "message", from: t.detail ?? "unknown" };
  return { kind: "manual" };
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

function composeUserPrompt(taskPrompt: string, userMessage?: string): string {
  if (!userMessage) return taskPrompt;
  return [taskPrompt, "", "## Current message", "", userMessage.trim()].join("\n");
}
