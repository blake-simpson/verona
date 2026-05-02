/**
 * Daemon — long-running process. Owns the scheduler and (in M5+) connectors.
 * Spawns one `claude -p` subprocess per task fire via the dispatcher.
 *
 * Lifecycle:
 *   load verona.toml → load registered agents → build adapter + scheduler
 *   → register handlers (SIGINT/SIGTERM) → start scheduler → idle until signal
 */

import path from "node:path";
import { ulid } from "ulidx";
import type { AIAdapter } from "../adapters/adapter.js";
import { AnthropicApiAdapter } from "../adapters/anthropic-api.js";
import { ClaudeCliAdapter } from "../adapters/claude-cli.js";
import { OpenAICompatAdapter } from "../adapters/openai-compat.js";
import { loadAgentConfig, loadVeronaConfig } from "../config/loader.js";
import type { VeronaConfig } from "../config/schema.js";
import type { Connector, ConnectorContext, InboundEvent } from "../connectors/connector.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { memoryGuardScriptPath } from "../hooks/locate.js";
import { getSecret } from "../secrets/store.js";
import { listRegisteredAgents } from "../state/agent-registry.js";
import { agentDir as resolveAgentDir, statePaths } from "../state/paths.js";
import { ConfigError } from "../util/errors.js";
import { AuditLog } from "./audit-log.js";
import { type DispatchTrigger, dispatch } from "./dispatcher.js";
import { type AgentSchedule, Scheduler } from "./scheduler.js";
import { SessionStore } from "./session-store.js";

export interface DaemonInit {
  stateDir: string;
}

export class Daemon {
  private readonly stateDir: string;
  private veronaConfig?: VeronaConfig;
  private scheduler?: Scheduler;
  private adapters: Map<string, AIAdapter> = new Map();
  private guardScriptPath: string;
  private signalHandlers: Map<NodeJS.Signals, () => void> = new Map();
  private auditLog: AuditLog;
  private sessionStore: SessionStore;
  private connectors: Map<string, Connector> = new Map();
  private agents: AgentSchedule[] = [];

  constructor(init: DaemonInit) {
    this.stateDir = init.stateDir;
    this.guardScriptPath = memoryGuardScriptPath();
    const paths = statePaths(init.stateDir);
    this.auditLog = new AuditLog({
      filePath: paths.invocations,
      rotatedDir: path.join(paths.logs, "invocations"),
    });
    this.sessionStore = new SessionStore({ sessionsDir: paths.sessions });
  }

  /** Exposed for `verona invocations` and `verona costs` to share state. */
  audit(): AuditLog {
    return this.auditLog;
  }

  /**
   * Run until SIGINT/SIGTERM. Resolves once the daemon has stopped cleanly.
   */
  async run(): Promise<void> {
    await this.bootstrap();
    this.installSignalHandlers();
    process.stdout.write(
      `verona daemon: started; state dir = ${this.stateDir}; ${this.scheduler?.list().length ?? 0} scheduled jobs\n`,
    );
    await new Promise<void>((resolve) => {
      this.onShutdown = resolve;
    });
  }

  private onShutdown: (() => void) | undefined = undefined;

  /**
   * Load agents + build scheduler without starting it. Used by `verona schedule
   * list/next/run` to share construction logic.
   */
  async bootstrap(): Promise<void> {
    const paths = statePaths(this.stateDir);
    this.veronaConfig = await loadVeronaConfig(paths.veronaToml);

    const claudeOverrides = this.veronaConfig.adapters.effort_mapping["claude-cli"];
    this.adapters.set(
      "claude-cli",
      new ClaudeCliAdapter(claudeOverrides ? { effortOverrides: claudeOverrides } : {}),
    );

    // API-key adapters: construct only if a key is in the secrets store.
    const anthropicKey = await getSecret(paths.secrets, { kind: "global" }, "ANTHROPIC_API_KEY");
    if (anthropicKey) {
      const overrides = this.veronaConfig.adapters.effort_mapping["anthropic-api"];
      this.adapters.set(
        "anthropic-api",
        new AnthropicApiAdapter({
          apiKey: anthropicKey.trim(),
          ...(overrides && { effortOverrides: overrides }),
        }),
      );
    }
    const openaiKey = await getSecret(paths.secrets, { kind: "global" }, "OPENAI_API_KEY");
    if (openaiKey) {
      const overrides = this.veronaConfig.adapters.effort_mapping.openai;
      this.adapters.set(
        "openai",
        new OpenAICompatAdapter({
          id: "openai",
          apiKey: openaiKey.trim(),
          ...(overrides && { effortOverrides: overrides }),
        }),
      );
    }
    const openrouterKey = await getSecret(paths.secrets, { kind: "global" }, "OPENROUTER_API_KEY");
    if (openrouterKey) {
      const overrides = this.veronaConfig.adapters.effort_mapping.openrouter;
      this.adapters.set(
        "openrouter",
        new OpenAICompatAdapter({
          id: "openrouter",
          apiKey: openrouterKey.trim(),
          ...(overrides && { effortOverrides: overrides }),
        }),
      );
    }

    this.agents = await this.loadAgents();
    this.scheduler = new Scheduler({
      runTask: async ({ agentName, taskId, schedule }) => {
        await this.runTask({ agentName, taskId, trigger: { kind: "cron", detail: schedule } });
      },
    });
    this.scheduler.setAgents(this.agents);

    await this.bootstrapConnectors();
  }

