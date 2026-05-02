/**
 * WebhookConnector — outbound-only HTTP POST.
 *
 * Each named destination is configured per-agent in agent.toml:
 *
 *   [[connectors.webhook]]
 *   name = "ifttt"
 *   url = "https://maker.ifttt.com/trigger/..."
 *   bearer_secret_key = "ifttt_bearer"   # optional; resolved from state/secrets/<agent>/
 *
 * Inbound webhooks are deferred to v2.
 */

import { ConnectorSendError } from "../../util/errors.js";
import type { Connector, ConnectorContext, OutboundMessage } from "../connector.js";

export interface WebhookDestination {
  name: string;
  url: string;
  /** Optional bearer token, included as "Authorization: Bearer <token>". */
  bearer?: string;
  /** Optional extra headers. */
  headers?: Record<string, string>;
}

export interface WebhookConnectorInit {
  /** Map of destination name → endpoint config. */
  destinations: ReadonlyMap<string, WebhookDestination>;
  /** Override for testing. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class WebhookConnector implements Connector {
  readonly id = "webhook";
  readonly direction = "outbound" as const;
  private readonly destinations: ReadonlyMap<string, WebhookDestination>;
  private readonly fetchImpl: typeof fetch;
  private ctx?: ConnectorContext;

  constructor(init: WebhookConnectorInit) {
    this.destinations = init.destinations;
    this.fetchImpl = init.fetchImpl ?? fetch;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const dest = this.destinations.get(msg.destination);
    if (!dest) {
      throw new ConnectorSendError(
        "webhook",
        `unknown webhook destination "${msg.destination}" (registered: ${[...this.destinations.keys()].join(", ") || "none"})`,
      );
    }

    const body =
      typeof msg.attachments === "object" && msg.attachments !== null
        ? JSON.stringify(msg.attachments)
        : JSON.stringify({ text: msg.text });
    const bytes = Buffer.byteLength(body, "utf8");

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(dest.headers ?? {}),
    };
    if (dest.bearer) headers.authorization = `Bearer ${dest.bearer}`;

    let ok = false;
    let errorClass: string | undefined;
    try {
      const res = await this.fetchImpl(dest.url, { method: "POST", headers, body });
      ok = res.ok;
      if (!ok) errorClass = `HTTP_${res.status}`;
    } catch (err) {
      errorClass = err instanceof Error ? err.name : "Error";
      this.audit(msg, dest.url, bytes, false, errorClass);
      throw new ConnectorSendError("webhook", `POST ${dest.url} failed: ${String(err)}`, {
        cause: err,
      });
    }

    this.audit(msg, dest.url, bytes, ok, errorClass);
    if (!ok) {
      throw new ConnectorSendError(
        "webhook",
        `POST ${dest.url} returned non-ok status (${errorClass ?? "unknown"})`,
      );
    }
  }

  private audit(
    msg: OutboundMessage,
    url: string,
    messageBytes: number,
    ok: boolean,
    errorClass: string | undefined,
  ): void {
    this.ctx?.audit({
      type: "connector_send",
      connectorId: this.id,
      runId: msg.runId,
      ...(msg.agent !== undefined && { agent: msg.agent }),
      destination: url,
      messageBytes,
      ok,
      ...(errorClass !== undefined && { errorClass }),
    });
  }
}
