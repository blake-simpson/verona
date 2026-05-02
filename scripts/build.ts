#!/usr/bin/env node
/**
 * `verona build` — produces the slim runtime artifact from this source tree.
 *
 * Layout of the output (verona-runtime/):
 *   bin/verona                 # executable shim
 *   dist/                      # compiled JS
 *   dist/hooks/memory-guard.sh # hook script (literal copy from src)
 *   deploy/                    # service templates + deploy README
 *   package.json               # pruned: no devDependencies, no scripts
 *   LICENSE
 *   README.md                  # slim install-only version (NOT the dev README)
 *
 * EXCLUDED (and asserted absent in tests/build.test.ts):
 *   knowledge/, AGENTS.md, CLAUDE.md, src/, tests/, scripts/,
 *   agents/examples/, .env*, state/
 *
 * Run:  npx tsx scripts/build.ts [--out <path>]
 */

import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

interface BuildOptions {
  outDir?: string;
  /** When true, skip running tsc (assume dist/ is fresh). Used by tests. */
  skipCompile?: boolean;
}

const RUNTIME_README = `# Verona runtime

This is a built artifact produced by \`verona build\` from the verona source tree.
It is NOT the development tree — there is no source, no docs, no examples.

## Install

1. Copy this directory to your host (e.g. \`/opt/verona/runtime\`).
2. Ensure Node 25+ is on PATH and the \`claude\` CLI is installed and logged in
   (\`claude login\`).
3. \`./bin/verona init\` to scaffold a state dir at \`~/.verona/state\` (override
   with \`VERONA_STATE_DIR\`).
4. \`./bin/verona doctor\` to verify the host.
5. \`./bin/verona agents add <path>\` to register agents.
6. Install as a service via the templates in \`deploy/\`:
   - macOS: \`deploy/launchd/com.verona.daemon.plist.template\`
   - Linux: \`deploy/systemd/verona-daemon.service.template\`

See the source repo for the full README, knowledge base, and contributor docs.
`;

export async function buildRuntime(opts: BuildOptions = {}): Promise<{ outDir: string }> {
  const outDir = path.resolve(opts.outDir ?? path.join(REPO_ROOT, "verona-runtime"));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  if (!opts.skipCompile) {
    const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (tsc.status !== 0) throw new Error(`tsc failed (status ${tsc.status})`);
  }

  // Compiled JS
  await cp(path.join(REPO_ROOT, "dist"), path.join(outDir, "dist"), { recursive: true });

  // Hook script — tsc doesn't compile shell, copy explicitly.
  await mkdir(path.join(outDir, "dist", "hooks"), { recursive: true });
  await copyFile(
    path.join(REPO_ROOT, "src", "hooks", "memory-guard.sh"),
    path.join(outDir, "dist", "hooks", "memory-guard.sh"),
  );
  await chmod(path.join(outDir, "dist", "hooks", "memory-guard.sh"), 0o755);

  // bin/verona
  await mkdir(path.join(outDir, "bin"), { recursive: true });
  await copyFile(path.join(REPO_ROOT, "bin", "verona"), path.join(outDir, "bin", "verona"));
  await chmod(path.join(outDir, "bin", "verona"), 0o755);

  // deploy/ (service templates + deploy README)
  await cp(path.join(REPO_ROOT, "deploy"), path.join(outDir, "deploy"), { recursive: true });

  // LICENSE + slim README
  await copyFile(path.join(REPO_ROOT, "LICENSE"), path.join(outDir, "LICENSE"));
  await writeFile(path.join(outDir, "README.md"), RUNTIME_README, "utf8");

  // Pruned package.json — keep only runtime fields.
  const pkgRaw = await readFile(path.join(REPO_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  const pruned: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: pkg.type,
    engines: pkg.engines,
    bin: pkg.bin,
    dependencies: pkg.dependencies,
  };
  await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(pruned, null, 2)}\n`);

  return { outDir };
}

const isMainModule =
  typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const opts: BuildOptions = outDir ? { outDir } : {};
  buildRuntime(opts)
    .then(({ outDir }) => {
      process.stdout.write(`built ${outDir}\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`build failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
