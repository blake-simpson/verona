/**
 * Builds the system prompt the dispatcher hands to the adapter.
 *
 * Layout (in order):
 *   1. SOUL.md                      — agent's personality (verbatim)
 *   2. framing block                — explains memory layout + writable zone
 *   3. memory/INDEX.md              — routing table for further memory reads
 *   4. (task prompt is the user message, not part of system prompt)
 *
 * core/** and learned/** are NOT loaded eagerly; the agent reads via Read tool.
 * See knowledge/architecture/memory-protocol.md for the full protocol.
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
  /** Sections, exposed for testing / debugging. */
  parts: {
    soul: string;
    framing: string;
    index: string;
  };
}

const SOUL_DEFAULT = "./SOUL.md";
const INDEX_DEFAULT = "./memory/INDEX.md";

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
    "",
    "Rules:",
    " 1. Read memory/INDEX.md first; only open other memory files when INDEX directs you.",
    " 2. You may write only to memory/INDEX.md and memory/learned/**.",
    "    Writes elsewhere (SOUL.md, agent.toml, tasks/, memory/core/) will be rejected by the host.",
    " 3. Append a per-run log to memory/learned/episodic/ describing what you did.",
    " 4. Keep INDEX.md under 200 lines; keep individual learned/facts/*.md under 100 lines.",
  ];
  if (skills.length > 0) {
    lines.push(
      "",
      `Available skills (call via the Skill tool when relevant): ${skills.join(", ")}.`,
    );
  }
  lines.push(
    "",
    "Below this line is your INDEX.md for the current memory state.",
    "═══════════════════════════════════════════════════════════════════════",
  );
  return lines.join("\n");
};

export async function loadMemory(input: MemoryLoadInput): Promise<MemoryLoadResult> {
  const soulPath = path.resolve(input.agentDir, input.soulPath ?? SOUL_DEFAULT);
  const indexPath = path.resolve(input.agentDir, input.indexPath ?? INDEX_DEFAULT);

  const [soul, index] = await Promise.all([
    readOptional(soulPath, `SOUL.md is required at ${soulPath}`),
    readOptional(indexPath, `memory/INDEX.md is required at ${indexPath}`),
  ]);

  const framing = FRAMING(input.agentName, input.taskId, input.agentDir, input.skills ?? []);
  const systemPrompt = [soul, framing, index].join("\n\n");

  return {
    systemPrompt,
    parts: { soul, framing, index },
  };
}

async function readOptional(filePath: string, missingMessage: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf8")).trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(missingMessage, { cause: err });
    }
    throw err;
  }
}
