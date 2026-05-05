/**
 * Resolves the on-disk path of verona-mcp-server.js — the per-spawn stdio
 * MCP server entry. Claude is launched with `--mcp-config` pointing at a
 * JSON that names this file as `command: "node"` + `args: [<this>]`.
 *
 * The file is always the BUILT JS, never the .ts source — claude uses raw
 * `node` to spawn it, which can't run TypeScript directly.
 *
 * In dev (tsx running src/mcp/locate.ts):  fall back to <repo>/dist/mcp/verona-mcp-server.js
 *                                          (developer must `npm run build` once).
 * After build (dist/mcp/locate.js):        the JS sits next door.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function veronaMcpServerScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, "verona-mcp-server.js");
  if (existsSync(local)) return local;
  // tsx dev: src/mcp/locate.ts → repo root → dist/mcp/verona-mcp-server.js
  return path.resolve(here, "..", "..", "dist", "mcp", "verona-mcp-server.js");
}
