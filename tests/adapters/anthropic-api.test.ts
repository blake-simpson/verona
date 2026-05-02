import { describe, expect, it, vi } from "vitest";
import { AnthropicApiAdapter, type AnthropicLikeClient } from "../../src/adapters/anthropic-api.js";

function fakeClient(
  reply: Partial<Awaited<ReturnType<AnthropicLikeClient["messages"]["create"]>>>,
): AnthropicLikeClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        id: "msg_x",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 0, output_tokens: 0 },
        ...reply,
      })),
    },
  };
}

describe("AnthropicApiAdapter", () => {
  it("returns subscriptionCovered=false and a real costUsd computed from tokens", async () => {
    const client = fakeClient({
      id: "msg_test_1",
      content: [{ type: "text", text: "hello world" }],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const adapter = new AnthropicApiAdapter({ apiKey: "sk-ant-test", client });
    const response = await adapter.invoke({
      agentName: "tester",
      taskId: "t",
      systemPrompt: "you are tester",
      userPrompt: "hi",
      effort: "medium",
      workingDir: "/tmp",
      cancel: new AbortController().signal,
    });

    expect(response.subscriptionCovered).toBe(false);
    expect(response.text).toBe("hello world");
    expect(response.tokens.input).toBe(1000);
    expect(response.tokens.output).toBe(500);
    expect(response.modelUsed).toBe("claude-sonnet-4-6");
    expect(response.costUsd).toBeCloseTo(0.0105, 6);
  });

  it("respects effort → model mapping (high → opus)", async () => {
    const client = fakeClient({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const adapter = new AnthropicApiAdapter({ apiKey: "sk-ant-test", client });
    const r = await adapter.invoke({
      agentName: "a",
      taskId: "t",
      systemPrompt: "",
      userPrompt: "",
      effort: "high",
      workingDir: "/tmp",
      cancel: new AbortController().signal,
    });
    expect(r.modelUsed).toBe("claude-opus-4-7");
  });

  it("filters non-text content blocks from the joined text", async () => {
    const client = fakeClient({
      content: [
        { type: "text", text: "before " },
        { type: "tool_use", text: undefined },
        { type: "text", text: "after" },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const adapter = new AnthropicApiAdapter({ apiKey: "sk-ant-test", client });
    const r = await adapter.invoke({
      agentName: "a",
      taskId: "t",
      systemPrompt: "",
      userPrompt: "",
      effort: "medium",
      workingDir: "/tmp",
      cancel: new AbortController().signal,
    });
    expect(r.text).toBe("before after");
  });
});
