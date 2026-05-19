import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderConnectorPolicy, renderHookSettings } from "../../src/hooks/render-hook-settings.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-hook-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("renderHookSettings", () => {
  it("writes a JSON file with PreToolUse hooks for memory + bash + connector guards", async () => {
    const outputPath = path.join(dir, "settings.json");
    await renderHookSettings({
      guardScriptPath: "/opt/verona/runtime/src/hooks/memory-guard.sh",
      connectorGuardScriptPath: "/opt/verona/runtime/src/hooks/connector-guard.sh",
      bashGuardScriptPath: "/opt/verona/runtime/src/hooks/bash-guard.sh",
      outputPath,
    });
    const json = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(json.hooks).toBeDefined();
    const hooks = json.hooks as { PreToolUse: unknown[] };
    expect(hooks.PreToolUse).toHaveLength(3);

    const memEntry = hooks.PreToolUse[0] as { matcher: string; hooks: unknown[] };
    expect(memEntry.matcher).toBe("Write|Edit");
    const memInner = memEntry.hooks[0] as { type: string; command: string };
    expect(memInner.type).toBe("command");
    expect(memInner.command).toBe("/opt/verona/runtime/src/hooks/memory-guard.sh");

    const bashEntry = hooks.PreToolUse[1] as { matcher: string; hooks: unknown[] };
    expect(bashEntry.matcher).toBe("Bash");
    const bashInner = bashEntry.hooks[0] as { type: string; command: string };
    expect(bashInner.type).toBe("command");
    expect(bashInner.command).toBe("/opt/verona/runtime/src/hooks/bash-guard.sh");

    const connEntry = hooks.PreToolUse[2] as { matcher: string; hooks: unknown[] };
    expect(connEntry.matcher).toBe("mcp__verona__.*");
    const connInner = connEntry.hooks[0] as { type: string; command: string };
    expect(connInner.type).toBe("command");
    expect(connInner.command).toBe("/opt/verona/runtime/src/hooks/connector-guard.sh");
  });
});

describe("renderConnectorPolicy", () => {
  it("writes a JSON policy keyed by connector id", async () => {
    const outputPath = path.join(dir, "connector-policy.json");
    await renderConnectorPolicy({
      outputPath,
      policy: {
        slack: { channels: ["C123", "U456"] },
        quickbooks: {},
      },
    });
    const json = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(json).toEqual({
      slack: { channels: ["C123", "U456"] },
      quickbooks: {},
    });
  });
});
