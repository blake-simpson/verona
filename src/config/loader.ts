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
  rejectRemovedTaskFields(parsed, sourcePath);
  const result = AgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `agent.toml validation failed at ${sourcePath}: ${formatZod(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Reject removed agent.toml fields with a clear migration message. We do this
 * before Zod parses, otherwise unknown keys silently strip and the user gets
 * surprised that their `post_response = true` had no effect.
 */
function rejectRemovedTaskFields(parsed: unknown, sourcePath: string): void {
  if (!parsed || typeof parsed !== "object") return;
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return;
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    if ("post_response" in t) {
      const id = (t as { id?: unknown }).id;
      const idLabel = typeof id === "string" ? `"${id}"` : "<unknown id>";
      throw new ConfigError(
        `${sourcePath}: task ${idLabel} declares the removed field "post_response". The daemon no longer auto-posts task output; the agent now decides via the slack__send_message tool. Replace post_response with explicit posting in the task prompt and remove the field. See knowledge/architecture/connector-contract.md.`,
      );
    }
  }
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
