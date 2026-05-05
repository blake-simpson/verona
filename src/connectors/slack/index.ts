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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { ulid } from "ulidx";
import { ConnectorSendError } from "../../util/errors.js";
import type {
  Connector,
  ConnectorContext,
  InboundAttachment,
  InboundEvent,
  OutboundMessage,
} from "../connector.js";
import { SlackOutboundClient } from "./outbound-client.js";

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
  /**
   * Optional override for testability: factory returning a Slack WebClient
   * compatible object. Defaults to the real WebClient via SlackOutboundClient.
   */
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
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFileMeta[];
}

interface SlackFileMeta {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
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
  private readonly outbound: SlackOutboundClient;
  private ctx?: ConnectorContext;

  constructor(init: SlackConnectorInit) {
    this.init = init;
    this.outbound = new SlackOutboundClient({
      botToken: init.botToken,
      ...(init.webFactory && { webFactory: init.webFactory }),
    });
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    const factory =
      this.init.socketFactory ??
      ((token: string) => new SocketModeClient({ appToken: token }) as unknown as SocketLike);
    this.socket = factory(this.init.appToken);
    this.socket.on("app_mention", (args) => this.handleAppMention(args));
    // Phase 3: thread replies without an explicit @-mention. We listen on
    // generic message events; the handler filters tightly so we only deliver
    // when the reply lands in a thread the bot anchored.
    this.socket.on("message", (args) => this.handleMessage(args));
    await this.socket.start();
  }

  /**
   * Slack Socket Mode (or @slack/socket-mode v2) occasionally re-emits the
   * same event — same `ts` arrives 2-3 times. Without dedup, each duplicate
   * spawns its own claude run and the user gets duplicate replies.
   *
   * We track the last N `event.ts` values per connector instance and skip
   * anything we've seen recently. ts is unique per Slack message, so this
   * is safe across event types (app_mention + message can share a ts and
   * we want to dedupe both).
   */
  private readonly seenEventTs: Set<string> = new Set();
  private readonly seenEventTsOrder: string[] = [];
  private static readonly SEEN_TS_LIMIT = 256;

  private isDuplicateEvent(ts: string | undefined): boolean {
    if (!ts) return false;
    if (this.seenEventTs.has(ts)) return true;
    this.seenEventTs.add(ts);
    this.seenEventTsOrder.push(ts);
    if (this.seenEventTsOrder.length > SlackConnector.SEEN_TS_LIMIT) {
      const evicted = this.seenEventTsOrder.shift();
      if (evicted !== undefined) this.seenEventTs.delete(evicted);
    }
    return false;
  }

  async stop(): Promise<void> {
    await this.socket?.disconnect();
  }

