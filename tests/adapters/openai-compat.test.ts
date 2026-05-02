import { describe, expect, it, vi } from "vitest";
import { OpenAICompatAdapter, type OpenAILikeClient } from "../../src/adapters/openai-compat.js";

function fakeClient(reply: {
  id?: string;
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): OpenAILikeClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          ...(reply.id !== undefined && { id: reply.id }),
          choices: [{ message: { content: reply.content } }],
          ...(reply.usage !== undefined && { usage: reply.usage }),
        })),
      },
    },
  };
}

describe("OpenAICompatAdapter", () => {
  it("openai variant: maps low → gpt-4o-mini and computes costUsd", async () => {
    const client = fakeClient({
      content: "ok",
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });
    const a = new OpenAICompatAdapter({ id: "openai", apiKey: "sk-test", client });
    const r = await a.invoke({
      agentName: "a",
      taskId: "t",
      systemPrompt: "",
      userPrompt: "hi",
      effort: "low",
      workingDir: "/tmp",
      cancel: new AbortController().signal,
    });
    expect(r.modelUsed).toBe("gpt-4o-mini");
    expect(r.costUsd).toBeCloseTo(0.00027, 6);
    expect(r.subscriptionCovered).toBe(false);
  });

  it("openrouter variant: medium → provider-prefixed slug, costUsd=0 (no built-in price table)", async () => {
    const client = fakeClient({
      content: "ok",
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    const a = new OpenAICompatAdapter({ id: "openrouter", apiKey: "sk-or", client });
    const r = await a.invoke({
      agentName: "a",
      taskId: "t",
      systemPrompt: "",
      userPrompt: "hi",
      effort: "medium",
      workingDir: "/tmp",
      cancel: new AbortController().signal,
    });
    expect(r.modelUsed).toContain("/");
    expect(r.costUsd).toBe(0);
  });

  it("respects per-effort overrides", async () => {
    const client = fakeClient({
      content: "ok",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const a = new OpenAICompatAdapter({
      id: "openai",
      apiKey: "sk-test",
      effortOverrides: { medium: "gpt-4o-mini" },
      client,
    });
    const r = await a.invoke({
      agentName: "a",
      taskId: "t",
      systemPrompt: "",
      userPrompt: "hi",
      effort: "medium",
      workingDir: "/tmp",
      cancel: new AbortController().signal,
    });
    expect(r.modelUsed).toBe("gpt-4o-mini");
  });
});
