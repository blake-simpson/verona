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
    ];

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
    const result = await spawnClaude(args, env, req.cancel, req.cwd);
    const durationMs = Date.now() - startedAt;

    const finalEvent = result.events.find(isResultEvent);
    if (!finalEvent || finalEvent.subtype !== "success") {
      throw new AdapterError(
        "claude-cli",
        `claude -p did not return a successful result event (subtype=${finalEvent?.subtype ?? "missing"})`,
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

function spawnClaude(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  cwd?: string,
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
          events.push(JSON.parse(line));
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
        reject(
          new AdapterError("claude-cli", `claude exited with code ${code}\nstderr tail:\n${tail}`),
        );
        return;
      }
      resolve({ events, exitCode: code ?? 0 });
    });
  });
}
