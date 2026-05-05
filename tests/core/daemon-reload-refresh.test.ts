import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentsAdd } from "../../src/cli/commands/agents.js";
import { runInit } from "../../src/cli/commands/init.js";
import { Daemon } from "../../src/core/daemon.js";

const FIXTURE_HELLO = path.resolve(
  fileURLToPath(import.meta.url),
  "../../fixtures/agents/hello-world",
);

let workspace: string;
let stateDir: string;
let userAgentsDir: string;
let userAgentDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "verona-reload-refresh-"));
  stateDir = path.join(workspace, "state");
  userAgentsDir = path.join(workspace, "user", "agents");
  userAgentDir = path.join(userAgentsDir, "hello-world");
  await runInit({ stateDir });
  await cp(FIXTURE_HELLO, userAgentDir, { recursive: true });
  await runAgentsAdd({ sourceDir: userAgentDir, stateDir });
  // Point VERONA_AGENTS_DIR at the test user-agents location so reload's
  // refresh can find the source.
  process.env.VERONA_AGENTS_DIR = userAgentsDir;
});

afterEach(async () => {
  delete process.env.VERONA_AGENTS_DIR;
  await rm(workspace, { recursive: true, force: true });
});

async function readStateAgentToml(): Promise<string> {
  return readFile(path.join(stateDir, "agents", "hello-world", "agent.toml"), "utf8");
}

describe("Daemon.reload() — auto-refresh from user-agents source", () => {
  it("propagates an edit to the user-agents agent.toml on reload", async () => {
    // Edit the SOURCE agent.toml (the one the user authors)
    const sourceToml = path.join(userAgentDir, "agent.toml");
    const original = await readFile(sourceToml, "utf8");
    const edited = `${original}\n# refresh test marker\n`;
    await writeFile(sourceToml, edited, "utf8");

    // Confirm the state-dir copy doesn't have the edit yet
    expect(await readStateAgentToml()).not.toContain("refresh test marker");

    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    await daemon.reload();
    await daemon.stop();

    // After reload, state-dir copy should reflect the source edit
    expect(await readStateAgentToml()).toContain("refresh test marker");
  });

  it("preserves memory/learned/ across the refresh", async () => {
    const learnedFile = path.join(
      stateDir,
      "agents",
      "hello-world",
      "memory",
      "learned",
      "facts",
      "alpha.md",
    );
    await writeFile(learnedFile, "agent-curated content", "utf8");

    // Bump source agent.toml so refresh fires
    const sourceToml = path.join(userAgentDir, "agent.toml");
    const orig = await readFile(sourceToml, "utf8");
    await writeFile(sourceToml, `${orig}\n# bump\n`, "utf8");

    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    await daemon.reload();
    await daemon.stop();

    // Memory should survive
    expect(await readFile(learnedFile, "utf8")).toBe("agent-curated content");
  });

  it("skips agents whose source dir is missing (no error)", async () => {
    // Remove the source dir; the state-dir copy stays
    await rm(userAgentDir, { recursive: true, force: true });

    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    // Should not throw — just leaves the state-dir copy untouched
    await expect(daemon.reload()).resolves.toBeUndefined();
    await daemon.stop();

    // state-dir copy still intact
    const stateToml = await readStateAgentToml();
    expect(stateToml.length).toBeGreaterThan(0);
  });
});
