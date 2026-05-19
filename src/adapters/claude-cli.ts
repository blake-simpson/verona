/**
 * claude-cli adapter — spawns `claude -p` and parses its stream-json output.
 *
 * Auth model: subscription OAuth, NOT API key. The user runs `claude login`
 * once on each host. We scrub ANTHROPIC_API_KEY from the subprocess env and
 * never pass --bare. See knowledge/architecture/claude-p-invocation.md.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ulid } from "ulidx";
import { AdapterError } from "../util/errors.js";
import type { AIAdapter, AdapterRequest, AdapterResponse, AdapterTokenUsage } from "./adapter.js";
import { resolveClaudeCliEffort } from "./effort-mapping.js";

function claudeBin(): string {
  return process.env.VERONA_CLAUDE_BIN ?? "claude";
}

export interface ClaudeCliAdapterOptions {
  /**
   * Per-effort model overrides. Sourced from verona.toml's
   * `adapters.effort_mapping["claude-cli"]` section.
   */
  effortOverrides?: Partial<Record<AdapterRequest["effort"], string>>;
}

export class ClaudeCliAdapter implements AIAdapter {
  readonly id = "claude-cli" as const;
  private readonly options: ClaudeCliAdapterOptions;

  constructor(options: ClaudeCliAdapterOptions = {}) {
    this.options = options;
  }

  async invoke(req: AdapterRequest): Promise<AdapterResponse> {
    const { model, effortFlag } = resolveClaudeCliEffort(req.effort, this.options.effortOverrides);

    const systemPromptPath = await writeTempSystemPrompt(req);
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose", // required for stream-json
      "--append-system-prompt-file",
      systemPromptPath,
      "--add-dir",
      req.workingDir,
      "--model",
      model,
      // Verona's boundary is the PreToolUse hook layer, not Claude Code's
      // interactive prompt (which can't be answered under headless `-p` —
      // every Write/Edit/Bash would otherwise be auto-denied). Hooks still
      // run under every permission mode. See claude-p-invocation.md.
      "--permission-mode",
      req.permissionMode ?? "bypassPermissions",
    ];

    if (req.onAssistantText) {
      // Token-level deltas. Purely additive to the stream — the terminal
      // `result` event is unchanged — and requires -p + stream-json, both
      // already set. See knowledge/architecture/claude-p-invocation.md.
      args.push("--include-partial-messages");
    }

    if (effortFlag) {
      args.push("--effort", effortFlag);
    }
    if (req.hookSettingsPath) {
      args.push("--settings", req.hookSettingsPath);
    }
    if (req.mcpConfigPath) {
      args.push("--mcp-config", req.mcpConfigPath);
    }
    if (req.runDir) {
      // Per-run scratch dir gets its own --add-dir so Read can access inbound
      // attachments and Write can stage outbound files. Stays distinct from
      // the agent's working dir.
      args.push("--add-dir", req.runDir);
    }
    if (req.budgetUsd !== undefined) {
      args.push("--max-budget-usd", String(req.budgetUsd));
    }
    if (req.allowedTools && req.allowedTools.length > 0) {
      args.push("--allowedTools", req.allowedTools.join(" "));
    }
    if (req.sessionId) {
      args.push("--resume", req.sessionId);
    } else {
      // claude -p requires UUID format for --session-id (not ULID).
      // Internal runId tracking uses ULID; this is the wire-format.
      args.push("--session-id", randomUUID());
    }

    args.push(req.userPrompt);

    const env = scrubEnv(process.env, req.workingDir, req.connectorPolicyPath);

    const startedAt = Date.now();
    const result = await spawnClaude(args, env, req.cancel, req.cwd, req.onAssistantText);
    const durationMs = Date.now() - startedAt;

    const finalEvent = result.events.find(isResultEvent);
    if (!finalEvent || finalEvent.subtype !== "success") {
      throw new AdapterError(
        "claude-cli",
        `claude -p did not return a successful result event (subtype=${finalEvent?.subtype ?? "missing"}). ${summarizeStdout(result.events)}`,
      );
    }

    const usage = finalEvent.usage ?? {};
    const tokens: AdapterTokenUsage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      ...(usage.cache_read_input_tokens !== undefined && {
        cacheRead: usage.cache_read_input_tokens,
      }),
      ...(usage.cache_creation_input_tokens !== undefined && {
        cacheWrite: usage.cache_creation_input_tokens,
      }),
    };

    const sessionId = typeof finalEvent.session_id === "string" ? finalEvent.session_id : undefined;
    const toolCalls =
      typeof finalEvent.num_turns === "number" ? Math.max(0, finalEvent.num_turns - 1) : 0;

    return {
      text: typeof finalEvent.result === "string" ? finalEvent.result : "",
      tokens,
      // Subscription auth — total_cost_usd may be informational but we don't
      // surface it as authoritative cost in our reporting.
      costUsd: null,
      subscriptionCovered: true,
      modelUsed: model,
      toolCalls,
      durationMs,
      ...(sessionId !== undefined && { sessionId }),
    };
  }
}

interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface SpawnResult {
  events: (ClaudeResultEvent | { type: string; [k: string]: unknown })[];
  exitCode: number;
}

