/**
 * openai-compat adapter — implements both `openai` and `openrouter` IDs.
 *
 * The same code path drives both: OpenAI direct, or OpenRouter via baseURL
 * override. Pick the variant via the `id` constructor option.
 */

import OpenAI from "openai";
import { AdapterError } from "../util/errors.js";
import type {
  AIAdapter,
  AdapterId,
  AdapterRequest,
  AdapterResponse,
  AdapterTokenUsage,
} from "./adapter.js";
import { resolveOpenAiEffort, resolveOpenRouterEffort } from "./effort-mapping.js";
import { computeCostUsd, lookupPricing } from "./pricing.js";

export interface OpenAILikeClient {
  chat: {
    completions: {
      create(
        params: {
          model: string;
          messages: { role: "system" | "user"; content: string }[];
        },
        opts?: { signal?: AbortSignal },
      ): Promise<{
        id?: string;
        choices: { message: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

export interface OpenAICompatAdapterOptions {
  /** "openai" or "openrouter" — determines the AdapterId reported and the default base URL. */
  id: "openai" | "openrouter";
  apiKey: string;
  /** Override base URL (for OpenRouter or self-hosted OpenAI-compatible endpoints). */
  baseURL?: string;
  effortOverrides?: Partial<Record<AdapterRequest["effort"], string>>;
  /** Override for testing. */
  client?: OpenAILikeClient;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenAICompatAdapter implements AIAdapter {
  readonly id: AdapterId;
  private readonly client: OpenAILikeClient;
  private readonly options: OpenAICompatAdapterOptions;

  constructor(options: OpenAICompatAdapterOptions) {
    this.options = options;
    this.id = options.id;
    if (options.client) {
      this.client = options.client;
    } else {
      const baseURL =
        options.baseURL ?? (options.id === "openrouter" ? OPENROUTER_BASE_URL : undefined);
      this.client = new OpenAI({
        apiKey: options.apiKey,
        ...(baseURL !== undefined && { baseURL }),
      }) as unknown as OpenAILikeClient;
    }
  }

  async invoke(req: AdapterRequest): Promise<AdapterResponse> {
    const model =
      this.id === "openrouter"
        ? resolveOpenRouterEffort(req.effort, this.options.effortOverrides)
        : resolveOpenAiEffort(req.effort, this.options.effortOverrides);

    const startedAt = Date.now();
    let response: Awaited<ReturnType<OpenAILikeClient["chat"]["completions"]["create"]>>;
    try {
      response = await this.client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.userPrompt },
          ],
        },
        { signal: req.cancel },
      );
    } catch (err) {
      throw new AdapterError(this.id, `chat.completions.create failed: ${String(err)}`, {
        cause: err,
      });
    }
    const durationMs = Date.now() - startedAt;

    const text = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;
    const tokens: AdapterTokenUsage = {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
    };

    // Cost: OpenAI direct → use our pricing table by model. OpenRouter →
    // pricing is per-model and varies; without a fetched price feed we
    // report 0 (caller should configure pricing overrides if they need
    // accurate costs for OpenRouter).
    let costUsd = 0;
    if (this.id === "openai") {
      const pricing = lookupPricing("openai", model);
      if (pricing) costUsd = computeCostUsd(tokens, pricing);
    }

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
