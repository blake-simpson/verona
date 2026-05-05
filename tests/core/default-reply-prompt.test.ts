/**
 * Framework default reply path:
 *   - buildDefaultReplyPrompt(subs) — used when no on_message task is set
 *   - composeInboundUserMessage    — wraps the user's text in a
 *     <verona-context> block (always) plus the default directive (when
 *     no on_message task is set)
 *
 * Both run on every inbound dispatch from Daemon.handleInbound.
 */

import { describe, expect, it } from "vitest";
import type { InboundEvent } from "../../src/connectors/connector.js";
import { composeInboundUserMessage } from "../../src/core/daemon.js";
import { buildDefaultReplyPrompt } from "../../src/core/default-reply-prompt.js";
import type { SpawnSubscription } from "../../src/mcp/spawn-config.js";

function event(overrides: Partial<InboundEvent>): InboundEvent {
  return {
    connectorId: "slack",
    runId: "01TESTRUN",
    agentTarget: "test-agent",
    text: "hello bot",
    raw: {},
    ...overrides,
  };
}

function slackSub(channel: string, botToken = "xoxb-test"): SpawnSubscription {
  return {
    id: "slack",
    config: { channel },
    secrets: { bot_token: botToken },
  };
}

describe("buildDefaultReplyPrompt", () => {
  it("returns null when the agent has no subscriptions", () => {
    expect(buildDefaultReplyPrompt([])).toBeNull();
  });

  it("lists every slack capability and calls out the thread_ts rule", () => {
    const out = buildDefaultReplyPrompt([slackSub("C1")]);
    expect(out).not.toBeNull();
    const text = out as string;
    expect(text).toContain("Reply protocol");
    expect(text).toMatch(/mcp__verona__slack__send_message/);
    expect(text).toMatch(/mcp__verona__slack__upload_attachment/);
    expect(text).toMatch(/thread_ts/);
    expect(text).toMatch(/## User message/);
  });

  it("falls back to a wildcard for unknown connectors", () => {
    const sub: SpawnSubscription = {
      id: "quickbooks",
      config: { company: "Acme" },
      secrets: { token: "qb-test" },
    };
    const out = buildDefaultReplyPrompt([sub]) as string;
    expect(out).toMatch(/mcp__verona__quickbooks__\*/);
    // No Slack-specific thread_ts callout when slack isn't subscribed.
    expect(out).not.toMatch(/thread_ts/);
  });

  it("emits the slack thread_ts callout when slack is subscribed alongside others", () => {
    const sub: SpawnSubscription = {
      id: "quickbooks",
      config: {},
      secrets: { token: "qb" },
    };
    const out = buildDefaultReplyPrompt([slackSub("C1"), sub]) as string;
    expect(out).toMatch(/thread_ts/);
    expect(out).toMatch(/mcp__verona__quickbooks__\*/);
  });
});

describe("composeInboundUserMessage", () => {
  it("always emits the verona-context block with connector + channel + thread_ts", () => {
    const out = composeInboundUserMessage({
      event: event({ threadKey: "T1", channelId: "C1" }),
      subscriptions: [slackSub("C1")],
      hasOnMessageTask: true, // suppresses default directive
      defaultChannel: "C1",
    });
    expect(out).toContain("<verona-context>");
    expect(out).toContain("connector: slack");
    expect(out).toContain("channel: C1");
    expect(out).toContain("thread_ts: T1");
    expect(out).toContain("</verona-context>");
    expect(out).toContain("hello bot");
  });

  it("prepends the default reply directive when no on_message task is set", () => {
    const out = composeInboundUserMessage({
      event: event({ threadKey: "T1", channelId: "C1" }),
      subscriptions: [slackSub("C1")],
      hasOnMessageTask: false,
      defaultChannel: "C1",
    });
    expect(out).toMatch(/^# Reply protocol/);
    expect(out).toMatch(/<verona-context>/);
    expect(out).toMatch(/hello bot$/);
  });

  it("does NOT prepend the default directive when on_message task is set (override path)", () => {
    const out = composeInboundUserMessage({
      event: event({ threadKey: "T1", channelId: "C1" }),
      subscriptions: [slackSub("C1")],
      hasOnMessageTask: true,
      defaultChannel: "C1",
    });
    expect(out).not.toMatch(/^# Reply protocol/);
    expect(out).toMatch(/^<verona-context>/);
  });

  it("falls back to defaultChannel when event.channelId is absent", () => {
    const out = composeInboundUserMessage({
      event: event({ threadKey: "T1" }), // no channelId
      subscriptions: [slackSub("C-FROM-CONFIG")],
      hasOnMessageTask: true,
      defaultChannel: "C-FROM-CONFIG",
    });
    expect(out).toContain("channel: C-FROM-CONFIG");
  });

  it("omits thread_ts line when there's no threadKey (top-level message)", () => {
    const out = composeInboundUserMessage({
      event: event({ channelId: "C1" }), // no threadKey
      subscriptions: [slackSub("C1")],
      hasOnMessageTask: true,
      defaultChannel: "C1",
    });
    expect(out).not.toContain("thread_ts:");
  });

  it("when no subscriptions, still emits verona-context but no directive", () => {
    const out = composeInboundUserMessage({
      event: event({ threadKey: "T1", channelId: "C1" }),
      subscriptions: [],
      hasOnMessageTask: false,
      defaultChannel: "C1",
    });
    expect(out).not.toMatch(/^# Reply protocol/);
    expect(out).toContain("<verona-context>");
    expect(out).toContain("hello bot");
  });
});
