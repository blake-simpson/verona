/**
 * SlackConnector — bidirectional Slack via Socket Mode (WebSocket).
 *
 *   inbound:  app_mention events → ConnectorContext.deliver(InboundEvent)
 *   outbound: send(OutboundMessage) → web-api chat.postMessage
 *
 * Auth: bot_token (xoxb-) for the Web API, app_token (xapp-) for the
 * Socket Mode client. Both stored in <state>/secrets/_connectors/slack/.
 *
 * See knowledge/architecture/connector-contract.md for the invariants.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { ulid } from "ulidx";
import { ConnectorSendError } from "../../util/errors.js";
import type { Connector, ConnectorContext, InboundEvent, OutboundMessage } from "../connector.js";

export interface SlackConnectorInit {
  botToken: string;
  appToken: string;
  /**
   * Map of Slack channel id (or name with leading "#") → agent name.
   * Inbound app_mention events route to the matching agent.
   */
  channelToAgent: ReadonlyMap<string, string>;
  /**
   * Optional override for testability: factory returning a SocketModeClient
   * compatible object. Defaults to constructing the real one.
   */
  socketFactory?: (appToken: string) => SocketLike;
  /** Same for the WebClient (outbound). */
  webFactory?: (botToken: string) => WebLike;
}

export interface SocketLike {
  on(event: string, handler: (args: SocketEventArgs) => void | Promise<void>): void;
  start(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface SocketEventArgs {
  event: SlackEventLike;
  ack: () => Promise<void>;
}

interface SlackEventLike {
  type: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

export interface WebLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<unknown>;
  };
}

export class SlackConnector implements Connector {
  readonly id = "slack";
  readonly direction = "both" as const;
  private readonly init: SlackConnectorInit;
  private socket?: SocketLike;
  private web: WebLike;
  private ctx?: ConnectorContext;

  constructor(init: SlackConnectorInit) {
    this.init = init;
    const factory =
      init.webFactory ?? ((token: string) => new WebClient(token) as unknown as WebLike);
    this.web = factory(init.botToken);
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    const factory =
      this.init.socketFactory ??
      ((token: string) => new SocketModeClient({ appToken: token }) as unknown as SocketLike);
    this.socket = factory(this.init.appToken);
    this.socket.on("app_mention", (args) => this.handleAppMention(args));
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket?.disconnect();
  }

  async send(msg: OutboundMessage): Promise<void> {
    const bytes = Buffer.byteLength(msg.text, "utf8");
    try {
      await this.web.chat.postMessage({
        channel: msg.destination,
        text: msg.text,
        ...(msg.threadKey !== undefined && { thread_ts: msg.threadKey }),
      });
      this.ctx?.audit({
        type: "connector_send",
        connectorId: this.id,
        runId: msg.runId,
        ...(msg.agent !== undefined && { agent: msg.agent }),
        destination: msg.destination,
        ...(msg.threadKey !== undefined && { threadKey: msg.threadKey }),
        messageBytes: bytes,
        ok: true,
      });
    } catch (err) {
      const cls = err instanceof Error ? err.name : "Error";
      this.ctx?.audit({
        type: "connector_send",
        connectorId: this.id,
        runId: msg.runId,
        ...(msg.agent !== undefined && { agent: msg.agent }),
        destination: msg.destination,
        ...(msg.threadKey !== undefined && { threadKey: msg.threadKey }),
        messageBytes: bytes,
        ok: false,
        errorClass: cls,
      });
      throw new ConnectorSendError("slack", `chat.postMessage failed: ${String(err)}`, {
        cause: err,
      });
    }
  }

  private async handleAppMention(args: SocketEventArgs): Promise<void> {
    await args.ack();
    const ev = args.event;
    if (ev.type !== "app_mention" || !ev.channel) return;

    const agentTarget = this.init.channelToAgent.get(ev.channel) ?? null;
    const text = ev.text ?? "";
    const runId = ulid();
    const event: InboundEvent = {
      connectorId: this.id,
      runId,
      agentTarget,
      text,
      raw: ev,
      ...(ev.thread_ts !== undefined && { threadKey: ev.thread_ts }),
      ...(ev.ts !== undefined && ev.thread_ts === undefined && { threadKey: ev.ts }),
      ...(ev.user !== undefined && { user: { id: ev.user, display: ev.user } }),
    };

    this.ctx?.audit({
      type: "connector_receive",
      connectorId: this.id,
      runId,
      ...(agentTarget !== null && { agent: agentTarget }),
      ...(event.threadKey !== undefined && { threadKey: event.threadKey }),
      ...(ev.user !== undefined && { fromUser: ev.user }),
      messageBytes: Buffer.byteLength(text, "utf8"),
      ok: true,
    });

    if (this.ctx) await this.ctx.deliver(event);
  }
}
