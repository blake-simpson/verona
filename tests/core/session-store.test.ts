import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/session-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-sessions-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("getSession returns null for unknown thread keys", async () => {
    const store = new SessionStore({ sessionsDir: dir });
    expect(await store.getSession("researcher", "thread-abc")).toBeNull();
  });

  it("setSession + getSession round-trips", async () => {
    const store = new SessionStore({ sessionsDir: dir });
    await store.setSession("researcher", "thread-abc", "ses-1");
    expect(await store.getSession("researcher", "thread-abc")).toBe("ses-1");
  });

  it("forgetSession clears one thread without affecting others", async () => {
    const store = new SessionStore({ sessionsDir: dir });
    await store.setSession("researcher", "t1", "s1");
    await store.setSession("researcher", "t2", "s2");
    await store.forgetSession("researcher", "t1");
    expect(await store.getSession("researcher", "t1")).toBeNull();
    expect(await store.getSession("researcher", "t2")).toBe("s2");
  });

  it("scopes per agent (different agents don't share threads)", async () => {
    const store = new SessionStore({ sessionsDir: dir });
    await store.setSession("agent-a", "shared-thread", "ses-a");
    await store.setSession("agent-b", "shared-thread", "ses-b");
    expect(await store.getSession("agent-a", "shared-thread")).toBe("ses-a");
    expect(await store.getSession("agent-b", "shared-thread")).toBe("ses-b");
  });
});
