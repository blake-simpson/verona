/**
 * Filesystem secret store. Plaintext files under <state>/secrets/, but
 * permissions are enforced (0700 on dirs, 0600 on files) and the daemon
 * refuses to read if perms are wrong.
 *
 * Layout:
 *   secrets/
 *     _global/<key>            (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY)
 *     _connectors/<id>/<key>   (e.g. slack/bot_token)
 *     <agent>/<key>            (e.g. researcher/github_pat)
 *
 * See knowledge/conventions/secrets-handling.md for the rules.
 */

import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SecretError } from "../util/errors.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type SecretScope =
  | { kind: "global" }
  | { kind: "connector"; id: string }
  | { kind: "agent"; name: string };

function scopeDir(secretsRoot: string, scope: SecretScope): string {
  switch (scope.kind) {
    case "global":
      return path.join(secretsRoot, "_global");
    case "connector":
      validateName("connector", scope.id);
      return path.join(secretsRoot, "_connectors", scope.id);
    case "agent":
      validateName("agent", scope.name);
      return path.join(secretsRoot, scope.name);
  }
}

function validateName(kind: string, name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new SecretError(`invalid ${kind} scope name: "${name}" (must be kebab/snake_case)`);
  }
}

function validateKey(key: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    throw new SecretError(`invalid secret key: "${key}" (must be alphanumeric/_-)`);
  }
}

export async function ensureSecretsRootPerms(secretsRoot: string): Promise<void> {
  await mkdir(secretsRoot, { recursive: true, mode: DIR_MODE });
  // recursive: true ignores mode on existing dirs; ensure perms explicitly.
  await chmod(secretsRoot, DIR_MODE);
  const st = await stat(secretsRoot);
  if ((st.mode & 0o077) !== 0) {
    throw new SecretError(
      `secrets dir at ${secretsRoot} has unsafe permissions (${(st.mode & 0o777).toString(8)}); expected 700`,
    );
  }
}

export async function setSecret(
  secretsRoot: string,
  scope: SecretScope,
  key: string,
  value: string,
): Promise<void> {
  validateKey(key);
  await ensureSecretsRootPerms(secretsRoot);
  const dir = scopeDir(secretsRoot, scope);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
  const file = path.join(dir, key);
  await writeFile(file, value, { encoding: "utf8", mode: FILE_MODE });
  await chmod(file, FILE_MODE);
}

export async function getSecret(
  secretsRoot: string,
  scope: SecretScope,
  key: string,
): Promise<string | null> {
  validateKey(key);
  const file = path.join(scopeDir(secretsRoot, scope), key);
  let st;
  try {
    st = await stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if ((st.mode & 0o077) !== 0) {
    throw new SecretError(
      `secret file at ${file} has unsafe permissions (${(st.mode & 0o777).toString(8)}); expected 600`,
    );
  }
  return await readFile(file, "utf8");
}

export async function listSecrets(
  secretsRoot: string,
  scope: SecretScope,
): Promise<readonly string[]> {
  const dir = scopeDir(secretsRoot, scope);
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => !e.startsWith("."));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface PermsCheckResult {
  ok: boolean;
  /** Issues found, in human-readable form. Empty if ok. */
  issues: string[];
}

/**
 * Walk the secrets dir and report any file/dir with unsafe perms. Used by
 * `verona doctor`.
 */
export async function checkSecretsPerms(secretsRoot: string): Promise<PermsCheckResult> {
  const issues: string[] = [];
  try {
    const rootStat = await stat(secretsRoot);
    if ((rootStat.mode & 0o077) !== 0) {
      issues.push(
        `secrets root ${secretsRoot}: ${(rootStat.mode & 0o777).toString(8)} (expected 700)`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, issues: [] };
    }
    throw err;
  }
  await walkAndCheck(secretsRoot, issues);
  return { ok: issues.length === 0, issues };
}

async function walkAndCheck(dir: string, issues: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    const st = await stat(p);
    if (entry.isDirectory()) {
      if ((st.mode & 0o077) !== 0) {
        issues.push(`dir ${p}: ${(st.mode & 0o777).toString(8)} (expected 700)`);
      }
      await walkAndCheck(p, issues);
    } else if (entry.isFile()) {
      if ((st.mode & 0o077) !== 0) {
        issues.push(`file ${p}: ${(st.mode & 0o777).toString(8)} (expected 600)`);
      }
    }
  }
}
