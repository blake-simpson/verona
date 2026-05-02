import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHookSettings } from "../../src/hooks/render-hook-settings.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-hook-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("renderHookSettings", () => {
  it("writes a JSON file with PreToolUse hook for Write|Edit", async () => {
    const outputPath = path.join(dir, "settings.json");
    await renderHookSettings({
      guardScriptPath: "/opt/verona/runtime/src/hooks/memory-guard.sh",
      outputPath,
    });
    const json = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(json.hooks).toBeDefined();
    const hooks = json.hooks as { PreToolUse: unknown[] };
    expect(hooks.PreToolUse).toHaveLength(1);
    const entry = hooks.PreToolUse[0] as { matcher: string; hooks: unknown[] };
    expect(entry.matcher).toBe("Write|Edit");
    const inner = entry.hooks[0] as { type: string; command: string };
    expect(inner.type).toBe("command");
    expect(inner.command).toBe("/opt/verona/runtime/src/hooks/memory-guard.sh");
  });
});
