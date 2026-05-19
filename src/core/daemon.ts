/**
 * Daemon — long-running process. Owns the scheduler and (in M5+) connectors.
 * Spawns one `claude -p` subprocess per task fire via the dispatcher.
 *
 * Lifecycle:
 *   load verona.toml → load registered agents → build adapter + scheduler
 *   → register handlers (SIGINT/SIGTERM) → start scheduler → idle until signal
 */

import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulidx";
import type { AIAdapter } from "../adapters/adapter.js";
import { AnthropicApiAdapter } from "../adapters/anthropic-api.js";
import { ClaudeCliAdapter } from "../adapters/claude-cli.js";
import { OpenAICompatAdapter } from "../adapters/openai-compat.js";
import { loadAgentConfig, loadVeronaConfig } from "../config/loader.js";
import type { ConnectorManifest, VeronaConfig } from "../config/schema.js";
import type { Connector, ConnectorContext, InboundEvent } from "../connectors/connector.js";
import { SlackConnector } from "../connectors/slack/index.js";
import {
  bashGuardScriptPath,
  connectorGuardScriptPath,
  memoryGuardScriptPath,
} from "../hooks/locate.js";
import type { SpawnSubscription } from "../mcp/spawn-config.js";
import { buildDefaultReplyPrompt } from "./default-reply-prompt.js";
import { getSecret } from "../secrets/store.js";
import { listRegisteredAgents, refreshRegisteredAgents } from "../state/agent-registry.js";
import {
  agentDir as resolveAgentDir,
  resolveAgentsDir,
  resolveConnectorsDir,
  resolveSkillsDir,
  statePaths,
} from "../state/paths.js";
import { AdapterError, ConfigError } from "../util/errors.js";
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

/**
 * Built-in connectors and the secret keys they need at spawn time. Slack's
 * spawn-side capabilities only need the bot token (no Socket Mode). Webhook
 * and web-fetch don't need any spawn-side secrets in v1; their config block
 * carries auth/URL.
 */
