import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentSubscriptions,
  discoverUserConnectors,
  instantiateUserConnector,
} from "../../src/core/connector-loader.js";
import { setSecret } from "../../src/secrets/store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verona-connector-loader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFixtureConnector(opts: {
  root: string;
  id: string;
  manifest: string;
  factoryJs: string;
}): Promise<string> {
  const cdir = path.join(opts.root, opts.id);
  await mkdir(path.join(cdir, "dist"), { recursive: true });
  await writeFile(path.join(cdir, "connector.toml"), opts.manifest, "utf8");
  await writeFile(path.join(cdir, "dist", "index.js"), opts.factoryJs, "utf8");
  return cdir;
}

describe("connector loader", () => {
  it("returns [] when connectors dir does not exist", async () => {
    const records = await discoverUserConnectors(path.join(dir, "missing"));
    expect(records).toEqual([]);
  });

  it("discovers a manifest-correct connector and loads its default export", async () => {
    const connectorsDir = path.join(dir, "connectors");
    await writeFixtureConnector({
      root: connectorsDir,
      id: "echo",
      manifest: `
id = "echo"
direction = "outbound"
version = "0.1.0"
`,
      factoryJs: `
export default function createConnector() {
  return {
    id: "echo",
    direction: "outbound",
    async send() {},
  };
}
`,
    });
    const records = await discoverUserConnectors(connectorsDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.manifest.id).toBe("echo");
    expect(records[0]?.manifest.entry).toBe("dist/index.js");
  });

  it("rejects when manifest id mismatches dir name", async () => {
    const connectorsDir = path.join(dir, "connectors");
    await writeFixtureConnector({
      root: connectorsDir,
      id: "wrong-name",
      manifest: `
id = "right-name"
direction = "outbound"
version = "0.1.0"
`,
      factoryJs: `export default () => ({ id: "right-name", direction: "outbound" });`,
    });
    await expect(discoverUserConnectors(connectorsDir)).rejects.toThrow(/wrong-name|right-name/);
  });

  it("rejects when entry file is missing", async () => {
    const connectorsDir = path.join(dir, "connectors");
    await mkdir(path.join(connectorsDir, "noentry"), { recursive: true });
    await writeFile(
      path.join(connectorsDir, "noentry", "connector.toml"),
      `
id = "noentry"
direction = "outbound"
version = "0.1.0"
`,
      "utf8",
    );
    await expect(discoverUserConnectors(connectorsDir)).rejects.toThrow(/dist\/index\.js/);
  });

  it("instantiate returns null when a required secret is missing", async () => {
    const connectorsDir = path.join(dir, "connectors");
    const secretsRoot = path.join(dir, "secrets");
    await writeFixtureConnector({
      root: connectorsDir,
      id: "needs-secret",
      manifest: `
id = "needs-secret"
direction = "outbound"
version = "0.1.0"
secrets = ["api_key"]
`,
      factoryJs: `export default () => ({ id: "needs-secret", direction: "outbound" });`,
    });
    const records = await discoverUserConnectors(connectorsDir);
    const rec = records[0];
    if (!rec) throw new Error("expected a record");
    const c = await instantiateUserConnector(rec, {
      secretsRoot,
      agentSubscriptions: new Map(),
    });
    expect(c).toBeNull();
  });

  it("instantiate resolves secrets and passes agent subscriptions to the factory", async () => {
    const connectorsDir = path.join(dir, "connectors");
    const secretsRoot = path.join(dir, "secrets");
    await writeFixtureConnector({
      root: connectorsDir,
      id: "with-secret",
      manifest: `
id = "with-secret"
direction = "both"
version = "0.1.0"
secrets = ["api_key"]
`,
      factoryJs: `
export default (init) => ({
  id: "with-secret",
  direction: "both",
  __init: init,
});
`,
    });
    await setSecret(secretsRoot, { kind: "connector", id: "with-secret" }, "api_key", "k1");
    const subs = buildAgentSubscriptions([
      {
        agentName: "agent-a",
        config: { connectors: { "with-secret": { foo: "bar" } } },
      },
    ]);
    const records = await discoverUserConnectors(connectorsDir);
    const rec = records[0];
    if (!rec) throw new Error("expected a record");
    const c = (await instantiateUserConnector(rec, {
      secretsRoot,
      agentSubscriptions: subs,
    })) as {
      __init: { secrets: Record<string, string>; agentSubscriptions: Map<string, unknown> };
    } | null;
    expect(c).not.toBeNull();
    expect(c?.__init.secrets.api_key).toBe("k1");
    expect(c?.__init.agentSubscriptions.get("agent-a")).toEqual({ foo: "bar" });
  });

  it("buildAgentSubscriptions groups configs by connector id", () => {
    const subs = buildAgentSubscriptions([
      {
        agentName: "a1",
        config: { connectors: { slack: { channel: "#x" }, qb: { realm_id: "r1" } } },
      },
      {
        agentName: "a2",
        config: { connectors: { qb: { realm_id: "r2" } } },
      },
    ]);
    expect(subs.get("slack")?.size).toBe(1);
    expect(subs.get("qb")?.size).toBe(2);
    expect(subs.get("qb")?.get("a2")).toEqual({ realm_id: "r2" });
  });
});