  async send(msg: OutboundMessage): Promise<void> {
    const bytes = Buffer.byteLength(msg.text, "utf8");
    try {
      await this.outbound.postMessage({
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
    if (this.isDuplicateEvent(ev.ts)) return;

    const agentTarget = this.init.channelToAgent.get(ev.channel) ?? null;
    const text = ev.text ?? "";
    const runId = ulid();

    const attachments = await this.maybeDownloadFiles(ev, runId, agentTarget);

    const event: InboundEvent = {
      connectorId: this.id,
      runId,
      kind: "mention",
      agentTarget,
      text,
      raw: ev,
      ...(ev.channel !== undefined && { channelId: ev.channel }),
      ...(ev.thread_ts !== undefined && { threadKey: ev.thread_ts }),
      ...(ev.ts !== undefined && ev.thread_ts === undefined && { threadKey: ev.ts }),
      ...(ev.user !== undefined && { user: { id: ev.user, display: ev.user } }),
      ...(attachments.length > 0 && { attachments }),
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

  /**
   * Generic message handler — routes thread replies that don't carry an
   * @-mention. The daemon's handleInbound resolves the agent via the
   * SessionStore lookup using the threadKey we set here.
   *
   * Filtered out:
   *   - bot_id present (this app's own messages)
   *   - subtype message_changed / message_deleted (no edits in v1)
   *   - top-level channel messages without thread_ts (handled by app_mention)
   *
   * NOTE: Slack delivers app_mention events as both `app_mention` AND `message`
   * with subtype undefined. We rely on the dispatch layer to dedupe — the
   * thread_reply path needs `thread_ts !== ts` AND no app_mention bot ref.
   */
  private async handleMessage(args: SocketEventArgs): Promise<void> {
    await args.ack();
    const ev = args.event;
    if (ev.type !== "message" || !ev.channel) return;

    // Filter bot's own posts and edits/deletes.
    if (ev.bot_id) return;
    if (ev.subtype === "message_changed" || ev.subtype === "message_deleted") return;

    // Only deliver thread replies in v1 (DMs deferred to a later phase).
    // Top-level channel messages without an @-mention get ignored — the
    // app_mention path handles "user wants the bot's attention".
    if (!ev.thread_ts || ev.thread_ts === ev.ts) return;

    // Dedup against re-emitted events (Slack/SDK sometimes fires the same
    // ts 2-3 times; without this each duplicate spawns its own claude run).
    if (this.isDuplicateEvent(ev.ts)) return;

    const text = ev.text ?? "";
    const runId = ulid();

    const attachments = await this.maybeDownloadFiles(ev, runId, null);

    const event: InboundEvent = {
      connectorId: this.id,
      runId,
      kind: "thread_reply",
      // Daemon resolves via SessionStore.findByThreadKey(thread_ts).
      agentTarget: null,
      text,
      raw: ev,
      threadKey: ev.thread_ts,
      ...(ev.channel !== undefined && { channelId: ev.channel }),
      ...(ev.user !== undefined && { user: { id: ev.user, display: ev.user } }),
      ...(attachments.length > 0 && { attachments }),
    };

    this.ctx?.audit({
      type: "connector_receive",
      connectorId: this.id,
      runId,
      threadKey: ev.thread_ts,
      ...(ev.user !== undefined && { fromUser: ev.user }),
      messageBytes: Buffer.byteLength(text, "utf8"),
      ok: true,
    });

    if (this.ctx) await this.ctx.deliver(event);
  }

  /**
   * Download every file attached to a Slack event into the per-run inbound
   * dir, returning a typed manifest. Best-effort: failures are logged and
   * the file is dropped from the manifest. The text portion of the message
   * still flows through.
   */
  private async maybeDownloadFiles(
    ev: SlackEventLike,
    runId: string,
    _agent: string | null,
  ): Promise<InboundAttachment[]> {
    const files = ev.files;
    if (!files || files.length === 0) return [];
    const ctx = this.ctx;
    if (!ctx?.runsDir) {
      process.stderr.write(
        "[slack] inbound files present but ctx.runsDir is not set; dropping attachments\n",
      );
      return [];
    }
    const targetDir = path.join(ctx.runsDir, runId, "inbound");
    await mkdir(targetDir, { recursive: true });

    const out: InboundAttachment[] = [];
    for (const f of files) {
      const url = f.url_private_download ?? f.url_private;
      const filename = sanitizeFilename(f.name ?? f.title ?? f.id ?? "attachment");
      if (!url) {
        process.stderr.write(`[slack] file ${filename} has no download URL; skipping\n`);
        continue;
      }
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.init.botToken}` },
        });
        if (!res.ok) {
          process.stderr.write(`[slack] download of ${filename} failed: HTTP ${res.status}\n`);
          continue;
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        const localPath = path.join(targetDir, filename);
        await writeFile(localPath, bytes);
        out.push({
          filename,
          localPath,
          size: bytes.length,
          ...(f.mimetype && { mimeType: f.mimetype }),
          ...(f.id && { source: { connectorId: this.id, ref: f.id } }),
        });
      } catch (err) {
        process.stderr.write(`[slack] download of ${filename} threw: ${String(err)}\n`);
      }
    }
    return out;
  }
}

function sanitizeFilename(name: string): string {
  // Strip path separators and control characters (anything below 0x20). The
  // explicit code-point loop avoids the control-char-in-regex lint warning
  // and works regardless of the input's encoding.
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "/" || ch === "\\" || code < 0x20) out += "_";
    else out += ch;
  }
  out = out.trim();
  return out.length > 0 ? out : "attachment";
}