function isResultEvent(e: unknown): e is ClaudeResultEvent {
  return typeof e === "object" && e !== null && (e as { type?: unknown }).type === "result";
}

/**
 * Build a one-paragraph diagnostic from the stream-json events claude wrote to
 * stdout. claude -p reports most failures (API errors, bad image input, auth
 * issues) as a `result` event with a non-success subtype and an error string
 * in `result` — and *nothing* on stderr. Without surfacing this, a failed run
 * shows up as `claude exited with code 1\nstderr tail:` with no reason at all.
 */
function summarizeStdout(events: SpawnResult["events"]): string {
  const last = [...events].reverse().find(isResultEvent);
  if (last) {
    const parts = [`result subtype=${last.subtype ?? "?"}`];
    if (last.is_error) parts.push("is_error=true");
    if (typeof last.result === "string" && last.result.trim().length > 0) {
      parts.push(`result=${last.result.trim().slice(0, 800)}`);
    }
    return parts.join(" ");
  }
  if (events.length === 0) return "(no stdout events — claude produced no output)";
  return `last stdout event: ${JSON.stringify(events[events.length - 1]).slice(0, 800)}`;
}

function scrubEnv(
  parent: NodeJS.ProcessEnv,
  agentDir: string,
  connectorPolicyPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  // Subscription-only path: ensure the CLI doesn't fall back to API-key auth.
  // We must DELETE these keys, not set to undefined: spawn() passes
  // `KEY=undefined` (literal string) when the value is undefined, which the
  // claude CLI would interpret as a present-but-empty API key.
  // biome-ignore lint/performance/noDelete: env scrubbing requires real key removal
  delete env.ANTHROPIC_API_KEY;
  // biome-ignore lint/performance/noDelete: env scrubbing requires real key removal
  delete env.ANTHROPIC_AUTH_TOKEN;
  // memory-guard.sh reads this to validate write paths.
  env.VERONA_AGENT_DIR = agentDir;
  if (connectorPolicyPath) {
    // connector-guard.sh reads this to validate mcp__verona__* tool calls.
    env.VERONA_CONNECTOR_POLICY = connectorPolicyPath;
  }
  return env;
}

async function writeTempSystemPrompt(req: AdapterRequest): Promise<string> {
  const dir = path.join(tmpdir(), "verona", req.agentName);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `system-${req.taskId}-${ulid()}.txt`);
  await writeFile(file, req.systemPrompt, "utf8");
  return file;
}

/**
 * Pull the incremental text out of a parsed stream-json line, if any.
 *
 * With `--include-partial-messages`, token deltas arrive as:
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *    "index":0,"delta":{"type":"text_delta","text":"..."}}}
 *
 * Tool-call blocks emit `input_json_delta` instead — ignored here so the
 * snapshot is purely the assistant's spoken narration. We append in arrival
 * order rather than reassembling per `index`: deltas never interleave out of
 * order on the wire, and a flat concatenation is exactly the running
 * narration a human wants to watch.
 */
function extractTextDelta(ev: unknown): string | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: unknown; event?: unknown };
  if (e.type !== "stream_event" || typeof e.event !== "object" || e.event === null) {
    return null;
  }
  const inner = e.event as { type?: unknown; delta?: unknown };
  if (
    inner.type !== "content_block_delta" ||
    typeof inner.delta !== "object" ||
    inner.delta === null
  ) {
    return null;
  }
  const delta = inner.delta as { type?: unknown; text?: unknown };
  if (delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return delta.text;
}

function spawnClaude(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  cwd?: string,
  onAssistantText?: (snapshot: string) => void,
): Promise<SpawnResult> {
  const bin = claudeBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd !== undefined && { cwd }),
    });
    const events: SpawnResult["events"] = [];
    let stderrBuf = "";
    let stdoutBuf = "";
    let assistantText = "";

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      for (;;) {
        const nl = stdoutBuf.indexOf("\n");
        if (nl < 0) break;
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          events.push(parsed);
          if (onAssistantText) {
            const delta = extractTextDelta(parsed);
            if (delta !== null && delta.length > 0) {
              assistantText += delta;
              try {
                onAssistantText(assistantText);
              } catch {
                // A misbehaving sink must never break stdout parsing.
              }
            }
          }
        } catch {
          // non-JSON noise on stdout; ignore.
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(new AdapterError("claude-cli", `failed to spawn ${bin}`, { cause: err }));
    });

    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code !== 0) {
        const tail = stderrBuf.split("\n").slice(-10).join("\n");
        // claude -p reports stale resumes as "No conversation found with
        // session ID: <uuid>". Surface that as a recoverable signal so the
        // inbound handler can forget the anchor and retry fresh, rather
        // than treating every non-zero exit the same.
        const sessionNotFound = /No conversation found with session ID/i.test(stderrBuf);
        reject(
          new AdapterError(
            "claude-cli",
            `claude exited with code ${code}\n${summarizeStdout(events)}\nstderr tail:\n${tail || "(empty)"}`,
            { sessionNotFound },
          ),
        );
        return;
      }
      resolve({ events, exitCode: code ?? 0 });
    });
  });
}
