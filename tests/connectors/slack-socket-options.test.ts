import { LogLevel } from "@slack/socket-mode";
import { afterEach, describe, expect, it } from "vitest";
import { buildSocketModeOptions } from "../../src/connectors/slack/index.js";

const ENV_KEYS = [
  "VERONA_SLACK_CLIENT_PING_TIMEOUT_MS",
  "VERONA_SLACK_SERVER_PING_TIMEOUT_MS",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("buildSocketModeOptions", () => {
  it("widens ping timeouts past the 5s library default and keeps auto-reconnect on", () => {
    const opts = buildSocketModeOptions("xapp-token");
    expect(opts.appToken).toBe("xapp-token");
    expect(opts.autoReconnectEnabled).toBe(true);
    // The whole point of the fix: a brief blip must not trip the 5s default.
    expect(opts.clientPingTimeout).toBe(20_000);
    expect(opts.serverPingTimeout).toBe(60_000);
    expect(opts.clientPingTimeout).toBeGreaterThan(5_000);
    expect(opts.logLevel).toBe(LogLevel.WARN);
  });

  it("honours positive env overrides for on-host tuning", () => {
    process.env.VERONA_SLACK_CLIENT_PING_TIMEOUT_MS = "30000";
    process.env.VERONA_SLACK_SERVER_PING_TIMEOUT_MS = "90000";
    const opts = buildSocketModeOptions("t");
    expect(opts.clientPingTimeout).toBe(30_000);
    expect(opts.serverPingTimeout).toBe(90_000);
  });

  it("ignores blank, zero, negative, and non-numeric overrides", () => {
    for (const bad of ["", "  ", "0", "-1", "abc", "NaN"]) {
      process.env.VERONA_SLACK_CLIENT_PING_TIMEOUT_MS = bad;
      expect(buildSocketModeOptions("t").clientPingTimeout).toBe(20_000);
    }
  });

  it("floors fractional overrides to whole milliseconds", () => {
    process.env.VERONA_SLACK_CLIENT_PING_TIMEOUT_MS = "12345.67";
    expect(buildSocketModeOptions("t").clientPingTimeout).toBe(12_345);
  });
});
