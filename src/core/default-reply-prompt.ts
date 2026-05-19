/**
 * Default reply protocol — synthesised user-prompt prefix used by the inbound
 * reply path when the agent has connector subscriptions but no `on_message`
 * task. Without this, the model frequently chooses to reply with plain text
 * and Verona's legacy auto-post path silently ships it; agents end up never
 * exercising the connector_call audit chain even though that's the whole
 * point of having tools.
 *
 * The prefix:
 *   1. Names the tools the agent actually has (built from the same spawn
 *      factory registry the MCP server uses, so the prompt and the runtime
 *      can't drift apart).
 *   2. Tells the agent its reply MUST go through a tool call.
 *   3. Calls out Slack's `thread_ts` since that's the most common foot-gun.
 *
 * Agents that want different reply behaviour declare an `[[tasks]]` block
 * with `on_message = true` — that path bypasses this synthesised prompt
 * entirely (per the contract in `knowledge/architecture/connector-contract.md`).
 */

import type { ConnectorCapability } from "../connectors/capability.js";
import type { SpawnSubscription } from "../mcp/spawn-config.js";
import { getBuiltInSpawnFactory } from "../mcp/spawn-factories.js";

/**
 * Returns a multi-line prompt prefix to prepend to the user's inbound
 * message, or null if the agent has no subscriptions (no tools to direct
 * the agent toward — fall back to the v0.3 plain-userMessage path).
 */
export function buildDefaultReplyPrompt(
  subscriptions: readonly SpawnSubscription[],
): string | null {
  if (subscriptions.length === 0) return null;

  const toolLines: string[] = [];
  let hasSlack = false;
  for (const sub of subscriptions) {
    if (sub.id === "slack") hasSlack = true;
    const factory = getBuiltInSpawnFactory(sub.id);
    if (!factory) {
      toolLines.push(`- \`mcp__verona__${sub.id}__*\` (capabilities discovered at spawn time)`);
      continue;
    }
    let caps: readonly ConnectorCapability[];
    try {
      caps = factory({ config: sub.config, secrets: sub.secrets });
    } catch {
      caps = [];
    }
    if (caps.length === 0) {
      toolLines.push(`- \`mcp__verona__${sub.id}__*\` (no capabilities published)`);
      continue;
    }
    for (const cap of caps) {
      toolLines.push(`- \`mcp__verona__${sub.id}__${cap.name}\` — ${cap.description}`);
    }
  }

  const lines: string[] = [
    "# Reply protocol",
    "",
    "A user message just routed to you via Verona's inbound flow. You have",
    "connector tools available — your reply MUST go through one of them",
    "rather than as plain assistant text.",
    "",
    "Available connector tools:",
    "",
    ...toolLines,
    "",
    "Hard rules:",
    "",
    "1. Reply by calling exactly ONE connector tool from the list above. Do",
    "   not emit plain assistant text as your reply. Verona's legacy auto-post",
    "   path will ship plain text as a fallback, but that bypasses the audit",
    "   trail this run is supposed to produce.",
  ];

  if (hasSlack) {
    lines.push(
      "2. For Slack: pass `thread_ts` so the reply lands in-thread. The value",
      "   is the `ts` you received from your prior `slack__send_message` tool",
      "   result (look in this session's tool-result history). Without",
      "   `thread_ts` your reply becomes a top-level channel post.",
    );
    lines.push("3. If the user's message genuinely doesn't warrant a reply, exit");
    lines.push("   with no tool call. Silence is acceptable.");
  } else {
    lines.push("2. If the user's message genuinely doesn't warrant a reply, exit");
    lines.push("   with no tool call. Silence is acceptable.");
  }

  lines.push("", "## User message", "");

  return lines.join("\n");
}

/**
 * Streaming variant. When the daemon has opened a live placeholder for this
 * inbound (Slack reply streaming), the *daemon* owns delivery: the agent's
 * plain assistant text is streamed into the placeholder token-by-token and
 * settled when the run ends. So here we want the opposite of the default
 * protocol — the agent must answer as plain text and must NOT call the
 * connector's send tool (that produces no stream and would double-post,
 * forcing the daemon to retract the placeholder).
 *
 * The audit trail is preserved: the daemon emits a `connector_send` record
 * when it settles the streamed message (see connector-contract.md).
 *
 * Returns null when there are no subscriptions — with no connector tools the
 * model already replies in plain text, so no steer is needed.
 */
export function buildStreamingReplyPrompt(
  subscriptions: readonly SpawnSubscription[],
): string | null {
  if (subscriptions.length === 0) return null;
  return [
    "# Reply protocol (streaming)",
    "",
    "A user message just routed to you. Your reply streams to them live,",
    "in-thread, as you write it — Verona delivers it for you.",
    "",
    "Hard rules:",
    "",
    "1. Reply as plain assistant text. Just write the answer directly.",
    "2. Do NOT call `slack__send_message` or any `mcp__verona__*` connector",
    "   tool to deliver your reply. Verona is already streaming and posting",
    "   your text for you — a tool call would double-post and kill the live",
    "   stream. (Non-connector tools like Read/WebFetch are fine for doing",
    "   the work; just don't send the reply through a tool.)",
    "3. Lead with the answer. The user watches the text appear as you type —",
    "   no preamble, no restating the question.",
    "4. If the message genuinely doesn't warrant a reply, produce no text.",
    "   Silence is acceptable.",
    "",
    "## User message",
    "",
  ].join("\n");
}
