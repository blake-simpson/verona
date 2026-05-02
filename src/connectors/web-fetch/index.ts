/**
 * WebFetchConnector — outbound-only utility for fetching web content.
 *
 * NOTE: agents running under the claude-cli adapter already have a built-in
 * `WebFetch` tool. The recommended pattern is to add `"WebFetch"` to the
 * task's `allowed_tools` and let the agent fetch directly. This Verona-side
 * connector exists for: (a) daemon-internal or programmatic use, (b) future
 * adapters that don't ship a fetch tool, (c) centralized rate-limiting and
 * audit-logging in v2.
 *
 * v1: minimal — fetch a URL, return text + content-type. No readability
 * extraction yet (defer to claude's WebFetch which handles HTML→markdown).
 */

import { ConnectorSendError } from "../../util/errors.js";
import type { Connector, ConnectorContext } from "../connector.js";

export interface WebFetchOptions {
  url: string;
  /** Default 10000 ms. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  bytes: number;
}

export interface WebFetchConnectorInit {
  /** Default user-agent header. */
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export class WebFetchConnector implements Connector {
  readonly id = "web-fetch";
  readonly direction = "outbound" as const;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private ctx?: ConnectorContext;

  constructor(init: WebFetchConnectorInit = {}) {
    this.userAgent = init.userAgent ?? "verona/0.x (web-fetch)";
    this.fetchImpl = init.fetchImpl ?? fetch;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
  }

  /** Programmatic fetch helper. Outside the standard Connector.send shape. */
  async get(opts: WebFetchOptions): Promise<WebFetchResult> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
    try {
      const res = await this.fetchImpl(opts.url, {
        method: "GET",
        headers: { "user-agent": this.userAgent, ...(opts.headers ?? {}) },
        signal: controller.signal,
      });
      const text = await res.text();
      const result: WebFetchResult = {
        url: opts.url,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        text,
        bytes: Buffer.byteLength(text, "utf8"),
      };
      this.ctx?.audit({
        type: "connector_send",
        connectorId: this.id,
        runId: "web-fetch-direct",
        destination: opts.url,
        messageBytes: result.bytes,
        ok: res.ok,
        ...(!res.ok && { errorClass: `HTTP_${res.status}` }),
      });
      if (!res.ok) {
        throw new ConnectorSendError("web-fetch", `GET ${opts.url} returned ${res.status}`);
      }
      return result;
    } catch (err) {
      if (err instanceof ConnectorSendError) throw err;
      throw new ConnectorSendError("web-fetch", `GET ${opts.url} failed: ${String(err)}`, {
        cause: err,
      });
    } finally {
      clearTimeout(t);
    }
  }
}
