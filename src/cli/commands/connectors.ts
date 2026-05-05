/**
 * `verona connectors {add,test,build} <id>` — manage user connectors.
 *
 *   add   — interactively capture the manifest's required secrets. Built-ins
 *           (slack) keep their hardcoded key list; user connectors read
 *           `secrets = [...]` from connector.toml.
 *   test  — smoke-test a built-in connector.
 *   build — esbuild the connector's src/index.ts → manifest.entry.
 *
 * Tokens are written to <state>/secrets/_connectors/<id>/<key> with chmod 600.
 * Never echoed back to stdout.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { WebClient } from "@slack/web-api";
import * as esbuild from "esbuild";
import { parse as parseToml } from "smol-toml";
import { type ConnectorManifest, ConnectorManifestSchema } from "../../config/schema.js";
import { getSecret, setSecret } from "../../secrets/store.js";
import {
  resolveConnectorsDir,
  resolveStateDir,
  statePaths,
  userConnectorDir,
} from "../../state/paths.js";
import { ConfigError, ConnectorSendError, SecretError } from "../../util/errors.js";

/**
 * Built-in connectors — their secret keys are hardcoded here so users don't
 * need a manifest to configure tokens for stock features.
 */
const BUILTIN_CONNECTOR_SECRETS: Record<string, readonly string[]> = {
  slack: ["bot_token", "app_token"],
};

export interface ConnectorsAddOptions {
  connectorId: string;
  stateDir?: string;
  /** Override resolveConnectorsDir() for tests / unusual layouts. */
  connectorsDir?: string;
  /** When provided, skip the interactive prompt (useful for tests/scripts). */
  values?: Record<string, string>;
}

export async function runConnectorsAdd(opts: ConnectorsAddOptions): Promise<string[]> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);

  const keys = await resolveSecretKeys(opts.connectorId, opts.connectorsDir);
  if (keys.length === 0) {
    process.stdout.write(
      `connector "${opts.connectorId}" declares no secrets — nothing to capture.\n`,
    );
    return [];
  }

  const values = opts.values ?? (await promptKeys(opts.connectorId, keys));
  for (const key of keys) {
    const v = values[key];
    if (!v || v.trim().length === 0) {
      throw new SecretError(`missing value for ${opts.connectorId}/${key}`);
    }
    await setSecret(paths.secrets, { kind: "connector", id: opts.connectorId }, key, v.trim());
  }
  return keys.map((k) => `state/secrets/_connectors/${opts.connectorId}/${k}`);
}

async function resolveSecretKeys(
  connectorId: string,
  connectorsDirOverride: string | undefined,
): Promise<readonly string[]> {
  const builtin = BUILTIN_CONNECTOR_SECRETS[connectorId];
  if (builtin) return builtin;

  const connectorsDir = resolveConnectorsDir(connectorsDirOverride);
  const cdir = userConnectorDir(connectorsDir, connectorId);
  const manifest = await readUserManifest(cdir, connectorId);
  return manifest.secrets;
}

async function readUserManifest(
  connectorDir: string,
  expectedId: string,
): Promise<ConnectorManifest> {
  const manifestPath = path.join(connectorDir, "connector.toml");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const builtins = Object.keys(BUILTIN_CONNECTOR_SECRETS).join(", ");
      throw new ConfigError(
        `unknown connector "${expectedId}" — no manifest at ${manifestPath}. Built-in connectors: ${builtins}. Scaffold a user connector with the /verona:new-connector skill.`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError(`failed to parse ${manifestPath}`, { cause: err });
  }
  const result = ConnectorManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`${manifestPath} validation failed: ${issues}`);
  }
  if (result.data.id !== expectedId) {
    throw new ConfigError(
      `connector at ${connectorDir} declares id "${result.data.id}" but you asked for "${expectedId}"`,
    );
  }
  return result.data;
}

async function promptKeys(
  connectorId: string,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out: Record<string, string> = {};
  try {
    for (const key of keys) {
      const value = await rl.question(
        `${connectorId} ${key.replace(/_/g, " ")} (input not echoed): `,
      );
      out[key] = value;
    }
  } finally {
    rl.close();
  }
  return out;
}

export interface ConnectorsTestOptions {
  connectorId: string;
  destination?: string;
  text?: string;
  stateDir?: string;
}

export async function runConnectorsTest(opts: ConnectorsTestOptions): Promise<string> {
  if (opts.connectorId === "slack") return testSlack(opts);
  throw new SecretError(
    `\`verona connectors test\` is implemented for built-in connectors only (slack). For your own connector, write a smoke test inside the connector's package.`,
  );
}

async function testSlack(opts: ConnectorsTestOptions): Promise<string> {
  const stateDir = resolveStateDir(opts.stateDir);
  const paths = statePaths(stateDir);
  const botToken = await getSecret(paths.secrets, { kind: "connector", id: "slack" }, "bot_token");
  if (!botToken) {
    throw new SecretError("slack bot_token not configured; run `verona connectors add slack`");
  }
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

export interface ConnectorsBuildOptions {
  connectorId: string;
  connectorsDir?: string;
}

export interface ConnectorsBuildResult {
  connectorDir: string;
  source: string;
  output: string;
  bytes: number;
}

const BUILD_SOURCE_CANDIDATES = ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.mjs"];

export async function runConnectorsBuild(
  opts: ConnectorsBuildOptions,
): Promise<ConnectorsBuildResult> {
  const connectorsDir = resolveConnectorsDir(opts.connectorsDir);
  const cdir = userConnectorDir(connectorsDir, opts.connectorId);
  const manifest = await readUserManifest(cdir, opts.connectorId);

  let source: string | null = null;
  for (const cand of BUILD_SOURCE_CANDIDATES) {
    const p = path.join(cdir, cand);
    try {
      await stat(p);
      source = p;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  if (!source) {
    throw new ConfigError(
      `no source file found for "${opts.connectorId}". Looked for: ${BUILD_SOURCE_CANDIDATES.map((s) => path.join(cdir, s)).join(", ")}`,
    );
  }

  const output = path.resolve(cdir, manifest.entry);
  const result = await esbuild.build({
    entryPoints: [source],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    sourcemap: false,
    logLevel: "warning",
  });

  if (result.errors.length > 0) {
    const summary = result.errors.map((e) => e.text).join("; ");
    throw new ConfigError(`esbuild reported ${result.errors.length} errors: ${summary}`);
  }

  const st = await stat(output);
  return { connectorDir: cdir, source, output, bytes: st.size };
}
