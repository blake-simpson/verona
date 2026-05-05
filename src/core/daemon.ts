/**
 * Daemon — long-running process. Owns the scheduler and (in M5+) connectors.
 * Spawns one `claude -p` subprocess per task fire via the dispatcher.
 *
 * Lifecycle:
 *   load verona.toml → load registered agents → build adapter + scheduler
 *   → register handlers (SIGINT/SIGTERM) → start scheduler → idle until signal
 */

import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulidx";
import type { AIAdapter } from "../adapters/adapter.js";
import { AnthropicApiAdapter } from "../adapters/anthropic-api.js";
import { ClaudeCliAdapter } from "../adapters/claude-cli.js";
import { OpenAICompatAdapter } from "../adapters/openai-compat.js";
import { loadAgentConfig, loadVeronaConfig } from "../config/loader.js";
import type { AgentConfig, ConnectorManifest, VeronaConfig } from "../config/schema.js";
import type { Connector, ConnectorContext, InboundEvent } from "../connectors/connector.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { memoryGuardScriptPath } from "../hooks/locate.js";
import { getSecret } from "../secrets/store.js";
import { listRegisteredAgents } from "../state/agent-registry.js";
import { agentDir as resolveAgentDir, resolveConnectorsDir, statePaths } from "../state/paths.js";
import { ConfigError } from "../util/errors.js";
import { AuditLog } from "./audit-log.js";
import {
  type UserConnectorRecord,
  buildAgentSubscriptions,
  discoverUserConnectors,
  instantiateUserConnector,
} from "./connector-loader.js";
import { type DispatchTrigger, dispatch } from "./dispatcher.js";
import { type AgentSchedule, Scheduler } from "./scheduler.js";
import { SessionStore } from "./session-store.js";
import { UserSync } from "./user-sync.js";

