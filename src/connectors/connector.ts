/**
 * Connector — Verona's interface for talking to the outside world.
 *
 * v1 implementations:
 *   - slack       : @slack/socket-mode + @slack/web-api (bidirectional)
 *   - webhook     : HTTP POST out + optional inbound HTTP server (bidirectional)
 *   - web-fetch   : outbound fetch + readability extraction (outbound-only)
 *
 * See knowledge/architecture/connector-contract.md for the invariants every
 * connector must obey.
 */

export type ConnectorId = string;

export type ConnectorDirection = "inbound" | "outbound" | "both";

export interface ConnectorContext {
  /** Inbound delivery — connectors call this when they receive a message. */
  deliver(event: InboundEvent): Promise<void>;
  /** Audit-log a connector send/receive. Connectors emit one record per call. */
  audit(record: ConnectorAuditRecord): void;
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
   * Specific agent to route to. Null means dispatcher figures it out from
   * @-mention or routing config.
   */
  agentTarget: string | null;
  /**
   * Stable key that groups messages into a conversation (e.g. Slack thread_ts).
   * The dispatcher uses it to look up the prior session ID for `--resume`.
   */
  threadKey?: string;
  text: string;
  user?: { id: string; display: string };
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
   */
  send?(msg: OutboundMessage): Promise<void>;
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
