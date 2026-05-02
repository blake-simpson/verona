/**
 * Asserts that `verona build` produces a runtime artifact with no dev-time
 * leakage. This test is the contract enforcement for two-tree-deploy.md.
 */

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../scripts/build.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let outDir: string;

beforeAll(async () => {
  // Compile once before the suite so tests are fast.
  await import("node:child_process").then((m) => {
    const r = m.spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`tsc failed (${r.status})`);
  });
}, 120_000);

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "verona-build-out-"));
  await rm(outDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const FORBIDDEN_PATHS = [
  "knowledge",
  "AGENTS.md",
  "CLAUDE.md",
  "src",
  "tests",
  "scripts",
  "agents",
  ".env",
  ".env.example",
  "state",
  "node_modules",
  "tsconfig.json",
  "biome.json",
  "vitest.config.ts",
  "CONTRIBUTING.md",
  ".tool-versions",
];

const REQUIRED_FILES = [
  "bin/verona",
  "dist/cli/index.js",
  "dist/hooks/memory-guard.sh",
  "deploy/launchd/com.verona.daemon.plist.template",
  "deploy/systemd/verona-daemon.service.template",
  "deploy/README.md",
  "LICENSE",
  "README.md",
  "package.json",
];

describe("verona build", () => {
  it("produces an artifact with all required files", async () => {
    const result = await buildRuntime({ outDir, skipCompile: true });
    for (const rel of REQUIRED_FILES) {
      const full = path.join(result.outDir, rel);
      const st = await stat(full);
      expect(st.isFile()).toBe(true);
    }
  }, 60_000);

  it("EXCLUDES every forbidden path", async () => {
    const { outDir: built } = await buildRuntime({ outDir, skipCompile: true });
    for (const rel of FORBIDDEN_PATHS) {
      const full = path.join(built, rel);
      let exists = false;
      try {
        await stat(full);
        exists = true;
      } catch {
        // ENOENT is the desired outcome
      }
      expect(exists, `expected ${rel} NOT to be in the runtime artifact`).toBe(false);
    }
  }, 60_000);

  it("memory-guard.sh in the artifact is executable", async () => {
    const { outDir: built } = await buildRuntime({ outDir, skipCompile: true });
    const st = await stat(path.join(built, "dist", "hooks", "memory-guard.sh"));
    expect(st.mode & 0o100).not.toBe(0);
  }, 60_000);

  it("package.json in the artifact has no devDependencies and no scripts", async () => {
    const { outDir: built } = await buildRuntime({ outDir, skipCompile: true });
    const pkg = JSON.parse(await readFile(path.join(built, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts).toBeUndefined();
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.bin).toBeDefined();
  }, 60_000);

  it("dist/ contains compiled JS for entry points", async () => {
    const { outDir: built } = await buildRuntime({ outDir, skipCompile: true });
    const top = await readdir(path.join(built, "dist"));
    expect(top).toContain("cli");
    expect(top).toContain("core");
    expect(top).toContain("adapters");
    expect(top).toContain("connectors");
  }, 60_000);
});
