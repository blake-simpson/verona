/**
 * Connector — Verona's interface for talking to the outside world.
 *
 * v1 implementations:
 *   - slack       : @slack/socket-mode + @slack/web-api (bidirectional)
 *   - webhook     : HTTP POST out + optional inbound HTTP server (bidirectional)
 *   - web-fetch   : outbound fetch + readability extraction (outbound-only)
 *
 * A connector has two halves:
 *   - daemon-side (long-lived): owns I/O that must outlive a spawn — Socket
 *     Mode WebSocket, webhook HTTP listener, OAuth refresh, inbound delivery.
 *     `start()` / `stop()` / `send()` live here.
 *   - spawn-side (per-task): owns capability invocation during one claude-p
 *     spawn. The MCP server dispatches `capabilities()` entries as MCP tools.
 *
 * See knowledge/architecture/connector-contract.md for the invariants every
 * connector must obey.
 */

import type { ConnectorCapability } from "./capability.js";

export type ConnectorId = string;

export type ConnectorDirection = "inbound" | "outbound" | "both";

export interface ConnectorContext {
  /** Inbound delivery — connectors call this when they receive a message. */
  deliver(event: InboundEvent): Promise<void>;
  /** Audit-log a connector send/receive. Connectors emit one record per call. */
  audit(record: ConnectorAuditRecord): void;
  /**
   * Per-state runs dir, e.g. <state>/runs/. Connectors that download inbound
   * attachments stage them under <runsDir>/<runId>/inbound/<filename> so the
   * dispatcher can hand the dir to the agent's --add-dir for `Read`.
   */
  runsDir: string;
  /**
   * Cross-agent threadKey lookup. Used by message-event handlers that don't
   * carry an explicit agent target (e.g. Slack thread reply without an
   * @-mention). Returns null when no agent has anchored this thread.
   */
  resolveAgentForThread(
    threadKey: string,
  ): Promise<{ agentName: string; sessionId: string } | null>;
}

export type InboundEventKind = "mention" | "dm" | "thread_reply" | "channel_message";

export interface InboundAttachment {
  /** Human-friendly filename used in the prompt manifest. */
  filename: string;
  /** MIME type as reported by the source. */
  mimeType?: string;
  /**
   * Absolute path inside the per-run scratch dir (<runsDir>/<runId>/inbound/...).
   * The dispatcher adds the dir to the agent's --add-dir so Read can open it.
   * Absent when the file could not be retrieved — see `unavailable`.
   */
  localPath?: string;
  /** Size in bytes after download. 0 when unavailable. */
  size: number;
  /**
   * Set when the attachment could NOT be downloaded as usable bytes (e.g. the
   * source served an auth/HTML page instead of the file). Carries a short
   * reason. The dispatcher tells the agent so it can acknowledge it couldn't
   * view the file rather than silently answering as if nothing was attached,
   * or — worse — poisoning the run by feeding HTML to the model as an image.
   */
  unavailable?: string;
  /** Connector-native source handle (URL, file_id, etc.). Diagnostic only. */
  source?: unknown;
}

export interface InboundEvent {
  connectorId: ConnectorId;
  /**
   * Run ID assigned at the moment of receipt. Threaded through the
   * downstream adapter_invocation and connector_send audit records so the
   * full trigger → response chain joins on a single ID.
   */
  runId: string;
  /**
   * What kind of inbound this is. Drives routing in `Daemon.handleInbound`:
   *   "mention"        — @-mention in a channel; agentTarget pre-resolved by connector.
   *   "dm"             — direct message to the bot; agentTarget pre-resolved.
   *   "thread_reply"   — reply in a thread without @-mention; agentTarget=null,
   *                      daemon resolves via SessionStore.findByThreadKey.
   *   "channel_message"— reserved for future free-channel listening.
   */
  kind?: InboundEventKind;
  /**
   * Specific agent to route to. Null means dispatcher figures it out — for
   * thread replies that means SessionStore.findByThreadKey(threadKey).
   */
  agentTarget: string | null;
  /**
   * Stable key that groups messages into a conversation (e.g. Slack thread_ts).
   * The dispatcher uses it to look up the prior session ID for `--resume`.
   */
  threadKey?: string;
  /** Connector-native channel id. Diagnostic + future routing. */
  channelId?: string;
  text: string;
  user?: { id: string; display: string };
  /**
   * Files the user attached. The connector has already downloaded them into
   * <runsDir>/<runId>/inbound/. The dispatcher adds the run dir to --add-dir
   * and prepends a manifest section to the user prompt.
   */
  attachments?: readonly InboundAttachment[];
  /** Connector-native event payload, for debugging. Don't depend on shape. */
  raw: unknown;
}

