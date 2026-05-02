import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorContext, InboundEvent } from "../../src/connectors/connector.js";
import {
  SlackConnector,
  type SocketEventArgs,
  type SocketLike,
  type WebLike,
} from "../../src/connectors/slack/index.js";
import { ConnectorSendError } from "../../src/util/errors.js";

interface FakeSocket extends SocketLike {
  fire(event: string, args: SocketEventArgs): Promise<void>;
}

function fakeSocketFactory(socket: FakeSocket): (token: string) => FakeSocket {
  return () => socket;
}

function buildFakeSocket(): FakeSocket {
  const handlers = new Map<string, (args: SocketEventArgs) => void | Promise<void>>();
  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    async start() {},
    async disconnect() {},
    async fire(event, args) {
      const h = handlers.get(event);
      if (h) await h(args);
    },
  };
}

function buildFakeWeb(): {
  web: WebLike;
  calls: { channel: string; text: string; thread_ts?: string }[];
} {
  const calls: { channel: string; text: string; thread_ts?: string }[] = [];
  const web: WebLike = {
    chat: {
      async postMessage(args) {
        calls.push(args);
        return { ok: true };
      },
    },
  };
  return { web, calls };
}

let socket: FakeSocket;
let web: WebLike;
let postMessageCalls: { channel: string; text: string; thread_ts?: string }[];
let ctx: ConnectorContext;
let delivered: InboundEvent[];
let auditRecords: unknown[];

beforeEach(() => {
  socket = buildFakeSocket();
  const w = buildFakeWeb();
  web = w.web;
  postMessageCalls = w.calls;
  delivered = [];
  auditRecords = [];
  ctx = {
    deliver: async (e) => {
      delivered.push(e);
    },
    audit: (r) => {
      auditRecords.push(r);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlackConnector", () => {
  it("declares direction='both' and id='slack'", () => {
    const c = new SlackConnector({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelToAgent: new Map([["C123", "researcher"]]),
      socketFactory: fakeSocketFactory(socket),
      webFactory: () => web,
    });
    expect(c.id).toBe("slack");
    expect(c.direction).toBe("both");
  });

  it("on app_mention: routes to the matching agent and audits a connector_receive", async () => {
    const c = new SlackConnector({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelToAgent: new Map([["C123", "researcher"]]),
      socketFactory: fakeSocketFactory(socket),
      webFactory: () => web,
    });
    await c.start(ctx);

    let acked = false;
    await socket.fire("app_mention", {
      event: {
        type: "app_mention",
        text: "<@U_BOT> dive deeper",
        user: "U_USER",
        channel: "C123",
        ts: "1714632859.000100",
      },
      ack: async () => {
        acked = true;
      },
    });

    expect(acked).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.agentTarget).toBe("researcher");
    expect(delivered[0]?.text).toBe("<@U_BOT> dive deeper");
    expect(delivered[0]?.threadKey).toBe("1714632859.000100");
    expect(auditRecords).toHaveLength(1);
    expect((auditRecords[0] as { type: string }).type).toBe("connector_receive");
  });

  it("preserves thread_ts when message is a thread reply", async () => {
    const c = new SlackConnector({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelToAgent: new Map([["C123", "researcher"]]),
      socketFactory: fakeSocketFactory(socket),
      webFactory: () => web,
    });
    await c.start(ctx);

    await socket.fire("app_mention", {
      event: {
        type: "app_mention",
        text: "follow up",
        user: "U_USER",
        channel: "C123",
        ts: "1714632900.000200",
        thread_ts: "1714632859.000100",
      },
      ack: async () => {},
    });
    expect(delivered[0]?.threadKey).toBe("1714632859.000100");
  });

  it("routes to null agentTarget when channel isn't mapped", async () => {
    const c = new SlackConnector({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelToAgent: new Map(),
      socketFactory: fakeSocketFactory(socket),
      webFactory: () => web,
    });
    await c.start(ctx);

    await socket.fire("app_mention", {
      event: { type: "app_mention", text: "hello", channel: "C-UNKNOWN", ts: "1.1" },
      ack: async () => {},
    });
    expect(delivered[0]?.agentTarget).toBe(null);
  });

  it("send() posts to chat.postMessage with thread_ts when provided", async () => {
    const c = new SlackConnector({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelToAgent: new Map([["C123", "researcher"]]),
      socketFactory: fakeSocketFactory(socket),
      webFactory: () => web,
    });
    await c.start(ctx);

    await c.send({
      connectorId: "slack",
      runId: "01HX-TEST",
      destination: "#feed",
      text: "summary here",
      threadKey: "1714632859.000100",
    });

    expect(postMessageCalls).toHaveLength(1);
    expect(postMessageCalls[0]?.channel).toBe("#feed");
    expect(postMessageCalls[0]?.text).toBe("summary here");
    expect(postMessageCalls[0]?.thread_ts).toBe("1714632859.000100");

    const sendAudits = auditRecords.filter(
      (r) => (r as { type: string }).type === "connector_send",
    );
    expect(sendAudits).toHaveLength(1);
    expect((sendAudits[0] as { ok: boolean }).ok).toBe(true);
  });

  it("send() throws ConnectorSendError on web-api failure and audits ok=false", async () => {
    const failingWeb: WebLike = {
      chat: {
        async postMessage() {
          throw new Error("rate_limited");
        },
      },
    };
    const c = new SlackConnector({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelToAgent: new Map([["C123", "researcher"]]),
      socketFactory: fakeSocketFactory(socket),
      webFactory: () => failingWeb,
    });
    await c.start(ctx);

    await expect(
      c.send({ connectorId: "slack", runId: "01HX-TEST", destination: "#feed", text: "hi" }),
    ).rejects.toBeInstanceOf(ConnectorSendError);
    const failed = auditRecords.find((r) => (r as { type: string; ok: boolean }).ok === false);
    expect(failed).toBeDefined();
  });
});
