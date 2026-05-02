/**
 * TOML config loader for agent.toml and verona.toml.
 *
 * Parses with smol-toml, validates with the Zod schemas in ./schema.ts, and
 * throws ConfigError with a path-pointing message on failure.
 */

import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { ConfigError } from "../util/errors.js";
import {
  type AgentConfig,
  AgentConfigSchema,
  type VeronaConfig,
  VeronaConfigSchema,
} from "./schema.js";

export async function loadAgentConfig(filePath: string): Promise<AgentConfig> {
  const raw = await readFileOrThrow(filePath, "agent.toml");
  return parseAgent(raw, filePath);
}

export function parseAgent(raw: string, sourcePath = "<inline>"): AgentConfig {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new ConfigError(`failed to parse TOML at ${sourcePath}`, { cause: err });
  }
  const result = AgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `agent.toml validation failed at ${sourcePath}: ${formatZod(result.error)}`,
    );
  }
  return result.data;
}

export async function loadVeronaConfig(filePath: string): Promise<VeronaConfig> {
  const raw = await readFileOrThrow(filePath, "verona.toml");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new ConfigError(`failed to parse TOML at ${filePath}`, { cause: err });
  }
  const result = VeronaConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `verona.toml validation failed at ${filePath}: ${formatZod(result.error)}`,
    );
  }
  return result.data;
}

async function readFileOrThrow(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`${label} not found at ${filePath}`, { cause: err });
    }
    throw err;
  }
}

function formatZod(err: import("zod").ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
