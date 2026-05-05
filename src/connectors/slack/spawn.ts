/**
 * Slack spawn-side factory — produces ConnectorCapability[] for a single
 * subscribed agent, given the agent's [connectors.slack] config block plus
 * the resolved bot_token secret.
 *
 * Crucially, this module imports only `./outbound-client.js` (which pulls
 * @slack/web-api), NOT `@slack/socket-mode`. The MCP server runs in the
 * spawn process; we don't want to pay socket-mode startup cost there.
 */

import type {
  CapabilityCallContext,
  CapabilityResult,
  ConnectorCapability,
} from "../capability.js";
import { SlackOutboundClient, type SlackOutboundClientInit } from "./outbound-client.js";

export interface SlackSpawnInput {
  /** Raw `[connectors.slack]` block from agent.toml. Validated lazily here. */
  config: Readonly<Record<string, unknown>>;
  /** Resolved secrets — must include `bot_token`. */
  secrets: Readonly<Record<string, string>>;
  /** Optional override for testability — same shape SlackConnector accepts. */
  outboundFactory?: (init: SlackOutboundClientInit) => SlackOutboundClient;
}

interface SendMessageInput {
  channel?: unknown;
  text?: unknown;
  thread_ts?: unknown;
}

/**
 * Build the Slack capability list for a spawn. Returns [] when the bot token
 * is missing — the spawn still starts, just without any Slack tools.
 */
export function buildSlackCapabilities(input: SlackSpawnInput): readonly ConnectorCapability[] {
  const botToken = input.secrets.bot_token;
  if (!botToken) {
    process.stderr.write(
      "[verona-mcp][slack] no bot_token secret — slack capabilities unavailable for this spawn\n",
    );
    return [];
  }

  const client = input.outboundFactory
    ? input.outboundFactory({ botToken })
    : new SlackOutboundClient({ botToken });

  return [makeSendMessageCapability(client), makeUploadAttachmentCapability(client)];
}

interface UploadAttachmentInput {
  channel?: unknown;
  file_path?: unknown;
  filename?: unknown;
  comment?: unknown;
  thread_ts?: unknown;
}

function makeUploadAttachmentCapability(client: SlackOutboundClient): ConnectorCapability {
  return {
    name: "upload_attachment",
    description:
      "Upload a file from the per-run scratch dir (or another agent-readable path) to a Slack channel or DM. Optional thread_ts to post inside an existing thread. Returns the Slack file_id when available.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel id (C0123…), DM user id, or DM channel id",
        },
        file_path: {
          type: "string",
          description:
            "Absolute local path to the file, e.g. /…/runs/<runId>/inbound/foo.png or a path the agent staged itself",
        },
        filename: {
          type: "string",
          description: "Optional. Defaults to basename(file_path).",
        },
        comment: {
          type: "string",
          description: "Optional message text to post alongside the upload.",
        },
        thread_ts: {
          type: "string",
          description: "Optional. Reply-into-thread anchor.",
        },
      },
      required: ["channel", "file_path"],
    },
    sideEffect: "write",
    invoke: async (rawInput: unknown, ctx: CapabilityCallContext): Promise<CapabilityResult> => {
      const input = (rawInput ?? {}) as UploadAttachmentInput;
      const channel = typeof input.channel === "string" ? input.channel : "";
      const filePath = typeof input.file_path === "string" ? input.file_path : "";
      const filename = typeof input.filename === "string" ? input.filename : undefined;
      const comment = typeof input.comment === "string" ? input.comment : undefined;
      const thread_ts = typeof input.thread_ts === "string" ? input.thread_ts : undefined;
      if (!channel || !filePath) {
        throw new Error("slack:upload_attachment requires non-empty 'channel' and 'file_path'");
      }
      const result = await client.uploadFile({
        channel,
        filePath,
        ...(filename && { filename }),
        ...(comment && { comment }),
        ...(thread_ts && { thread_ts }),
      });
      // For a thread upload, anchor on thread_ts (re-anchor is safe).
      if (thread_ts) ctx.anchorThread(thread_ts);
      return {
        output: { ok: result.ok, file_id: result.file_id ?? null },
        destination: channel,
        ...(thread_ts && { threadKey: thread_ts }),
      };
    },
  };
}

function makeSendMessageCapability(client: SlackOutboundClient): ConnectorCapability {
  return {
    name: "send_message",
    description:
      "Post a message to a Slack channel or DM. Returns the Slack message ts, which becomes the thread_ts for any future replies. Pass thread_ts to reply into an existing thread.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel id (e.g. C0123…), DM user id (e.g. U0123…), or #channel-name",
        },
        text: { type: "string", description: "Message body (plain text or Slack mrkdwn)" },
        thread_ts: {
          type: "string",
          description:
            "Optional. Pass to reply inside an existing thread; the value is the parent message's ts.",
        },
      },
      required: ["channel", "text"],
    },
    sideEffect: "write",
    invoke: async (rawInput: unknown, ctx: CapabilityCallContext): Promise<CapabilityResult> => {
      const input = (rawInput ?? {}) as SendMessageInput;
      const channel = typeof input.channel === "string" ? input.channel : "";
      const text = typeof input.text === "string" ? input.text : "";
      const thread_ts = typeof input.thread_ts === "string" ? input.thread_ts : undefined;
      if (!channel || !text) {
        throw new Error("slack:send_message requires non-empty 'channel' and 'text'");
      }
      const sent = await client.postMessage({
        channel,
        text,
        ...(thread_ts && { thread_ts }),
      });

      // Anchor: register the future thread for session resume. For a new
      // top-level message the thread anchor is the just-returned ts. For a
      // reply, we anchor on the thread_ts the agent passed (re-anchoring is
      // safe — SessionStore.setSession overwrites).
      const threadKey = thread_ts ?? sent.ts;
      if (threadKey) {
        ctx.anchorThread(threadKey);
      }

      return {
        output: { ts: sent.ts, channel: sent.channel },
        destination: channel,
        ...(threadKey && { threadKey }),
        messageBytes: Buffer.byteLength(text, "utf8"),
      };
    },
  };
}
