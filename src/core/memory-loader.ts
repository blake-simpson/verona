/**
 * Builds the system prompt the dispatcher hands to the adapter.
 *
 * Layout (in order):
 *   1. SOUL.md                                      — agent's personality (verbatim)
 *   2. framing block                                — explains memory layout + writable zone
 *   3. memory/INDEX.md                              — routing table for further memory reads
 *   4. memory/learned/facts/preferences.md (opt.)   — user-stated behaviour rules, wrapped as
 *                                                     hard constraints; loaded EVERY spawn,
 *                                                     including --resume, and placed last so
 *                                                     it is the highest-adherence section
 *   5. (task prompt is the user message, not part of system prompt)
 *
 * core/** and the rest of learned/** are NOT loaded eagerly; the agent reads
 * via the Read tool. preferences.md is the one deliberate carve-out: it is the
 * user's explicit behavioural contract, so it is re-asserted on every turn —
 * the system prompt is re-appended each spawn anyway, and relying on replayed
 * conversation history fails under claude-cli context compaction. See
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
    "    learned/facts/preferences.md is special: when present its content is appended to",
    "    EVERY system prompt (fresh and resumed) as a hard-constraints block at the very end.",
    "    Write user-stated behaviour rules there and keep that one file authoritative.",
    "",
    "Rules:",
    " 1. Read memory/INDEX.md first; only open other memory files when INDEX directs you.",
    " 2. You may write only to memory/INDEX.md and memory/learned/**.",
    "    Writes elsewhere (SOUL.md, agent.toml, tasks/, memory/core/) will be rejected by the host.",
    " 3. Append a per-run log to memory/learned/episodic/ describing what you did.",
    " 4. When the user states a behavioural rule that should apply going forward (style, tone,",
    "    what to avoid, what to use), write or refine memory/learned/facts/preferences.md — that",
    "    one file is the single source of truth; fold any older overlapping facts/*.md into it",
    "    rather than leaving duplicates. Keep it under 60 lines; rewrite to consolidate, don't",
    "    append. Only persist rules the user has explicitly stated, not ones you've inferred.",
    "    These rules are binding output constraints — SOUL governs voice, it does not license",
    "    overriding an explicit user rule.",
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
    readIfPresent(preferencesPath),
  ]);

  const framing = FRAMING(input.agentName, input.taskId, input.agentDir, input.skills ?? []);

  // preferences.md goes LAST, wrapped as hard constraints. Last position =
  // highest adherence in a long prompt, and it is re-asserted every turn
  // (including --resume) so it survives context compaction.
  const segments = [soul, framing, index];
  if (preferences) segments.push(wrapPreferences(preferences));
  const systemPrompt = segments.join("\n\n");

  return {
    systemPrompt,
    parts: { soul, framing, preferences, index },
  };
}

/**
 * Wrap preferences.md so the model treats it as a non-negotiable output
 * contract and self-verifies — not a soft suggestion it can paraphrase or
 * claim it followed without checking.
 */
function wrapPreferences(preferences: string): string {
  return [
    "═══════════════════════════════════════════════════════════════════════",
    "USER PREFERENCES — HARD OUTPUT CONSTRAINTS",
    "These are rules the user stated explicitly. They are binding on every",
    "response and every artifact you produce, and outrank your own defaults.",
    "",
    preferences,
    "",
    "Before you send or post anything, check the actual output against each rule",
    "above — literally, character by character for character rules like em-dashes.",
    "Do not state that you applied a rule unless you verified the output complies.",
    "If you cannot comply, say so plainly; never claim compliance you did not check.",
    "═══════════════════════════════════════════════════════════════════════",
  ].join("\n");
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