interface ConnectorMeta {
  isUserConnector: boolean;
  manifest?: ConnectorManifest;
}

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
  private connectorMeta: Map<string, ConnectorMeta> = new Map();
  private connectorCtx?: ConnectorContext;
  private agents: AgentSchedule[] = [];
  private userSync?: UserSync;
  /**
   * Set in `writePidFile()` so `removePidFile()` only unlinks the file it
   * wrote. Without this, the ephemeral Daemon instances built by
   * `verona schedule list/next/run` would call stop() and delete the
   * long-running daemon's pidfile, breaking subsequent `verona reload`.
   */
  private wrotePidFile = false;

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
   * Run until SIGINT/SIGTERM. Caller is responsible for `bootstrap()` and
   * `start()` first (see `runDaemonCmd`). Resolves once the daemon stops.
   *
   * Side effects: writes a pidfile to `state/daemon.pid` so `verona reload`
   * can find this process; installs SIGHUP handler that re-reads agent
   * configs and re-applies the schedule.
   */
  async run(): Promise<void> {
    if (!this.scheduler) {
      throw new ConfigError(
        "daemon.run() called before bootstrap()/start(); use runDaemonCmd or call bootstrap+start first",
      );
    }
    await this.writePidFile();
    this.installSignalHandlers();
    process.stdout.write(
      `verona daemon: started (pid ${process.pid}); state dir = ${this.stateDir}; ${this.scheduler.list().length} scheduled jobs\n`,
    );
    await new Promise<void>((resolve) => {
      this.onShutdown = resolve;
    });
  }

  /**
   * Re-read every registered agent's config, re-apply the schedule, and diff
   * the user-connector registry: start/stop/restart user connectors based on
   * their manifest version. Triggered by SIGHUP, by `daemon.reload()`, and by
   * UserSync after a remote pull.
   *
   * Built-in connectors (slack) are NOT restarted — Socket Mode WebSocket is
   * bound at startup; token / channel-mapping changes still require a full
   * daemon restart.
   */
  async reload(): Promise<void> {
    if (!this.scheduler) {
      throw new ConfigError("daemon.reload() called before bootstrap()");
    }
    process.stdout.write("verona daemon: reload requested; re-reading agents…\n");
    this.agents = await this.loadAgents();
    this.scheduler.setAgents(this.agents);
    await this.reloadUserConnectors();
    process.stdout.write(
      `verona daemon: reloaded; ${this.scheduler.list().length} scheduled jobs, ${this.connectors.size} connectors\n`,
    );
  }

  private async reloadUserConnectors(): Promise<void> {
    let records: UserConnectorRecord[];
    try {
      records = await discoverUserConnectors(resolveConnectorsDir());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`reload: user connector discovery failed — ${msg}\n`);
      return;
    }

    const paths = statePaths(this.stateDir);
    const subs = buildAgentSubscriptions(this.agents);
    const seen = new Set<string>();

    for (const rec of records) {
      seen.add(rec.manifest.id);
      const existing = this.connectorMeta.get(rec.manifest.id);
      if (existing && !existing.isUserConnector) {
        // built-in name clash — already warned at startup; ignore
        continue;
      }
      if (existing?.manifest && existing.manifest.version === rec.manifest.version) {
        continue; // unchanged
      }
      if (existing) {
        const old = this.connectors.get(rec.manifest.id);
        if (old?.stop) {
          try {
            await old.stop();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`reload: stopping old "${rec.manifest.id}" failed — ${msg}\n`);
          }
        }
        this.connectors.delete(rec.manifest.id);
        this.connectorMeta.delete(rec.manifest.id);
      }
      const connector = await instantiateUserConnector(rec, {
        secretsRoot: paths.secrets,
        agentSubscriptions: subs,
      });
      if (!connector) continue;
      this.connectors.set(rec.manifest.id, connector);
      this.connectorMeta.set(rec.manifest.id, {
        isUserConnector: true,
        manifest: rec.manifest,
      });
      if (connector.start) await connector.start(this.getConnectorCtx());
    }

    // Stop user connectors that disappeared from the user dir
    for (const [id, meta] of [...this.connectorMeta.entries()]) {
      if (!meta.isUserConnector) continue;
      if (seen.has(id)) continue;
      const c = this.connectors.get(id);
      if (c?.stop) {
        try {
          await c.stop();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`reload: stopping removed "${id}" failed — ${msg}\n`);
        }
      }
      this.connectors.delete(id);
      this.connectorMeta.delete(id);
    }
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

    if (this.veronaConfig.user_sync.enabled) {
      this.userSync = new UserSync({
        enabled: this.veronaConfig.user_sync.enabled,
        interval: this.veronaConfig.user_sync.interval,
        reloadOnChange: this.veronaConfig.user_sync.reload_on_change,
        stateDir: this.stateDir,
        onChange: () => this.reload(),
      });
    }
  }

  private async bootstrapConnectors(): Promise<void> {
    await this.startBuiltInConnectors();
    await this.startUserConnectors();
  }

  private getConnectorCtx(): ConnectorContext {
    if (this.connectorCtx) return this.connectorCtx;
    this.connectorCtx = {
      deliver: (event) => this.handleInbound(event),
      audit: (record) => {
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
    return this.connectorCtx;
  }

  private async startBuiltInConnectors(): Promise<void> {
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
    this.connectorMeta.set("slack", { isUserConnector: false });
    if (slack.start) await slack.start(this.getConnectorCtx());
  }

  private async startUserConnectors(): Promise<void> {
    let records: UserConnectorRecord[];
    try {
      records = await discoverUserConnectors(resolveConnectorsDir());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: user connector discovery failed — ${msg}\n`);
      return;
    }
    if (records.length === 0) return;

    const paths = statePaths(this.stateDir);
    const subs = buildAgentSubscriptions(this.agents);
    for (const rec of records) {
      if (this.connectors.has(rec.manifest.id)) {
        process.stderr.write(
          `warning: user connector "${rec.manifest.id}" conflicts with a built-in; skipping the user version.\n`,
        );
        continue;
      }
      const connector = await instantiateUserConnector(rec, {
        secretsRoot: paths.secrets,
        agentSubscriptions: subs,
      });
      if (!connector) continue;
      this.connectors.set(rec.manifest.id, connector);
      this.connectorMeta.set(rec.manifest.id, {
        isUserConnector: true,
        manifest: rec.manifest,
      });
      if (connector.start) await connector.start(this.getConnectorCtx());
    }
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
    // Defaults for replies when no on_message task is configured. WebSearch
    // sits alongside WebFetch because research-style replies usually need
    // both (search to discover, fetch to read). The agent's SOUL drives
    // behavior, not a task. If a specific agent shouldn't have a tool here,
    // that's an override case — declare an [[tasks]] on_message=true block
    // with a narrower allowed_tools.
    const defaultReplyTools = ["Read", "Write", "WebFetch", "WebSearch"] as const;
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
    this.userSync?.start();
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
    this.userSync?.stop();
    for (const c of this.connectors.values()) {
      if (c.stop) await c.stop();
    }
    await this.removePidFile();
    this.removeSignalHandlers();
    this.onShutdown?.();
  }

  private async writePidFile(): Promise<void> {
    const file = statePaths(this.stateDir).daemonPid;
    await writeFile(file, `${process.pid}\n`, "utf8");
    this.wrotePidFile = true;
  }

  private async removePidFile(): Promise<void> {
    if (!this.wrotePidFile) return;
    const file = statePaths(this.stateDir).daemonPid;
    try {
      await rm(file, { force: true });
    } catch {
      // ignore — best-effort cleanup
    }
  }

  scheduler_(): Scheduler {
    if (!this.scheduler) throw new ConfigError("daemon not bootstrapped");
    return this.scheduler;
  }

  /** Tests + diagnostics. */
  connectorIds(): string[] {
    return [...this.connectors.keys()];
  }

  /** Tests + diagnostics. */
  getConnector(id: string): Connector | undefined {
    return this.connectors.get(id);
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

    const result = await dispatch({
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

    if (task.post_response) {
      await this.postTaskResponse({
        agentName: input.agentName,
        connectorsCfg: cfg.connectors,
        runId: result.runId,
        text: result.response.text,
      });
    }
  }

  /**
   * Post a cron/manual task's final assistant message to the agent's
   * configured outbound connector. Only Slack today; routes via
   * `[connectors] slack = { channel = "..." }`. Failures here are warnings,
   * not errors — the task itself succeeded; we just couldn't ship the post.
   */
  private async postTaskResponse(input: {
    agentName: string;
    connectorsCfg: AgentConfig["connectors"];
    runId: string;
    text: string;
  }): Promise<void> {
    const slackCfg = input.connectorsCfg.slack as { channel?: string } | undefined;
    const destination = slackCfg?.channel;
    if (!destination) {
      process.stderr.write(
        `[daemon] ${input.agentName}: post_response set but no [connectors] slack.channel configured; skipping post\n`,
      );
      return;
    }
    const connector = this.connectors.get("slack");
    if (!connector?.send) {
      process.stderr.write(
        `[daemon] ${input.agentName}: post_response set but slack connector is not running (tokens missing?); skipping post\n`,
      );
      return;
    }
    if (!input.text.trim()) {
      process.stderr.write(
        `[daemon] ${input.agentName}: post_response set but the agent's final message was empty; skipping post\n`,
      );
      return;
    }
    try {
      await connector.send({
        connectorId: "slack",
        runId: input.runId,
        agent: input.agentName,
        destination,
        text: input.text,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[daemon] ${input.agentName}: post_response failed — ${msg}\n`);
    }
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
    const shutdown = () => {
      process.stdout.write("verona daemon: shutting down…\n");
      void this.stop();
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      this.signalHandlers.set(sig, shutdown);
      process.on(sig, shutdown);
    }
    const reload = () => {
      void this.reload().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`verona daemon: reload failed — ${msg}\n`);
      });
    };
    this.signalHandlers.set("SIGHUP", reload);
    process.on("SIGHUP", reload);
  }

  private removeSignalHandlers(): void {
    for (const [sig, h] of this.signalHandlers.entries()) {
      process.off(sig, h);
    }
    this.signalHandlers.clear();
  }
}