const BUILT_IN_SPAWN_SECRETS: Readonly<Record<string, readonly string[]>> = {
  slack: ["bot_token"],
  webhook: [],
  "web-fetch": [],
};

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
  private connectorGuardScriptPath: string;
  private bashGuardScriptPath: string;
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
    this.connectorGuardScriptPath = connectorGuardScriptPath();
    this.bashGuardScriptPath = bashGuardScriptPath();
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
    // Refresh registered agents from their source dir before re-reading.
    // This closes the silent two-tree drift where edits to
    // ~/.verona/user/agents/<name>/agent.toml don't propagate to
    // <state>/agents/<name>/ until the user runs `verona agents add`.
    const sourceRoot = resolveAgentsDir();
    const refresh = await refreshRegisteredAgents(this.stateDir, sourceRoot);
    if (refresh.refreshed.length > 0) {
      process.stdout.write(
        `verona daemon: refreshed ${refresh.refreshed.length} agent(s) from ${sourceRoot}\n`,
      );
    }
    for (const e of refresh.errors) {
      process.stderr.write(`verona daemon: refresh ${e.name} failed — ${e.message}\n`);
    }
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

    // Drop any per-run scratch dirs older than the TTL. These are created by
    // the dispatcher per claude-p spawn (MCP config + anchors + inbound
    // attachments). A clean shutdown drains the dir; crashed/killed spawns
    // leave one behind, and we don't want them to accumulate or to confuse
    // a future startup. Soft cleanup: failures are warnings.
    await this.recoverStaleRunDirs();

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

  /**
   * TTL-based cleanup of <state>/runs/* dirs left by previous spawns. The
   * dispatcher writes the per-run MCP config, hook policy, anchors NDJSON,
   * and (Phase 3) inbound attachments under <runDir>. A clean run drains
   * what it needs (anchors → SessionStore) and we don't bother deleting it
   * on the hot path; this scan removes anything older than the configured
   * TTL. Default 24h. Failures are warnings — the daemon still starts.
   */
  private async recoverStaleRunDirs(): Promise<void> {
    const paths = statePaths(this.stateDir);
    const ttlMs = 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = (await readdir(paths.runs)) as string[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      process.stderr.write(`[daemon] recoverStaleRunDirs: readdir failed — ${String(err)}\n`);
      return;
    }
    const now = Date.now();
    let removed = 0;
    for (const name of entries) {
      const full = path.join(paths.runs, name);
      try {
        const s = await stat(full);
        if (!s.isDirectory()) continue;
        if (now - s.mtimeMs < ttlMs) continue;
        await rm(full, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        process.stderr.write(
          `[daemon] recoverStaleRunDirs: failed to inspect/remove ${full} — ${String(err)}\n`,
        );
      }
    }
    if (removed > 0) {
      process.stderr.write(`[daemon] recoverStaleRunDirs: removed ${removed} stale run dir(s)\n`);
    }
  }

  private getConnectorCtx(): ConnectorContext {
    if (this.connectorCtx) return this.connectorCtx;
    const paths = statePaths(this.stateDir);
    this.connectorCtx = {
      runsDir: paths.runs,
      resolveAgentForThread: (threadKey) => this.sessionStore.findByThreadKey(threadKey),
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
    // Thread replies often arrive without an explicit agentTarget — the
    // connector only knows the thread_ts. Resolve via SessionStore: whichever
    // agent anchored that thread is the right recipient.
    let agentName = event.agentTarget;
    if (!agentName && event.threadKey) {
      const found = await this.sessionStore.findByThreadKey(event.threadKey);
      if (found) agentName = found.agentName;
    }
    if (!agentName) {
      process.stderr.write(
        `[${event.connectorId}] inbound event has no agentTarget and no anchored threadKey; ignoring (text="${event.text.slice(0, 60)}")\n`,
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
    // Edit is required for the common case — updating an existing memory file
    // (INDEX.md, preferences.md, an existing lead note). Bash lets the agent
    // do real scoped work (generate a PDF, run a build script); bash-guard.sh
    // is the boundary that keeps it off secrets/system. Without Edit here,
    // every memory update was silently denied headlessly.
    const defaultReplyTools = ["Read", "Write", "Edit", "Bash", "WebFetch", "WebSearch"] as const;
    const allowedTools = onMsgTask?.allowed_tools ?? defaultReplyTools;
    const budgetUsd = onMsgTask?.budget_usd;

    const subscriptions = await this.buildSpawnSubscriptions({
      agentName,
      agentConnectors: agent.config.connectors,
    });
    const paths = statePaths(this.stateDir);

    // Build the user-prompt the agent sees. Two augmentations:
    //   - Always inject a verona-context block so the agent reliably has
    //     `thread_ts`, `channel`, and `connector` to feed into its tool
    //     calls. Without this, agents that didn't post in this session (e.g.
    //     a fresh @-mention) have no way to know which thread to reply in.
    //   - When the agent has connector subscriptions but no on_message task,
    //     also prepend the framework's default reply directive so the model
    //     reaches for the connector tool instead of plain text.
    const userMessage = composeInboundUserMessage({
      event,
      subscriptions,
      hasOnMessageTask: onMsgTask !== undefined,
      defaultChannel: (agent.config.connectors.slack as { channel?: string } | undefined)?.channel,
    });

    const agentSkills = agent.config.agent.skills;
    const buildDispatchInput = (resumeId: string | null) => ({
      agentDir: agent.agentDir,
      agentName,
      taskId,
      effort,
      trigger,
      adapter,
      guardScriptPath: this.guardScriptPath,
      connectorGuardScriptPath: this.connectorGuardScriptPath,
      bashGuardScriptPath: this.bashGuardScriptPath,
      auditLog: this.auditLog,
      sessionStore: this.sessionStore,
      runsDir: paths.runs,
      auditLogPath: paths.invocations,
      stateDir: paths.root,
      runId,
      userMessage,
      ...(subscriptions.length > 0 && { subscriptions }),
      ...(agentSkills.length > 0 && {
        skills: agentSkills,
        skillsDir: resolveSkillsDir(),
      }),
      ...(onMsgTask?.prompt !== undefined && { promptPath: onMsgTask.prompt }),
      ...(resumeId !== null && { sessionId: resumeId }),
      ...(budgetUsd !== undefined && { budgetUsd }),
      ...(event.attachments &&
        event.attachments.length > 0 && {
          attachments: event.attachments,
        }),
      allowedTools,
    });

    let result: Awaited<ReturnType<typeof dispatch>>;
    try {
      result = await dispatch(buildDispatchInput(sessionId));
    } catch (err) {
      // claude -p rejected the --resume because the anchored session no
      // longer exists in its history (e.g. the spawn CWD changed across
      // versions and the session lived under the old project). Forget the
      // stale anchor and retry once with a fresh session. The agent loses
      // prior turns' context for this thread, but the user gets a reply
      // and future replies in the same thread resume correctly.
      if (err instanceof AdapterError && err.sessionNotFound && sessionId && threadKey) {
        process.stderr.write(
          `[daemon] ${agentName}: stale session anchor for thread ${threadKey}; forgetting and retrying with a fresh session\n`,
        );
        await this.sessionStore.forgetSession(agentName, threadKey);
        try {
          result = await dispatch(buildDispatchInput(null));
        } catch (retryErr) {
          process.stderr.write(
            `[daemon] ${agentName}: retry after stale-session recovery also failed (${String(retryErr)}); skipping reply\n`,
          );
          return;
        }
      } else {
        // Any other adapter error: log and skip. The dispatcher already
        // recorded a failed adapter_invocation in the audit log, so the
        // failure is visible via `verona invocations`.
        process.stderr.write(
          `[daemon] ${agentName}: dispatch failed for inbound from ${event.connectorId} (${String(err)}); skipping reply\n`,
        );
        return;
      }
    }

    if (result.response.sessionId && threadKey) {
      await this.sessionStore.setSession(agentName, threadKey, result.response.sessionId);
    }

    // Legacy auto-post fallback. Agents that called slack__send_message (or
    // any other capability against the originating connector) already spoke
    // for themselves; skip auto-posting their final assistant text in that
    // case so we don't double-message. Agents that took no action via the
    // tool plane fall back to the v0.3 behaviour.
    if (result.connectorIdsCalled.has(event.connectorId)) {
      return;
    }
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
    // Drain in-flight audit appends so CLI process.exit() doesn't drop
    // records dispatched during this run (e.g. connector_send from a
    // post_response slack post in `verona schedule run`).
    await this.auditLog.drain();
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
   * Build the spawn-side subscription list for a single agent. One entry per
   * `[connectors.<id>]` block in the agent's config, paired with resolved
   * secrets the spawn-side connector needs.
   *
   * For built-ins, the secret keys come from `BUILT_IN_SPAWN_SECRETS`. For
   * user connectors they come from the connector's manifest.
   *
   * Subscriptions for which a required secret is missing or for which no
   * connector is registered are skipped (with a stderr warning) — the spawn
   * still starts, just without those tools.
   */
  private async buildSpawnSubscriptions(input: {
    agentName: string;
    agentConnectors: Record<string, unknown>;
  }): Promise<SpawnSubscription[]> {
    const paths = statePaths(this.stateDir);
    const out: SpawnSubscription[] = [];
    for (const [id, cfg] of Object.entries(input.agentConnectors)) {
      if (!cfg || typeof cfg !== "object") continue;
      const config = cfg as Record<string, unknown>;
      let secretKeys: readonly string[];
      if (id in BUILT_IN_SPAWN_SECRETS) {
        secretKeys = BUILT_IN_SPAWN_SECRETS[id] as readonly string[];
      } else {
        const meta = this.connectorMeta.get(id);
        if (!meta?.manifest) {
          process.stderr.write(
            `[daemon] ${input.agentName}: declares [connectors.${id}] but no such connector is registered; spawn-side tools skipped\n`,
          );
          continue;
        }
        secretKeys = meta.manifest.secrets;
      }
      const secrets: Record<string, string> = {};
      let missing = false;
      for (const key of secretKeys) {
        const value = await getSecret(paths.secrets, { kind: "connector", id }, key);
        if (value === null) {
          process.stderr.write(
            `[daemon] ${input.agentName}: connector "${id}" missing secret "${key}"; spawn-side tools for this connector skipped\n`,
          );
          missing = true;
          break;
        }
        secrets[key] = value.trim();
      }
      if (missing) continue;
      out.push({ id, config, secrets });
    }
    return out;
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

    const subscriptions = await this.buildSpawnSubscriptions({
      agentName: input.agentName,
      agentConnectors: cfg.connectors,
    });
    const paths = statePaths(this.stateDir);

    const agentSkills = cfg.agent.skills;
    await dispatch({
      agentDir: agentRoot,
      agentName: input.agentName,
      taskId: input.taskId,
      promptPath: task.prompt,
      effort,
      trigger: input.trigger,
      adapter,
      guardScriptPath: this.guardScriptPath,
      connectorGuardScriptPath: this.connectorGuardScriptPath,
      bashGuardScriptPath: this.bashGuardScriptPath,
      auditLog: this.auditLog,
      sessionStore: this.sessionStore,
      runsDir: paths.runs,
      auditLogPath: paths.invocations,
      stateDir: paths.root,
      ...(subscriptions.length > 0 && { subscriptions }),
      ...(agentSkills.length > 0 && {
        skills: agentSkills,
        skillsDir: resolveSkillsDir(),
      }),
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

/**
 * Build the user-prompt body for an inbound dispatch. Two augmentations:
 *   1. Always prepend a `verona-context` block so the agent reliably has
 *      `thread_ts`, `channel`, and `connector` to feed into its tool calls.
 *   2. When the agent has subscriptions but no on_message task, prepend the
 *      framework default reply directive (lists tools + reply protocol).
 *
 * Output shape:
 *
 *   <directive (optional)>
 *
 *   <verona-context>
 *   connector: slack
 *   channel: C0...
 *   thread_ts: 1700000000.000000
 *   </verona-context>
 *
 *   <user text>
 */
export function composeInboundUserMessage(input: {
  event: InboundEvent;
  subscriptions: readonly SpawnSubscription[];
  hasOnMessageTask: boolean;
  defaultChannel: string | undefined;
}): string {
  const { event, subscriptions, hasOnMessageTask, defaultChannel } = input;

  const ctxLines = ["<verona-context>", `connector: ${event.connectorId}`];
  const channel = event.channelId ?? defaultChannel;
  if (channel) ctxLines.push(`channel: ${channel}`);
  if (event.threadKey) ctxLines.push(`thread_ts: ${event.threadKey}`);
  ctxLines.push("</verona-context>");
  const contextBlock = ctxLines.join("\n");

  const directive = hasOnMessageTask ? null : buildDefaultReplyPrompt(subscriptions);

  const sections: string[] = [];
  if (directive) sections.push(directive);
  sections.push(contextBlock);
  sections.push(event.text);
  return sections.join("\n\n");
}
