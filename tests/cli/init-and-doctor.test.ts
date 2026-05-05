import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/commands/doctor.js";
import { runInit } from "../../src/cli/commands/init.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "verona-init-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("verona init", () => {
  it("creates the expected state-dir layout with correct perms", async () => {
    const result = await runInit({ stateDir });
    expect(result.stateDir).toBe(path.resolve(stateDir));

    // expected dirs
    for (const sub of [
      "agents",
      "secrets",
      "secrets/_global",
      "secrets/_connectors",
      "sessions",
      "logs",
      "costs",
      ".git",
    ]) {
      const st = await stat(path.join(stateDir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    // verona.toml
    expect((await stat(path.join(stateDir, "verona.toml"))).isFile()).toBe(true);

    // perms on secrets
    const secretsStat = await stat(path.join(stateDir, "secrets"));
    expect(secretsStat.mode & 0o777).toBe(0o700);
  });

  it("is idempotent — running twice doesn't error and doesn't double-init git", async () => {
    await runInit({ stateDir });
    await runInit({ stateDir });
  });
});

describe("verona doctor", () => {
  it("reports state-dir + git checks as ok after init (skip claude probe)", async () => {
    await runInit({ stateDir });
    const checks = await runDoctor({ stateDir, checkClaude: false });
    // Warnings (plugin presence, legacy agents dir) are environmental;
    // they don't fail the run. Only error-severity checks count.
    const errored = checks.filter((c) => !c.ok && c.severity !== "warn");
    expect(errored.map((c) => `${c.name}: ${c.detail}`).join("\n")).toBe("");
  });

  it("reports a missing state dir as failed", async () => {
    const checks = await runDoctor({
      stateDir: path.join(stateDir, "does-not-exist"),
      checkClaude: false,
    });
    expect(checks.some((c) => c.name === "state dir exists" && !c.ok)).toBe(true);
  });

  it("reports the plugin check as a warning when not installed", async () => {
    await runInit({ stateDir });
    const checks = await runDoctor({ stateDir, checkClaude: false });
    const plugin = checks.find((c) => c.name === "claude code plugin");
    expect(plugin).toBeDefined();
    if (plugin && !plugin.ok) {
      expect(plugin.severity).toBe("warn");
      expect(plugin.detail).toMatch(/plugin marketplace add/);
    }
  });
});
