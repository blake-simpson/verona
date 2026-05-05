/**
 * connector-guard.sh — Layer A gating for `mcp__verona__*` tool calls.
 *
 * The hook reads stdin (PreToolUse payload) plus VERONA_CONNECTOR_POLICY
 * (path to a JSON policy file). Output is either empty (allow) or a
 * `permissionDecision: "deny"` JSON. Exit code is always 0.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorGuardScriptPath } from "../../src/hooks/locate.js";

const execFileAsync = promisify(execFile);

let dir: string;
let policyPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-cguard-"));
  policyPath = path.join(dir, "policy.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
}

async function runHook(input: string, env: Record<string, string>): Promise<RunResult> {
  const script = connectorGuardScriptPath();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "bash",
      [script],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        // Hook always exits 0; bubble any spawn error.
        if (err && err.code !== 0) return reject(err);
        resolve({ stdout, stderr });
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

function decisionFrom(stdout: string): { decision: string; reason?: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    const out = parsed.hookSpecificOutput;
    if (!out?.permissionDecision) return null;
    return {
      decision: out.permissionDecision,
      ...(out.permissionDecisionReason && { reason: out.permissionDecisionReason }),
    };
  } catch {
    return null;
  }
}

describe("connector-guard.sh", () => {
  it("allows non-MCP tool calls (handed off to memory-guard)", async () => {
    await writeFile(policyPath, JSON.stringify({ slack: { channels: ["C1"] } }), "utf8");
    const r = await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/foo" } }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    expect(decisionFrom(r.stdout)).toBeNull();
  });

  it("denies mcp__verona__* tools when no policy file is present", async () => {
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__slack__send_message",
        tool_input: { channel: "C1", text: "hi" },
      }),
      { VERONA_CONNECTOR_POLICY: "/nonexistent/policy.json" },
    );
    const d = decisionFrom(r.stdout);
    expect(d?.decision).toBe("deny");
    expect(d?.reason).toMatch(/no policy file/);
  });

  it("denies a connector the agent didn't subscribe to", async () => {
    await writeFile(policyPath, JSON.stringify({ slack: { channels: [] } }), "utf8");
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__quickbooks__create_transaction",
        tool_input: { amount: 10 },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    const d = decisionFrom(r.stdout);
    expect(d?.decision).toBe("deny");
    expect(d?.reason).toMatch(/not subscribed.*quickbooks/);
  });

  it("allows slack send when channel is in allowlist", async () => {
    await writeFile(policyPath, JSON.stringify({ slack: { channels: ["C1", "C2"] } }), "utf8");
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__slack__send_message",
        tool_input: { channel: "C1", text: "hi" },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    expect(decisionFrom(r.stdout)).toBeNull();
  });

  it("denies slack send to a channel outside allowlist", async () => {
    await writeFile(policyPath, JSON.stringify({ slack: { channels: ["C1"] } }), "utf8");
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__slack__send_message",
        tool_input: { channel: "DROP_THIS", text: "hi" },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    const d = decisionFrom(r.stdout);
    expect(d?.decision).toBe("deny");
    expect(d?.reason).toMatch(/DROP_THIS.*not in.*allowlist/);
  });

  it("allows slack send when no channels filter is set (subscribed but unconstrained)", async () => {
    await writeFile(policyPath, JSON.stringify({ slack: {} }), "utf8");
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__slack__send_message",
        tool_input: { channel: "C-anything", text: "hi" },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    expect(decisionFrom(r.stdout)).toBeNull();
  });

  it("denies a destructive capability when allow_destructive is not set", async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        quickbooks: {
          allow_destructive: false,
          capabilities: {
            delete_transaction: { sideEffect: "destructive" },
          },
        },
      }),
      "utf8",
    );
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__quickbooks__delete_transaction",
        tool_input: { id: "Q1" },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    const d = decisionFrom(r.stdout);
    expect(d?.decision).toBe("deny");
    expect(d?.reason).toMatch(/destructive/);
    expect(d?.reason).toMatch(/allow_destructive/);
  });

  it("allows a destructive capability when allow_destructive is true", async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        quickbooks: {
          allow_destructive: true,
          capabilities: {
            delete_transaction: { sideEffect: "destructive" },
          },
        },
      }),
      "utf8",
    );
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__quickbooks__delete_transaction",
        tool_input: { id: "Q1" },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    expect(decisionFrom(r.stdout)).toBeNull();
  });

  it("allows a write (non-destructive) capability without allow_destructive", async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        slack: {
          allow_destructive: false,
          capabilities: {
            send_message: { sideEffect: "write" },
          },
        },
      }),
      "utf8",
    );
    const r = await runHook(
      JSON.stringify({
        tool_name: "mcp__verona__slack__send_message",
        tool_input: { channel: "C1", text: "hi" },
      }),
      { VERONA_CONNECTOR_POLICY: policyPath },
    );
    expect(decisionFrom(r.stdout)).toBeNull();
  });
});

// Suppress unused import warnings under verbatimModuleSyntax — execFileAsync
// is reserved for future async tests.
void execFileAsync;
