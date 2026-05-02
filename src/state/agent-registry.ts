/**
 * Agent registry — mirrors source agent dirs into <state>/agents/<name>/ at
 * initial registration. On re-add, never clobbers an existing memory/learned/
 * tree (that's the agent's persistent state).
 */

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAgentConfig } from "../config/loader.js";
import { ConfigError, StateError } from "../util/errors.js";
import { agentDir as stateAgentDir } from "./paths.js";

const PROTECTED_TOPLEVEL = ["agent.toml", "SOUL.md"];
const PROTECTED_DIRS = ["tasks", "memory/core"];

export interface RegisterAgentInput {
  /** Path to the source agent dir (e.g. agents/examples/researcher). */
  sourceDir: string;
  /** Path to the state dir root (NOT the agent subpath). */
  stateDir: string;
}

export interface RegisterAgentResult {
  agentName: string;
  destination: string;
  /** True if this was a fresh add (no prior dir); false if updating in place. */
  fresh: boolean;
}

export async function registerAgent(input: RegisterAgentInput): Promise<RegisterAgentResult> {
  const sourceTomlPath = path.join(input.sourceDir, "agent.toml");
  const cfg = await loadAgentConfig(sourceTomlPath);
  const agentName = cfg.agent.name;

  // Source dir name should match agent.name (warn if not, but proceed).
  const dirName = path.basename(path.resolve(input.sourceDir));
  if (dirName !== agentName) {
    process.stderr.write(
      `warning: source dir name "${dirName}" does not match agent.name "${agentName}" in agent.toml\n`,
    );
  }

  const destination = stateAgentDir(input.stateDir, agentName);
  const fresh = !(await dirExists(destination));

  if (fresh) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(input.sourceDir, destination, { recursive: true });
  } else {
    // Update protected files, preserve memory/INDEX.md and memory/learned/.
    for (const rel of PROTECTED_TOPLEVEL) {
      const src = path.join(input.sourceDir, rel);
      const dst = path.join(destination, rel);
      if (await fileExists(src)) {
        await cp(src, dst, { force: true });
      }
    }
    for (const rel of PROTECTED_DIRS) {
      const src = path.join(input.sourceDir, rel);
      const dst = path.join(destination, rel);
      if (await dirExists(src)) {
        await cp(src, dst, { recursive: true, force: true });
      }
    }
  }

  await ensureMemoryScaffold(destination);
  return { agentName, destination, fresh };
}

async function ensureMemoryScaffold(agentRoot: string): Promise<void> {
  const memDir = path.join(agentRoot, "memory");
  const learned = ["facts", "episodic", "working"];
  await mkdir(path.join(memDir, "core"), { recursive: true });
  for (const sub of learned) {
    await mkdir(path.join(memDir, "learned", sub), { recursive: true });
  }
  const index = path.join(memDir, "INDEX.md");
  if (!(await fileExists(index))) {
    const initial = [
      "# Memory index",
      "",
      "_Routing table for this agent's memory. Read this first; only open further files when this index points you to them._",
      "",
      "## Core (read-only)",
      "",
      "_Human-curated. Add entries here by editing the source agent dir, then `verona agents update`._",
      "",
      "## Learned",
      "",
      "_You curate this section as you learn. Keep entries terse (≤100 lines per file)._",
      "",
    ].join("\n");
    await writeFile(index, initial, "utf8");
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function listRegisteredAgents(stateDir: string): Promise<string[]> {
  const agentsRoot = path.join(stateDir, "agents");
  try {
    const entries = await import("node:fs/promises").then((m) => m.readdir(agentsRoot, { withFileTypes: true }));
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readRegisteredAgentToml(
  stateDir: string,
  agentName: string,
): Promise<string> {
  const file = path.join(stateAgentDir(stateDir, agentName), "agent.toml");
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateError(`agent "${agentName}" is not registered (no ${file})`, { cause: err });
    }
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new ConfigError(`agent "${agentName}" path is not a directory`, { cause: err });
    }
    throw err;
  }
}
