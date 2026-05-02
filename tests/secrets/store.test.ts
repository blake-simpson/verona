import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkSecretsPerms,
  ensureSecretsRootPerms,
  getSecret,
  listSecrets,
  setSecret,
} from "../../src/secrets/store.js";
import { SecretError } from "../../src/util/errors.js";

let secretsRoot: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verona-secrets-"));
  secretsRoot = path.join(dir, "secrets");
});

afterEach(async () => {
  await rm(path.dirname(secretsRoot), { recursive: true, force: true });
});

describe("secrets store", () => {
  it("creates the secrets root with mode 0700", async () => {
    await ensureSecretsRootPerms(secretsRoot);
    const st = await stat(secretsRoot);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("writes secret files with mode 0600", async () => {
    await setSecret(secretsRoot, { kind: "global" }, "ANTHROPIC_API_KEY", "sk-test-value");
    const file = path.join(secretsRoot, "_global", "ANTHROPIC_API_KEY");
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("sk-test-value");
  });

  it("round-trips a global secret via getSecret", async () => {
    await setSecret(secretsRoot, { kind: "global" }, "OPENAI_API_KEY", "sk-openai");
    const v = await getSecret(secretsRoot, { kind: "global" }, "OPENAI_API_KEY");
    expect(v).toBe("sk-openai");
  });

  it("scopes connector and agent secrets independently", async () => {
    await setSecret(secretsRoot, { kind: "connector", id: "slack" }, "bot_token", "xoxb-123");
    await setSecret(secretsRoot, { kind: "agent", name: "researcher" }, "github_pat", "ghp-xyz");

    expect(await getSecret(secretsRoot, { kind: "connector", id: "slack" }, "bot_token")).toBe(
      "xoxb-123",
    );
    expect(await getSecret(secretsRoot, { kind: "agent", name: "researcher" }, "github_pat")).toBe(
      "ghp-xyz",
    );
    // wrong scope returns null
    expect(await getSecret(secretsRoot, { kind: "global" }, "bot_token")).toBeNull();
  });

  it("returns null for missing secrets", async () => {
    await ensureSecretsRootPerms(secretsRoot);
    const v = await getSecret(secretsRoot, { kind: "global" }, "MISSING_KEY");
    expect(v).toBeNull();
  });

  it("REFUSES to read a secret with unsafe perms", async () => {
    await setSecret(secretsRoot, { kind: "global" }, "LEAKED", "danger");
    const file = path.join(secretsRoot, "_global", "LEAKED");
    await chmod(file, 0o644); // world-readable — should be rejected

    await expect(getSecret(secretsRoot, { kind: "global" }, "LEAKED")).rejects.toBeInstanceOf(
      SecretError,
    );
  });

  it("rejects invalid scope names (path traversal etc.)", async () => {
    await expect(
      setSecret(secretsRoot, { kind: "agent", name: "../escape" }, "x", "y"),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it("rejects invalid secret keys", async () => {
    await expect(
      setSecret(secretsRoot, { kind: "global" }, "../etc/passwd", "y"),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it("listSecrets returns keys for a scope", async () => {
    await setSecret(secretsRoot, { kind: "connector", id: "slack" }, "bot_token", "a");
    await setSecret(secretsRoot, { kind: "connector", id: "slack" }, "app_token", "b");
    const keys = await listSecrets(secretsRoot, { kind: "connector", id: "slack" });
    expect(keys.sort()).toEqual(["app_token", "bot_token"]);
  });

  it("checkSecretsPerms passes for a clean tree", async () => {
    await setSecret(secretsRoot, { kind: "global" }, "K", "v");
    const result = await checkSecretsPerms(secretsRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("checkSecretsPerms reports unsafe files", async () => {
    await setSecret(secretsRoot, { kind: "global" }, "K", "v");
    const file = path.join(secretsRoot, "_global", "K");
    await chmod(file, 0o644);
    const result = await checkSecretsPerms(secretsRoot);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("644");
  });
});
