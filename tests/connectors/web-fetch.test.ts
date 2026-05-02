import { describe, expect, it, vi } from "vitest";
import { WebFetchConnector } from "../../src/connectors/web-fetch/index.js";
import { ConnectorSendError } from "../../src/util/errors.js";

describe("WebFetchConnector", () => {
  it("GETs and returns text + status + content-type", async () => {
    const fetchImpl = (async () =>
      new Response("<html>hi</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;
    const c = new WebFetchConnector({ fetchImpl });
    await c.start({ deliver: async () => {}, audit: () => {} });
    const r = await c.get({ url: "https://example.test/page" });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/html");
    expect(r.text).toContain("hi");
  });

  it("sets user-agent header", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const c = new WebFetchConnector({ userAgent: "verona-test/1.0", fetchImpl });
    await c.start({ deliver: async () => {}, audit: () => {} });
    await c.get({ url: "https://example.test/x" });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("verona-test/1.0");
  });

  it("throws ConnectorSendError on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const c = new WebFetchConnector({ fetchImpl });
    await c.start({ deliver: async () => {}, audit: () => {} });
    await expect(c.get({ url: "https://example.test/x" })).rejects.toBeInstanceOf(
      ConnectorSendError,
    );
  });

  it("aborts after timeoutMs", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new Error("AbortError"));
          });
        }
      });
    const c = new WebFetchConnector({ fetchImpl });
    await c.start({ deliver: async () => {}, audit: () => {} });
    await expect(c.get({ url: "https://slow.test/x", timeoutMs: 50 })).rejects.toBeInstanceOf(
      ConnectorSendError,
    );
  });
});
