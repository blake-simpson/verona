import { describe, expect, it, vi } from "vitest";
import type { ConnectorAuditRecord, ConnectorContext } from "../../src/connectors/connector.js";
import { WebhookConnector } from "../../src/connectors/webhook/index.js";
import { ConnectorSendError } from "../../src/util/errors.js";

function buildCtx(): { ctx: ConnectorContext; audits: ConnectorAuditRecord[] } {
  const audits: ConnectorAuditRecord[] = [];
  const ctx: ConnectorContext = {
    deliver: async () => {},
    audit: (r) => {
      audits.push(r);
    },
  };
  return { ctx, audits };
}

describe("WebhookConnector", () => {
  it("POSTs to the configured destination URL with content-type json", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const c = new WebhookConnector({
      destinations: new Map([["ifttt", { name: "ifttt", url: "https://example.test/hook" }]]),
      fetchImpl,
    });
    const { ctx } = buildCtx();
    await c.start(ctx);

    await c.send({
      connectorId: "webhook",
      runId: "01HX",
      destination: "ifttt",
      text: "hello",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://example.test/hook");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "hello" });
  });

  it("uses bearer token when destination configures one", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const c = new WebhookConnector({
      destinations: new Map([
        ["secured", { name: "secured", url: "https://example.test/api", bearer: "TOKEN_X" }],
      ]),
      fetchImpl,
    });
    const { ctx } = buildCtx();
    await c.start(ctx);

    await c.send({
      connectorId: "webhook",
      runId: "01HX",
      destination: "secured",
      text: "hi",
    });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer TOKEN_X");
  });

  it("uses attachments as body when provided (instead of {text:...})", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const c = new WebhookConnector({
      destinations: new Map([["json", { name: "json", url: "https://example.test/api" }]]),
      fetchImpl,
    });
    const { ctx } = buildCtx();
    await c.start(ctx);

    await c.send({
      connectorId: "webhook",
      runId: "01HX",
      destination: "json",
      text: "ignored",
      attachments: { event: "ping", count: 3 },
    });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ event: "ping", count: 3 });
  });

  it("rejects unknown destinations", async () => {
    const c = new WebhookConnector({ destinations: new Map() });
    const { ctx } = buildCtx();
    await c.start(ctx);
    await expect(
      c.send({ connectorId: "webhook", runId: "01HX", destination: "missing", text: "x" }),
    ).rejects.toBeInstanceOf(ConnectorSendError);
  });

  it("audits ok=true on 2xx", async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const c = new WebhookConnector({
      destinations: new Map([["d", { name: "d", url: "https://example.test/h" }]]),
      fetchImpl,
    });
    const { ctx, audits } = buildCtx();
    await c.start(ctx);
    await c.send({ connectorId: "webhook", runId: "01HX", destination: "d", text: "x" });
    expect(audits[0]?.ok).toBe(true);
  });

  it("throws and audits ok=false on non-2xx", async () => {
    const fetchImpl = (async () => new Response("oops", { status: 500 })) as typeof fetch;
    const c = new WebhookConnector({
      destinations: new Map([["d", { name: "d", url: "https://example.test/h" }]]),
      fetchImpl,
    });
    const { ctx, audits } = buildCtx();
    await c.start(ctx);
    await expect(
      c.send({ connectorId: "webhook", runId: "01HX", destination: "d", text: "x" }),
    ).rejects.toBeInstanceOf(ConnectorSendError);
    expect(audits[0]?.ok).toBe(false);
    expect(audits[0]?.errorClass).toBe("HTTP_500");
  });
});
