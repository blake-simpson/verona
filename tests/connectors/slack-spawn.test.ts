import { describe, expect, it, vi } from "vitest";
import type { CapabilityCallContext, CapabilityResult } from "../../src/connectors/capability.js";
import {
  SlackOutboundClient,
  type SlackPostMessageResult,
  type SlackWebLike,
} from "../../src/connectors/slack/outbound-client.js";
import { buildSlackCapabilities } from "../../src/connectors/slack/spawn.js";

interface PostCall {
  channel: string;
  text: string;
  thread_ts?: string;
}

function buildClient(args: {
  reply: Partial<SlackPostMessageResult> & { ts?: string; channel?: string };
  recorded: PostCall[];
}): SlackOutboundClient {
  const web: SlackWebLike = {
    chat: {
      postMessage: async (a) => {
        args.recorded.push({ ...a });
        return { ok: true, ts: args.reply.ts ?? "1700.1234", channel: args.reply.channel };
      },
    },
  };
  return new SlackOutboundClient({ botToken: "xoxb-fake", webFactory: () => web });
}

function ctx(): {
  anchored: string[];
  ctx: CapabilityCallContext;
} {
  const anchored: string[] = [];
  return {
    anchored,
    ctx: {
      runId: "01TESTRUNID",
      agentName: "test-agent",
      attachmentsDir: "/tmp/verona-test/attachments",
      anchorThread: (key) => {
        anchored.push(key);
      },
    },
  };
}

describe("buildSlackCapabilities", () => {
  it("returns no capabilities when bot_token is missing", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const caps = buildSlackCapabilities({ config: { channel: "C1" }, secrets: {} });
    expect(caps).toEqual([]);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("publishes send_message + upload_attachment capabilities with JSON Schema inputs", () => {
    const recorded: PostCall[] = [];
    const client = buildClient({ reply: { ts: "T1", channel: "C1" }, recorded });
    const caps = buildSlackCapabilities({
      config: { channel: "C1" },
      secrets: { bot_token: "xoxb-x" },
      outboundFactory: () => client,
    });
    const names = caps.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["send_message", "upload_attachment"]));

    const send = caps.find((c) => c.name === "send_message")!;
    expect(send.sideEffect).toBe("write");
    const sendSchema = send.inputSchema as { type: string; required: string[]; properties: object };
    expect(sendSchema.type).toBe("object");
    expect(sendSchema.required).toEqual(["channel", "text"]);
    expect(sendSchema.properties).toMatchObject({
      channel: { type: "string" },
      text: { type: "string" },
      thread_ts: { type: "string" },
    });

    const upload = caps.find((c) => c.name === "upload_attachment")!;
    expect(upload.sideEffect).toBe("write");
    const uploadSchema = upload.inputSchema as {
      type: string;
      required: string[];
      properties: object;
    };
    expect(uploadSchema.required).toEqual(["channel", "file_path"]);
  });

  it("posts a top-level message and anchors the returned ts", async () => {
    const recorded: PostCall[] = [];
    const client = buildClient({ reply: { ts: "T-NEW", channel: "C1" }, recorded });
    const caps = buildSlackCapabilities({
      config: { channel: "C1" },
      secrets: { bot_token: "xoxb-x" },
      outboundFactory: () => client,
    });
    const { anchored, ctx: c } = ctx();

    const result: CapabilityResult = await caps[0]!.invoke({ channel: "C1", text: "hello" }, c);
    expect(recorded).toEqual([{ channel: "C1", text: "hello" }]);
    expect(result.output).toEqual({ ts: "T-NEW", channel: "C1" });
    expect(result.destination).toBe("C1");
    expect(result.threadKey).toBe("T-NEW");
    expect(anchored).toEqual(["T-NEW"]);
    expect(result.messageBytes).toBe(Buffer.byteLength("hello", "utf8"));
  });

  it("posts into an existing thread and anchors the thread_ts (not the new ts)", async () => {
    const recorded: PostCall[] = [];
    const client = buildClient({ reply: { ts: "T-REPLY", channel: "C1" }, recorded });
    const caps = buildSlackCapabilities({
      config: { channel: "C1" },
      secrets: { bot_token: "xoxb-x" },
      outboundFactory: () => client,
    });
    const { anchored, ctx: c } = ctx();
    const result = await caps[0]!.invoke(
      { channel: "C1", text: "follow-up", thread_ts: "T-PARENT" },
      c,
    );
    expect(recorded).toEqual([{ channel: "C1", text: "follow-up", thread_ts: "T-PARENT" }]);
    expect(result.threadKey).toBe("T-PARENT");
    expect(anchored).toEqual(["T-PARENT"]);
  });

  it("throws on missing channel or text", async () => {
    const recorded: PostCall[] = [];
    const client = buildClient({ reply: { ts: "T1" }, recorded });
    const caps = buildSlackCapabilities({
      config: {},
      secrets: { bot_token: "xoxb-x" },
      outboundFactory: () => client,
    });
    const { ctx: c } = ctx();
    await expect(caps[0]!.invoke({ channel: "C1" }, c)).rejects.toThrow(
      /requires non-empty.*channel.*text/,
    );
    await expect(caps[0]!.invoke({ text: "hi" }, c)).rejects.toThrow();
    expect(recorded).toEqual([]);
  });
});
