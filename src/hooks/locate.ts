/**
 * Resolves the on-disk path of memory-guard.sh.
 *
 * In dev (tsx running src/...): src/hooks/locate.ts and src/hooks/memory-guard.sh sit side-by-side.
 * After `tsc` build: dist/hooks/locate.js and dist/hooks/memory-guard.sh sit side-by-side
 * (the build script copies the .sh; tsc itself ignores it).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export function memoryGuardScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "memory-guard.sh");
}

export function connectorGuardScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "connector-guard.sh");
}

export function bashGuardScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "bash-guard.sh");
}
