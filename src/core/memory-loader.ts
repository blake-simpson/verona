/**
 * Builds the system prompt the dispatcher hands to the adapter.
 *
 * Layout (in order):
 *   1. SOUL.md                                      — agent's personality (verbatim)
 *   2. framing block                                — explains memory layout + writable zone
 *   3. memory/learned/facts/preferences.md (opt.)   — user-stated behaviour rules; eagerly loaded
 *                                                     only on fresh sessions (skipped on --resume)
 *   4. memory/INDEX.md                              — routing table for further memory reads
 *   5. (task prompt is the user message, not part of system prompt)
 *
 * core/** and the rest of learned/** are NOT loaded eagerly; the agent reads
 * via the Read tool. preferences.md is the one deliberate carve-out — see
 * knowledge/architecture/memory-protocol.md.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../util/errors.js";

export interface MemoryLoadInput {
  agentDir: string;
  agentName: string;
  taskId: string;
  /** Path relative to agentDir (defaults to ./SOUL.md). */
  soulPath?: string;
  /** Path relative to agentDir (defaults to ./memory/INDEX.md). */
  indexPath?: string;
  /** Path relative to agentDir (defaults to ./memory/learned/facts/preferences.md). */
  preferencesPath?: string;
  /**
   * When true, the spawn is resuming an existing claude-cli session
   * (`--resume`), so preferences.md is skipped — its content already lives in
   * the conversation history the CLI replays, and reloading would burn cache
   * + risk mid-thread whiplash. Fresh `--session-id` spawns set this to false.
   */
  isResume?: boolean;
  /**
   * Names of skills available to the agent this spawn. Surfaced in the
   * framing block so the model knows to reach for the Skill tool when
   * relevant. The dispatcher stages the actual skill files separately.
   */
  skills?: readonly string[];
}

export interface MemoryLoadResult {
  /** Full assembled system prompt. */
  systemPrompt: string;
  /** Sections, exposed for testing / debugging. preferences is null when absent or skipped. */
  parts: {
    soul: string;
    framing: string;
    preferences: string | null;
    index: string;
  };
}

const SOUL_DEFAULT = "./SOUL.md";
const INDEX_DEFAULT = "./memory/INDEX.md";
const PREFERENCES_DEFAULT = "./memory/learned/facts/preferences.md";

const FRAMING = (
  agentName: string,
  taskId: string,
  agentDir: string,
  skills: readonly string[],
) => {
  const lines = [
    `You are agent "${agentName}", running task "${taskId}".`,
    "",
    `Your memory lives at: ${agentDir}/memory/`,
    "  - INDEX.md      — routing table; consult this before reading other memory files.",
    "  - core/         — human-curated, READ-ONLY to you.",
    "  - learned/      — your own knowledge: facts/, episodic/, working/.",
    "    learned/facts/preferences.md is special — when present it is eagerly loaded into",
    "    every fresh-session system prompt (not lazy). Write user-stated behaviour rules here.",
    "",
    "Rules:",
    " 1. Read memory/INDEX.md first; only open other memory files when INDEX directs you.",
    " 2. You may write only to memory/INDEX.md and memory/learned/**.",
    "    Writes elsewhere (SOUL.md, agent.toml, tasks/, memory/core/) will be rejected by the host.",
    " 3. Append a per-run log to memory/learned/episodic/ describing what you did.",
    " 4. When the user states a behavioural rule that should apply going forward (style, tone,",
    "    what to avoid, what to use), write or refine memory/learned/facts/preferences.md.",
    "    Keep it under 60 lines — rewrite to consolidate, don't append. Only persist rules the",
    "    user has explicitly stated, not ones you've inferred. SOUL takes precedence in any conflict.",
    " 5. Keep INDEX.md under 200 lines; keep individual learned/facts/*.md under 100 lines.",
  ];
  if (skills.length > 0) {
    lines.push(
      "",
      `Available skills (call via the Skill tool when relevant): ${skills.join(", ")}.`,
    );
  }
  lines.push(
    "",
    "Below this line is your current memory snapshot.",
    "═══════════════════════════════════════════════════════════════════════",
  );
  return lines.join("\n");
};

export async function loadMemory(input: MemoryLoadInput): Promise<MemoryLoadResult> {
  const soulPath = path.resolve(input.agentDir, input.soulPath ?? SOUL_DEFAULT);
  const indexPath = path.resolve(input.agentDir, input.indexPath ?? INDEX_DEFAULT);
  const preferencesPath = path.resolve(
    input.agentDir,
    input.preferencesPath ?? PREFERENCES_DEFAULT,
  );

  const [soul, index, preferences] = await Promise.all([
    readRequired(soulPath, `SOUL.md is required at ${soulPath}`),
    readRequired(indexPath, `memory/INDEX.md is required at ${indexPath}`),
    input.isResume ? Promise.resolve(null) : readIfPresent(preferencesPath),
  ]);

  const framing = FRAMING(input.agentName, input.taskId, input.agentDir, input.skills ?? []);

  const segments = preferences
    ? [soul, framing, preferences, index]
    : [soul, framing, index];
  const systemPrompt = segments.join("\n\n");

  return {
    systemPrompt,
    parts: { soul, framing, preferences, index },
  };
}

async function readRequired(filePath: string, missingMessage: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf8")).trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(missingMessage, { cause: err });
    }
    throw err;
  }
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    const text = (await readFile(filePath, "utf8")).trimEnd();
    return text.length > 0 ? text : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