export interface OutboundMessage {
  connectorId: ConnectorId;
  /**
   * Run ID for joining this send to its triggering record. Set by the daemon
   * (when this is a reply to an inbound) or by an agent task (when proactive).
   */
  runId: string;
  /** Optional agent name, for audit attribution when this is a proactive send. */
  agent?: string;
  /** Connector-native destination (Slack channel, webhook URL key, etc.). */
  destination: string;
  text: string;
  /** Optional reply-into-thread key, mirrors threadKey from inbound. */
  threadKey?: string;
  /** Optional structured payload for richer rendering (Slack blocks, etc.). */
  attachments?: unknown;
}

export interface ConnectorAuditRecord {
  type: "connector_send" | "connector_receive";
  connectorId: ConnectorId;
  /** Set on send; on receive, dispatcher fills in after routing. */
  agent?: string;
  /** Used to join a connector_receive to the adapter_invocation it triggered. */
  runId?: string;
  destination?: string;
  threadKey?: string;
  fromUser?: string;
  messageBytes: number;
  ok: boolean;
  errorClass?: string;
}

export interface Connector {
  readonly id: ConnectorId;
  readonly direction: ConnectorDirection;
  /**
   * Open WSS, register webhook listener, etc. Required if direction includes
   * "inbound". Ignored if "outbound"-only.
   */
  start?(ctx: ConnectorContext): Promise<void>;
  stop?(): Promise<void>;
  /**
   * Required if direction includes "outbound". Resolves on transport accept,
   * not delivery. Throws ConnectorSendError on failure.
   *
   * NOTE: this is the *system-side* outbound (daemon notifications, legacy
   * inbound auto-post). The agent's outbound is via `capabilities()` — see
   * `src/connectors/capability.ts`.
   */
  send?(msg: OutboundMessage): Promise<void>;
  /**
   * Tool catalog the connector exposes to agents that have it in their
   * subscriptions. Returned list is enumerated by the per-spawn MCP server
   * and registered as MCP tools named `mcp__verona__<id>__<capability.name>`.
   *
   * Connectors with `direction: "inbound"` may still expose read-only
   * capabilities (e.g. `list_recent`). Connectors with `direction: "outbound"`
   * usually expose at least one capability.
   */
  capabilities?(): readonly ConnectorCapability[];
}

/**
 * Init payload passed to a user-authored connector's factory. Built by the
 * daemon from the connector's manifest + state/secrets + agent subscriptions.
 *
 * @see src/core/connector-loader.ts
 */
export interface UserConnectorInit {
  /**
   * Resolved values from <state>/secrets/_connectors/<id>/<key>, one entry
   * per key listed in connector.toml's `secrets` array. Trimmed.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Agents that declared `[connectors.<this-id>]` in their agent.toml.
   * Map of agent_name → the raw config block. Mirrors SlackConnector's
   * channelToAgent pattern but generic. Empty for connectors no agent
   * subscribed to (still useful for outbound-only connectors).
   */
  readonly agentSubscriptions: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Default-export shape every user-authored connector module must satisfy.
 * Either return a ready Connector synchronously, return a Promise, or throw
 * if the init payload fails the connector's own validation.
 */
export type UserConnectorFactory = (init: UserConnectorInit) => Connector | Promise<Connector>;
