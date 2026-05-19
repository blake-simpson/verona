import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackStreamSink } from "../../src/connectors/slack/stream-sink.js";

interface Settled {
  bytes: number;
  ok: boolean;
  errorClass?: string;
}

function makeOutbound(
  overrides: Partial<Record<"postMessage" | "updateMessage" | "deleteMessage", unknown>> = {},
) {
  return {
    postMessage: vi.fn(async () => ({ ts: "p1", channel: "C1", raw: {} })),
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

function makeSink(
  outbound: ReturnType<typeof makeOutbound>,
  settled: Settled[],
  extra: { intervalMs?: number; threadKey?: string } = {},
) {
  return new SlackStreamSink({
    outbound,
    channel: "C1",
    ts: "ts-placeholder",
    intervalMs: extra.intervalMs ?? 1000,
    ...(extra.threadKey !== undefined && { threadKey: extra.threadKey }),
    onSettled: (info) => settled.push(info),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SlackStreamSink", () => {
  it("coalesces rapid pushes into one debounced chat.update with a cursor", async () => {
    const outbound = makeOutbound();
    const settled: Settled[] = [];
    const sink = makeSink(outbound, settled);

    sink.push("a");
    sink.push("ab");
    sink.push("abc");
    expect(outbound.updateMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(outbound.updateMessage).toHaveBeenCalledTimes(1);
    expect(outbound.updateMessage).toHaveBeenCalledWith({
      channel: "C1",
      ts: "ts-placeholder",
      text: "abc ▌",
    });
  });

  it("does not re-update when the snapshot is unchanged", async () => {
    const outbound = makeOutbound();
    const sink = makeSink(outbound, []);
    sink.push("same");
    await vi.advanceTimersByTimeAsync(1000);
    sink.push("same");
    await vi.advanceTimersByTimeAsync(1000);
    expect(outbound.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("tail-clamps an oversize streaming snapshot to stay under Slack's limit", async () => {
    const outbound = makeOutbound();
    const sink = makeSink(outbound, []);
    sink.push("x".repeat(5000));
    await vi.advanceTimersByTimeAsync(1000);

    const arg = (outbound.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      text: string;
    };
    expect(arg.text.startsWith("…")).toBe(true);
    expect(arg.text.endsWith(" ▌")).toBe(true);
    // body (≤3900) + cursor; comfortably under the ~4000 Slack ceiling.
    expect(arg.text.length).toBeLessThanOrEqual(3902);
  });

  it("finalize settles the message in place without the cursor and audits ok", async () => {
    const outbound = makeOutbound();
    const settled: Settled[] = [];
    const sink = makeSink(outbound, settled);

    sink.push("partial");
    await sink.finalize("the final answer");

    expect(outbound.updateMessage).toHaveBeenLastCalledWith({
      channel: "C1",
      ts: "ts-placeholder",
      text: "the final answer",
    });
    expect(settled).toEqual([{ bytes: Buffer.byteLength("the final answer"), ok: true }]);
  });

  it("finalize is idempotent and stops further streaming", async () => {
    const outbound = makeOutbound();
    const settled: Settled[] = [];
    const sink = makeSink(outbound, settled);

    await sink.finalize("done");
    await sink.finalize("done again");
    sink.push("late");
    await vi.advanceTimersByTimeAsync(2000);

    expect(outbound.updateMessage).toHaveBeenCalledTimes(1);
    expect(settled).toHaveLength(1);
  });

  it("falls back to a fresh threaded post when chat.update fails on finalize", async () => {
    const outbound = makeOutbound({
      updateMessage: vi.fn(async () => {
        throw new Error("message_not_found");
      }),
    });
    const settled: Settled[] = [];
    const sink = makeSink(outbound, settled, { threadKey: "T1" });

    await sink.finalize("recovered answer");

    expect(outbound.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "recovered answer",
      thread_ts: "T1",
    });
    expect(settled).toEqual([{ bytes: Buffer.byteLength("recovered answer"), ok: true }]);
  });

  it("reports ok:false when both update and fallback post fail", async () => {
    const outbound = makeOutbound({
      updateMessage: vi.fn(async () => {
        throw new Error("nope");
      }),
      postMessage: vi.fn(async () => {
        throw new TypeError("still nope");
      }),
    });
    const settled: Settled[] = [];
    const sink = makeSink(outbound, settled);

    await sink.finalize("answer");

    expect(settled).toEqual([
      { bytes: Buffer.byteLength("answer"), ok: false, errorClass: "TypeError" },
    ]);
  });

  it("discard deletes the placeholder, is idempotent, and silences later pushes", async () => {
    const outbound = makeOutbound();
    const sink = makeSink(outbound, []);

    await sink.discard();
    await sink.discard();
    sink.push("ignored");
    await vi.advanceTimersByTimeAsync(2000);

    expect(outbound.deleteMessage).toHaveBeenCalledTimes(1);
    expect(outbound.deleteMessage).toHaveBeenCalledWith({ channel: "C1", ts: "ts-placeholder" });
    expect(outbound.updateMessage).not.toHaveBeenCalled();
  });

  it("honours Slack rate-limit backoff without counting it as a hard failure", async () => {
    let calls = 0;
    const outbound = makeOutbound({
      updateMessage: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw { retryAfter: 2 };
        }
      }),
    });
    const sink = makeSink(outbound, []);

    sink.push("first");
    await vi.advanceTimersByTimeAsync(1000); // first attempt → rate limited
    expect(calls).toBe(1);

    sink.push("second");
    // Still inside the 2s penalty window: no retry yet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);

    // Past the penalty: it retries with the latest snapshot.
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toBe(2);
    expect(outbound.updateMessage).toHaveBeenLastCalledWith({
      channel: "C1",
      ts: "ts-placeholder",
      text: "second ▌",
    });
  });

  it("stops streaming after repeated hard failures but finalize still tries", async () => {
    const outbound = makeOutbound({
      updateMessage: vi.fn(async () => {
        throw new Error("hard");
      }),
    });
    const sink = makeSink(outbound, []);

    for (let i = 0; i < 6; i++) {
      sink.push(`snap-${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Capped at MAX_HARD_FAILURES (3); it gave up scheduling after that.
    expect((outbound.updateMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

    await sink.finalize("final");
    // finalize attempts the update, it throws, falls back to a post.
    expect(outbound.postMessage).toHaveBeenCalled();
  });
});
