/**
 * Spawn-side connector factory registry.
 *
 * The MCP server (running in the spawn process) calls each registered factory
 * once per subscribed connector to obtain its capabilities. Factories are
 * intentionally narrow: they take only what's needed to invoke capabilities
 * (config + secrets), never the daemon-side ConnectorContext, and never
 * @slack/socket-mode-style long-lived I/O imports.
 *
 * Built-ins are statically registered here. User connectors load via
 * dynamic-import using the same `<connectorsDir>/<id>/<entry>` convention as
 * the daemon's loader; their default-exported factory is expected to return
 * a Connector with a `capabilities()` method.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorCapability } from "../connectors/capability.js";
import { buildSlackCapabilities } from "../connectors/slack/spawn.js";

export interface SpawnFactoryInput {
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
}

export type SpawnFactory = (input: SpawnFactoryInput) => readonly ConnectorCapability[];

const builtIns: Record<string, SpawnFactory> = {
  slack: buildSlackCapabilities,
};

export function getBuiltInSpawnFactory(connectorId: string): SpawnFactory | undefined {
  return builtIns[connectorId];
}

/**
 * Dynamically load a user connector's spawn-side factory. Mirrors the daemon's
 * loader convention: `<connectorsDir>/<id>/<entry>` with a default-exported
 * factory whose returned object exposes `capabilities()`.
 *
 * Cache-busts on `version` (matching connector.toml) so a `verona reload` in
 * the daemon picks up updated connector code on the next spawn.
 */
export async function loadUserSpawnFactory(args: {
  connectorsDir: string;
  connectorId: string;
  entry: string;
  version: string;
}): Promise<SpawnFactory | undefined> {
  const abs = path.resolve(args.connectorsDir, args.connectorId, args.entry);
  const url = `${pathToFileURL(abs).href}?v=${encodeURIComponent(args.version)}`;
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (err) {
    process.stderr.write(
      `[verona-mcp] failed to load user connector "${args.connectorId}" from ${abs}: ${String(err)}\n`,
    );
    return undefined;
  }
  const m = mod as {
    default?: unknown;
    connector?: unknown;
  };
  const factory = (m.default ?? m.connector) as
    | ((init: {
        secrets: Readonly<Record<string, string>>;
        agentSubscriptions: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
      }) =>
        | { capabilities?: () => readonly ConnectorCapability[] }
        | Promise<{ capabilities?: () => readonly ConnectorCapability[] }>)
    | undefined;
  if (typeof factory !== "function") return undefined;

  return (input: SpawnFactoryInput): readonly ConnectorCapability[] => {
    // We synchronously kick off the factory; if it returns a Promise, we
    // can't await here because SpawnFactory is sync. The MCP server boot
    // pre-resolves async factories in `loadCapabilitiesForSubscriptions`
    // below so this fallback should not run for async factories.
    const subs = new Map<string, Readonly<Record<string, unknown>>>([["__spawn__", input.config]]);
    const result = factory({ secrets: input.secrets, agentSubscriptions: subs });
    if (result instanceof Promise) {
      process.stderr.write(
        "[verona-mcp] user connector factory returned Promise in sync path; capabilities will be empty\n",
      );
      return [];
    }
    return result.capabilities?.() ?? [];
  };
}
