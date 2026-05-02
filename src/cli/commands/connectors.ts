/**
 * `verona connectors {add,test} <id>` — interactive token capture and
 * smoke-tests for connectors.
 *
 * Tokens are written to <state>/secrets/_connectors/<id>/<key> with chmod 600.
 * Never echoed back to stdout.
 */

import { createInterface } from "node:readline/promises";
import { WebClient } from "@slack/web-api";
import { setSecret } from "../../secrets/store.js";
import { resolveStateDir, statePaths } from "../../state/paths.js";
import { ConnectorSendError, SecretError } from "../../util/errors.js";

export interface ConnectorsAddOptions {
  connectorId: string;
  stateDir?: string;
  /** When provided, skip the interactive prompt (useful for tests/scripts). */
  values?: Record<string, string>;
}

export async function runConnectorsAdd(opts: ConnectorsAddOptions): Promise<string[]> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);

  if (opts.connectorId !== "slack") {
    throw new SecretError(`unknown connector "${opts.connectorId}" (v1 supports: slack)`);
  }

  const keys = ["bot_token", "app_token"];
  const values = opts.values ?? (await promptKeys(keys));

  for (const key of keys) {
    const v = values[key];
    if (!v || v.trim().length === 0) {
      throw new SecretError(`missing value for slack/${key}`);
    }
    await setSecret(paths.secrets, { kind: "connector", id: "slack" }, key, v.trim());
  }
  return keys.map((k) => `state/secrets/_connectors/slack/${k}`);
}

async function promptKeys(keys: readonly string[]): Promise<Record<string, string>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out: Record<string, string> = {};
  try {
    for (const key of keys) {
      const value = await rl.question(`Slack ${key.replace(/_/g, " ")} (input not echoed): `);
      out[key] = value;
    }
  } finally {
    rl.close();
  }
  return out;
}

export interface ConnectorsTestOptions {
  connectorId: string;
  /** For slack, message destination (channel id or "#name"). */
  destination?: string;
  /** Override message text; defaults to a smoke-test string. */
  text?: string;
  stateDir?: string;
}

export async function runConnectorsTest(opts: ConnectorsTestOptions): Promise<string> {
  if (opts.connectorId !== "slack") {
    throw new SecretError(`unknown connector "${opts.connectorId}" (v1 supports: slack)`);
  }

  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);
  const { getSecret } = await import("../../secrets/store.js");
  const botToken = await getSecret(paths.secrets, { kind: "connector", id: "slack" }, "bot_token");
  if (!botToken)
    throw new SecretError("slack bot_token not configured; run `verona connectors add slack`");

  if (!opts.destination) {
    throw new SecretError(
      "destination is required for `verona connectors test slack` (e.g. --destination '#general')",
    );
  }

  const web = new WebClient(botToken.trim());
  try {
    await web.chat.postMessage({
      channel: opts.destination,
      text:
        opts.text ??
        `verona connector smoke test from ${process.env.USER ?? "unknown"} at ${new Date().toISOString()}`,
    });
    return `posted to ${opts.destination}`;
  } catch (err) {
    throw new ConnectorSendError("slack", `chat.postMessage failed: ${String(err)}`, {
      cause: err,
    });
  }
}
