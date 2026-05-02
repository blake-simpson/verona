/**
 * Writes a per-run episodic log after a task completes.
 *
 * The agent itself may have already written to memory/learned/ during the
 * run; this is the daemon's *separate* record of what the run was, written
 * even if the agent wrote nothing. Provides recoverability and audit context.
 *
 * Path: <agent-dir>/memory/learned/episodic/<YYYY-MM-DD-HH-mm-ss>-<task>-<runId>.md
 *
 * Git committing of memory writes happens later in M2 (GitRecorder).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterResponse } from "../adapters/adapter.js";

export interface EpisodicWriteInput {
  agentDir: string;
  agentName: string;
  taskId: string;
  runId: string;
  trigger: { kind: "cron"; expr: string } | { kind: "manual" } | { kind: "message"; from: string };
  startedAt: Date;
  finishedAt: Date;
  response: AdapterResponse;
  /** User message the agent received (for replay context). */
  userPrompt: string;
}

export interface EpisodicWriteResult {
  filePath: string;
}

export async function writeEpisodicLog(input: EpisodicWriteInput): Promise<EpisodicWriteResult> {
  const dir = path.join(input.agentDir, "memory", "learned", "episodic");
  await mkdir(dir, { recursive: true });

  const stamp = formatStamp(input.startedAt);
  const filePath = path.join(dir, `${stamp}-${input.taskId}-${input.runId}.md`);

  const content = renderEpisodic(input);
  await writeFile(filePath, content, "utf8");
  return { filePath };
}

function renderEpisodic(input: EpisodicWriteInput): string {
  const { response, trigger, startedAt, finishedAt } = input;
  const triggerLine =
    trigger.kind === "cron"
      ? `cron \`${trigger.expr}\``
      : trigger.kind === "message"
        ? `message from ${trigger.from}`
        : "manual";

  const cost =
    response.subscriptionCovered || response.costUsd === null
      ? "subscription-covered (no $)"
      : `$${response.costUsd.toFixed(4)}`;

  return [
    `# ${input.taskId} — ${stampHuman(startedAt)}`,
    "",
    `- **runId:** \`${input.runId}\``,
    `- **trigger:** ${triggerLine}`,
    `- **adapter / model:** \`${response.modelUsed}\``,
    `- **tokens (in/out):** ${response.tokens.input} / ${response.tokens.output}`,
    `- **cost:** ${cost}`,
    `- **duration:** ${response.durationMs}ms`,
    `- **tool calls:** ${response.toolCalls}`,
    `- **finished:** ${stampHuman(finishedAt)}`,
    "",
    "## User prompt",
    "",
    "```",
    input.userPrompt.trim(),
    "```",
    "",
    "## Response",
    "",
    response.text.trim(),
    "",
  ].join("\n");
}

function formatStamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join("-");
}

function stampHuman(d: Date): string {
  return d.toISOString();
}
