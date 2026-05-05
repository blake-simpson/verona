/**
 * connector-loader — discovers user-authored connectors at runtime and
 * dynamic-imports their compiled JS entry points.
 *
 * Layout the loader expects under `<connectorsDir>/<id>/`:
 *
 *   connector.toml      manifest (id, direction, version, entry, secrets)
 *   dist/index.js       compiled ESM, default-exports a UserConnectorFactory
 *                       (or named export `connector`)
 *
 * The loader does NOT instantiate connectors — call `instantiateUserConnector`
 * with secret + agent-subscription resolution. Splitting discovery from
 * instantiation lets the SIGHUP reload path diff the manifest versions and
 * decide which connectors to restart.
 *
 * See knowledge/architecture/connector-contract.md.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { type ConnectorManifest, ConnectorManifestSchema } from "../config/schema.js";
import type {
  Connector,
  UserConnectorFactory,
  UserConnectorInit,
} from "../connectors/connector.js";
import { getSecret } from "../secrets/store.js";
import { ConfigError } from "../util/errors.js";

export interface UserConnectorRecord {
  manifest: ConnectorManifest;
  connectorDir: string;
  factory: UserConnectorFactory;
}

/**
 * Discover and dynamic-import every user connector under `connectorsDir`.
 * Throws ConfigError on a malformed manifest or a missing entry file —
 * users see the problem at daemon startup rather than at first invocation.
 *
 * Returns [] if the dir doesn't exist (no user connectors authored yet).
 */
export async function discoverUserConnectors(
  connectorsDir: string,
): Promise<UserConnectorRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(connectorsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: UserConnectorRecord[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;

    const connectorDir = path.join(connectorsDir, ent.name);
    const manifestPath = path.join(connectorDir, "connector.toml");

    let manifestText: string;
    try {
      manifestText = await readFile(manifestPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = parseToml(manifestText);
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
    const manifest = result.data;

    if (manifest.id !== ent.name) {
      throw new ConfigError(
        `connector at ${connectorDir} has manifest id "${manifest.id}" but lives in dir "${ent.name}". Rename one to match.`,
      );
    }

    const entryAbs = path.resolve(connectorDir, manifest.entry);
    try {
      await stat(entryAbs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConfigError(
          `connector "${manifest.id}" declares entry "${manifest.entry}" but ${entryAbs} doesn't exist. Build it with \`verona connectors build ${manifest.id}\`.`,
        );
      }
      throw err;
    }

    // Cache-bust by manifest version so SIGHUP-triggered reloads pick up new
    // code after a `verona connectors build`. Node's dynamic-import cache
    // keys on the full URL, so a new `?v=` query yields a fresh module.
    const moduleUrl = `${pathToFileURL(entryAbs).href}?v=${encodeURIComponent(manifest.version)}`;
    const mod = (await import(moduleUrl)) as Record<string, unknown>;
    const factory = (mod.default ?? mod.connector) as unknown;
    if (typeof factory !== "function") {
      throw new ConfigError(
        `${entryAbs} must export a default function (or a named "connector") of type UserConnectorFactory`,
      );
    }
    records.push({ manifest, connectorDir, factory: factory as UserConnectorFactory });
  }

  return records;
}

/**
 * agent_name → the value of agent.toml's [connectors.<id>] block, grouped by
 * connector id. Built once per daemon bootstrap / reload.
 */
export type AgentSubscriptions = ReadonlyMap<
  string,
  ReadonlyMap<string, Readonly<Record<string, unknown>>>
>;

export function buildAgentSubscriptions(
  agents: ReadonlyArray<{
    agentName: string;
    config: { connectors: Record<string, unknown> };
  }>,
): AgentSubscriptions {
  const out = new Map<string, Map<string, Readonly<Record<string, unknown>>>>();
  for (const a of agents) {
    for (const [connId, cfg] of Object.entries(a.config.connectors)) {
      if (!cfg || typeof cfg !== "object") continue;
      let inner = out.get(connId);
      if (!inner) {
        inner = new Map();
        out.set(connId, inner);
      }
      inner.set(a.agentName, cfg as Record<string, unknown>);
    }
  }
  return out;
}

export interface InstantiateContext {
  secretsRoot: string;
  agentSubscriptions: AgentSubscriptions;
}

/**
 * Resolve the manifest's required secrets, build the init payload, and call
 * the factory. Returns null (with a stderr warning) if any required secret is
 * missing — caller should keep the daemon up and skip this connector.
 */
export async function instantiateUserConnector(
  record: UserConnectorRecord,
  ctx: InstantiateContext,
): Promise<Connector | null> {
  const secrets: Record<string, string> = {};
  for (const key of record.manifest.secrets) {
    const value = await getSecret(
      ctx.secretsRoot,
      { kind: "connector", id: record.manifest.id },
      key,
    );
    if (value === null) {
      process.stderr.write(
        `warning: connector "${record.manifest.id}" requires secret "${key}" but none is set. Run \`verona connectors add ${record.manifest.id}\` to fix. Connector NOT started.\n`,
      );
      return null;
    }
    secrets[key] = value.trim();
  }
  const subs =
    ctx.agentSubscriptions.get(record.manifest.id) ??
    (new Map() as ReadonlyMap<string, Readonly<Record<string, unknown>>>);
  const init: UserConnectorInit = {
    secrets,
    agentSubscriptions: subs,
  };
  const connector = await record.factory(init);
  if (connector.id !== record.manifest.id) {
    throw new ConfigError(
      `connector at ${record.connectorDir} factory returned a Connector with id "${connector.id}" but the manifest declares "${record.manifest.id}"`,
    );
  }
  return connector;
}