  private async bootstrapConnectors(): Promise<void> {
    // Slack: any agent that declares `[connectors] slack = { channel = "..." }`.
    const slackChannelToAgent = new Map<string, string>();
    for (const a of this.agents) {
      const slackCfg = a.config.connectors.slack as { channel?: string } | undefined;
      if (slackCfg?.channel) slackChannelToAgent.set(slackCfg.channel, a.agentName);
    }
    if (slackChannelToAgent.size === 0) return;

    const paths = statePaths(this.stateDir);
    const botToken = await getSecret(
      paths.secrets,
      { kind: "connector", id: "slack" },
      "bot_token",
    );
    const appToken = await getSecret(
      paths.secrets,
      { kind: "connector", id: "slack" },
      "app_token",
    );
    if (!botToken || !appToken) {
      process.stderr.write(
        "warning: an agent uses the slack connector but tokens are missing in state/secrets/_connectors/slack/. Slack connector NOT started. Use `verona connectors add slack` to set tokens.\n",
      );
      return;
    }

    const slack = new SlackConnector({
      botToken: botToken.trim(),
      appToken: appToken.trim(),
      channelToAgent: slackChannelToAgent,
    });
    this.connectors.set("slack", slack);
    const ctx: ConnectorContext = {
      deliver: (event) => this.handleInbound(event),
      audit: (record) => {
        // Normalize connector audit shape into AuditRecord.
        const base = {
          ts: new Date().toISOString(),
          runId: record.runId ?? ulid(),
          type: record.type,
          connector: record.connectorId,
          messageBytes: record.messageBytes,
          ok: record.ok,
          ...(record.agent !== undefined && { agent: record.agent }),
          ...(record.threadKey !== undefined && { threadKey: record.threadKey }),
          ...(record.errorClass !== undefined && { errorClass: record.errorClass }),
        };
        if (record.type === "connector_send") {
          void this.auditLog.append({
            ...base,
            type: "connector_send",
            destination: record.destination ?? "",
          });
        } else {
          void this.auditLog.append({
            ...base,
            type: "connector_receive",
            ...(record.fromUser !== undefined && { fromUser: record.fromUser }),
          });
        }
      },
    };
    if (slack.start) await slack.start(ctx);
  }

