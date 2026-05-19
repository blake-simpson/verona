/**
 * SlackStreamSink — turns a stream of accumulating assistant-text snapshots
 * into a single Slack message that gets edited in place while the run is
 * still in flight, then settled (or retracted) once it finishes.
 *
 * This is daemon-side, inbound-reply only: a human is actively waiting in the
 * thread, so the daemon owns a live transcript of the reply-in-progress. It
 * is NOT a revival of `post_response` — the agent still decides the *answer*
 * (via `slack__send_message`); if it posts for itself the placeholder is
 * retracted via `discard()`. See knowledge/architecture/connector-contract.md.
 *
 * Responsibilities the sink owns so callers don't have to:
 *   - debounce: at most one chat.update per `intervalMs`, coalescing snapshots
 *   - truncation: Slack's plain-text arg caps ~4000 chars
 *   - backoff: respect Slack rate-limit `retryAfter`, give up gracefully
 */

import type { SlackOutboundClient } from "./outbound-client.js";

/** Slack's plain-text arg limit is ~4000; stay clear of the edge. */
const MAX_TEXT = 3900;
const STREAM_CURSOR = " ▌";

export interface SlackStreamSinkInit {
  outbound: Pick<SlackOutboundClient, "postMessage" | "updateMessage" | "deleteMessage">;
  channel: string;
  /** ts of the placeholder message this sink edits. */
  ts: string;
  threadKey?: string;
  /** Min gap between chat.update calls. Default 1500ms (well under Slack Tier-3). */
  intervalMs?: number;
  /**
   * Called once the reply is settled (finalize succeeded or its fallback
   * post did). Lets the connector emit a `connector_send` audit record with
   * parity to the legacy auto-post path.
   */
  onSettled?: (info: { bytes: number; ok: boolean; errorClass?: string }) => void;
}

export interface ConnectorStreamLike {
  push(snapshot: string): void;
  finalize(text: string): Promise<void>;
  discard(): Promise<void>;
}

/** Keep the most recent `MAX_TEXT` chars — the live tail is what a human watches. */
function tailClamp(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  return `…${s.slice(s.length - MAX_TEXT + 1)}`;
}

/** Keep the head — a settled answer reads from the top. */
function headClamp(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  return `${s.slice(0, MAX_TEXT - 2)}…`;
}

function retryAfterSeconds(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { retryAfter?: unknown; data?: { retry_after?: unknown } };
  if (typeof e.retryAfter === "number") return e.retryAfter;
  if (typeof e.data?.retry_after === "number") return e.data.retry_after;
  return null;
}

export class SlackStreamSink implements ConnectorStreamLike {
  private readonly init: SlackStreamSinkInit;
  private readonly intervalMs: number;
  private latest = "";
  private rendered = "";
  private timer: NodeJS.Timeout | null = null;
  private lastUpdateAt = 0;
  private closed = false;
  /** After repeated hard failures, stop trying to edit; finalize still tries once. */
  private hardFailures = 0;
  private static readonly MAX_HARD_FAILURES = 3;

  constructor(init: SlackStreamSinkInit) {
    this.init = init;
    this.intervalMs = init.intervalMs ?? 1500;
  }

  push(snapshot: string): void {
    if (this.closed) return;
    this.latest = snapshot;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed || this.hardFailures >= SlackStreamSink.MAX_HARD_FAILURES) {
      return;
    }
    const since = Date.now() - this.lastUpdateAt;
    const wait = Math.max(0, this.intervalMs - since);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    const body = tailClamp(this.latest);
    if (body.length === 0 || body === this.rendered) return;
    const text = `${body}${STREAM_CURSOR}`;
    try {
      await this.init.outbound.updateMessage({
        channel: this.init.channel,
        ts: this.init.ts,
        text,
      });
      this.rendered = body;
      this.lastUpdateAt = Date.now();
      this.hardFailures = 0;
    } catch (err) {
      const retry = retryAfterSeconds(err);
      if (retry !== null) {
        // Honour Slack's backoff, then resume from the latest snapshot.
        this.lastUpdateAt = Date.now() + retry * 1000;
        this.schedule();
        return;
      }
      this.hardFailures += 1;
      // Stop scheduling once we've given up; finalize() still attempts a
      // last write / fallback post so the user is not left with "…".
    }
  }

  async finalize(finalText: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const text = headClamp(finalText.trim().length > 0 ? finalText : this.latest);
    const bytes = Buffer.byteLength(text, "utf8");
    try {
      await this.init.outbound.updateMessage({
        channel: this.init.channel,
        ts: this.init.ts,
        text,
      });
      this.init.onSettled?.({ bytes, ok: true });
    } catch {
      // chat.update failed (rate-limited out, message gone). Fall back to a
      // fresh post so the answer still lands.
      try {
        await this.init.outbound.postMessage({
          channel: this.init.channel,
          text,
          ...(this.init.threadKey !== undefined && { thread_ts: this.init.threadKey }),
        });
        this.init.onSettled?.({ bytes, ok: true });
      } catch (postErr) {
        const errorClass = postErr instanceof Error ? postErr.name : "Error";
        this.init.onSettled?.({ bytes, ok: false, errorClass });
      }
    }
  }

  async discard(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await this.init.outbound.deleteMessage({ channel: this.init.channel, ts: this.init.ts });
    } catch {
      // Best effort — a lingering "…" placeholder is cosmetic, not a failure
      // worth surfacing. The agent's own message is the real reply.
    }
  }
}
