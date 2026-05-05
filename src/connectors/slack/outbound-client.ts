/**
 * SlackOutboundClient — outbound-only Slack client. No Socket Mode, no
 * inbound subscriptions, no ConnectorContext. Just chat.postMessage and (in
 * Phase 3) files.uploadV2.
 *
 * Used by:
 *   - SlackConnector.send()           — daemon-side, legacy auto-post / system notifications
 *   - The per-spawn MCP server        — agent-driven `slack__send_message` capability
 *
 * Both reuse the same WebClient code path so a connector bug fix lands in
 * one place. The factor-out also keeps the spawn-side import surface narrow:
 * the MCP server doesn't pull in @slack/socket-mode.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebClient } from "@slack/web-api";

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackPostMessageResult {
  /** Message timestamp returned by Slack — usable as a future thread_ts. */
  ts: string;
  /** Channel id Slack reports the message landed in. Mirrors `input.channel`. */
  channel: string;
  /** Raw response from Slack for debugging — don't depend on shape. */
  raw: unknown;
}

export interface SlackWebLike {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<unknown>;
  };
  files?: {
    uploadV2(args: {
      channel_id: string;
      file: Buffer | string;
      filename?: string;
      initial_comment?: string;
      thread_ts?: string;
    }): Promise<unknown>;
  };
}

export interface SlackUploadFileInput {
  channel: string;
  /** Absolute path to a file inside the per-run scratch dir or agent dir. */
  filePath: string;
  /** Optional override; defaults to basename of filePath. */
  filename?: string;
  /** Optional message text accompanying the upload. */
  comment?: string;
  thread_ts?: string;
}

export interface SlackUploadFileResult {
  ok: boolean;
  file_id?: string;
  raw: unknown;
}

export interface SlackOutboundClientInit {
  botToken: string;
  /** Optional override for testability. */
  webFactory?: (botToken: string) => SlackWebLike;
}

export class SlackOutboundClient {
  private readonly web: SlackWebLike;

  constructor(init: SlackOutboundClientInit) {
    const factory =
      init.webFactory ?? ((token: string) => new WebClient(token) as unknown as SlackWebLike);
    this.web = factory(init.botToken);
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const args: { channel: string; text: string; thread_ts?: string } = {
      channel: input.channel,
      text: input.text,
      ...(input.thread_ts !== undefined && { thread_ts: input.thread_ts }),
    };
    const raw = await this.web.chat.postMessage(args);
    const obj = (raw ?? {}) as { ts?: unknown; channel?: unknown };
    const ts = typeof obj.ts === "string" ? obj.ts : "";
    const channel = typeof obj.channel === "string" ? obj.channel : input.channel;
    return { ts, channel, raw };
  }

  async uploadFile(input: SlackUploadFileInput): Promise<SlackUploadFileResult> {
    if (!this.web.files?.uploadV2) {
      throw new Error("Slack web client does not support files.uploadV2");
    }
    const filename = input.filename ?? path.basename(input.filePath);
    const buf = await readFile(input.filePath);
    const raw = await this.web.files.uploadV2({
      channel_id: input.channel,
      file: buf,
      filename,
      ...(input.comment !== undefined && { initial_comment: input.comment }),
      ...(input.thread_ts !== undefined && { thread_ts: input.thread_ts }),
    });
    const obj = (raw ?? {}) as { ok?: unknown; file?: { id?: unknown } };
    const ok = obj.ok === undefined ? true : Boolean(obj.ok);
    const fileId = typeof obj.file?.id === "string" ? obj.file.id : undefined;
    return {
      ok,
      ...(fileId !== undefined && { file_id: fileId }),
      raw,
    };
  }
}