  /**
   * Inbound entry point — connectors call this via ctx.deliver.
   *
   * Default behavior (no on_message task):
   *   thread reply → resume the prior session, user's message is the next turn
   *   top-level mention → start a fresh session with SOUL + framing + INDEX as
   *                        system prompt, user's message is the first user turn
   *
   * Advanced override: an agent can declare a `[[tasks]]` block with
   * `on_message = true` to enforce a specific protocol on every inbound
   * message (the task prompt body prepends to each user message).
   *
   * Either way, the response posts back via the originating connector.
   */
  async handleInbound(event: InboundEvent): Promise<void> {
    const agentName = event.agentTarget;
    if (!agentName) {
      process.stderr.write(
        `[${event.connectorId}] inbound event has no agentTarget; ignoring (text="${event.text.slice(0, 60)}")\n`,
      );
      return;
    }
    const agent = this.agents.find((a) => a.agentName === agentName);
    if (!agent) {
      process.stderr.write(`[${event.connectorId}] no registered agent "${agentName}"; ignoring\n`);
      return;
    }

    // Optional override: any [[tasks]] block with `on_message = true`.
    // If absent, we still respond — replies just resume / start fresh.
    const onMsgTask = agent.config.tasks.find((t) => t.on_message === true);

    const threadKey = event.threadKey;
    const sessionId = threadKey ? await this.sessionStore.getSession(agentName, threadKey) : null;
    const trigger: DispatchTrigger = { kind: "message", detail: event.user?.id ?? "unknown" };
    const runId = event.runId;

    const adapterId = agent.config.agent.adapter;
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new ConfigError(`adapter "${adapterId}" not registered`);

    const taskId = onMsgTask?.id ?? "reply";
    const effort = onMsgTask?.effort ?? agent.config.agent.default_effort;
    // Defaults for replies when no on_message task is configured. Read+Write+
    // WebFetch covers the common cases (look at memory, append episodic, fetch
    // a URL the user mentioned). The agent's SOUL drives behavior, not a task.
    const defaultReplyTools = ["Read", "Write", "WebFetch"] as const;
    const allowedTools = onMsgTask?.allowed_tools ?? defaultReplyTools;
    const budgetUsd = onMsgTask?.budget_usd;

    const result = await dispatch({
      agentDir: agent.agentDir,
      agentName,
      taskId,
      effort,
      trigger,
      adapter,
      guardScriptPath: this.guardScriptPath,
      auditLog: this.auditLog,
      runId,
      userMessage: event.text,
      ...(onMsgTask?.prompt !== undefined && { promptPath: onMsgTask.prompt }),
      ...(sessionId !== null && { sessionId }),
      ...(budgetUsd !== undefined && { budgetUsd }),
      allowedTools,
    });

    if (result.response.sessionId && threadKey) {
      await this.sessionStore.setSession(agentName, threadKey, result.response.sessionId);
    }

    // Post the response back via the originating connector (Slack only for now).
    const connector = this.connectors.get(event.connectorId);
    if (connector?.send) {
      const slackCfg = agent.config.connectors.slack as { channel?: string } | undefined;
      const destination = slackCfg?.channel ?? "";
      if (destination) {
        await connector.send({
          connectorId: event.connectorId,
          runId,
          agent: agentName,
          destination,
          text: result.response.text,
          ...(threadKey !== undefined && { threadKey }),
        });
      }
    }
  }

  start(): void {
    if (!this.scheduler) {
      throw new ConfigError("daemon.start() called before bootstrap()");
    }
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
    for (const c of this.connectors.values()) {
      if (c.stop) await c.stop();
    }
    this.removeSignalHandlers();
    this.onShutdown?.();
  }

  scheduler_(): Scheduler {
    if (!this.scheduler) throw new ConfigError("daemon not bootstrapped");
    return this.scheduler;
  }

  /**
   * Run a single task immediately (manual trigger / `verona schedule run`).
   */
  async runTask(input: {
    agentName: string;
    taskId: string;
    trigger: DispatchTrigger;
    userMessage?: string;
    sessionId?: string;
  }): Promise<void> {
    const agentRoot = resolveAgentDir(this.stateDir, input.agentName);
    const cfg = await loadAgentConfig(path.join(agentRoot, "agent.toml"));
    const task = cfg.tasks.find((t) => t.id === input.taskId);
    if (!task) {
      throw new ConfigError(`agent "${input.agentName}" has no task "${input.taskId}"`);
    }

    const adapterId = cfg.agent.adapter;
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new ConfigError(
        `adapter "${adapterId}" is not registered (agent ${input.agentName} requested it). v1 ships claude-cli; M7 adds anthropic-api / openai / openrouter.`,
      );
    }

    const effort = task.effort ?? cfg.agent.default_effort;

    await dispatch({
      agentDir: agentRoot,
      agentName: input.agentName,
      taskId: input.taskId,
      promptPath: task.prompt,
      effort,
      trigger: input.trigger,
      adapter,
      guardScriptPath: this.guardScriptPath,
      auditLog: this.auditLog,
      ...(task.budget_usd !== undefined && { budgetUsd: task.budget_usd }),
      ...(task.allowed_tools && { allowedTools: task.allowed_tools }),
      ...(input.userMessage !== undefined && { userMessage: input.userMessage }),
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    });
  }

  private async loadAgents(): Promise<AgentSchedule[]> {
    const names = await listRegisteredAgents(this.stateDir);
    const out: AgentSchedule[] = [];
    for (const name of names) {
      const dir = resolveAgentDir(this.stateDir, name);
      const cfg = await loadAgentConfig(path.join(dir, "agent.toml"));
      out.push({ agentName: name, agentDir: dir, config: cfg });
    }
    return out;
  }

  private installSignalHandlers(): void {
    const handler = () => {
      process.stdout.write("verona daemon: shutting down…\n");
      void this.stop();
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      this.signalHandlers.set(sig, handler);
      process.on(sig, handler);
    }
  }

  private removeSignalHandlers(): void {
    for (const [sig, h] of this.signalHandlers.entries()) {
      process.off(sig, h);
    }
    this.signalHandlers.clear();
  }
}
