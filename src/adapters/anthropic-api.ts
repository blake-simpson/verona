/**
 * anthropic-api adapter — uses @anthropic-ai/sdk with an API key.
 *
 * Use this adapter when you want metered API-key billing instead of the
 * subscription auth that claude-cli provides.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AdapterError } from "../util/errors.js";
import type { AIAdapter, AdapterRequest, AdapterResponse, AdapterTokenUsage } from "./adapter.js";
import { resolveAnthropicApiEffort } from "./effort-mapping.js";
import { computeCostUsd, lookupPricing } from "./pricing.js";

export interface AnthropicLikeClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        system: string;
        messages: { role: "user"; content: string }[];
      },
      opts?: { signal?: AbortSignal },
    ): Promise<{
      id?: string;
      content: { type: string; text?: string }[];
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
    }>;
  };
}

export interface AnthropicApiAdapterOptions {
  apiKey: string;
  effortOverrides?: Partial<Record<AdapterRequest["effort"], string>>;
  /** Override for testing. */
  client?: AnthropicLikeClient;
}

export class AnthropicApiAdapter implements AIAdapter {
  readonly id = "anthropic-api" as const;
  private readonly client: AnthropicLikeClient;
  private readonly options: AnthropicApiAdapterOptions;

  constructor(options: AnthropicApiAdapterOptions) {
    this.options = options;
    this.client =
      options.client ??
      (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicLikeClient);
  }

  async invoke(req: AdapterRequest): Promise<AdapterResponse> {
    const model = resolveAnthropicApiEffort(req.effort, this.options.effortOverrides);
    const startedAt = Date.now();
    let response: Awaited<ReturnType<AnthropicLikeClient["messages"]["create"]>>;
    try {
      response = await this.client.messages.create(
        {
          model,
          max_tokens: 4096,
          system: req.systemPrompt,
          messages: [{ role: "user", content: req.userPrompt }],
        },
        { signal: req.cancel },
      );
    } catch (err) {
      throw new AdapterError("anthropic-api", `messages.create failed: ${String(err)}`, {
        cause: err,
      });
    }
    const durationMs = Date.now() - startedAt;
    const text = response.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

    const usage = response.usage;
    const tokens: AdapterTokenUsage = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      ...(typeof usage.cache_read_input_tokens === "number" && {
        cacheRead: usage.cache_read_input_tokens,
      }),
      ...(typeof usage.cache_creation_input_tokens === "number" && {
        cacheWrite: usage.cache_creation_input_tokens,
      }),
    };

    const pricing = lookupPricing("anthropic", model);
    const costUsd = pricing ? computeCostUsd(tokens, pricing) : 0;

    return {
      text,
      tokens,
      costUsd,
      subscriptionCovered: false,
      modelUsed: model,
      toolCalls: 0,
      durationMs,
      ...(response.id !== undefined && { sessionId: response.id }),
    };
  }
}
