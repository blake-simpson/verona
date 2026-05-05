import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/init.js";
import { Daemon } from "../../src/core/daemon.js";

let workspace: string;
let stateDir: string;
let connectorsDir: string;

async function writeConnector(opts: {
  id: string;
  version: string;
  factoryJs: string;
}): Promise<void> {
  const cdir = path.join(connectorsDir, opts.id);
  await mkdir(path.join(cdir, "dist"), { recursive: true });
  await writeFile(
    path.join(cdir, "connector.toml"),
    `id = "${opts.id}"\ndirection = "outbound"\nversion = "${opts.version}"\n`,
    "utf8",
  );
  await writeFile(path.join(cdir, "dist", "index.js"), opts.factoryJs, "utf8");
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "verona-reload-conn-"));
  stateDir = path.join(workspace, "state");
  connectorsDir = path.join(workspace, "user", "connectors");
  await runInit({ stateDir });
  process.env.VERONA_CONNECTORS_DIR = connectorsDir;
});

afterEach(async () => {
  delete process.env.VERONA_CONNECTORS_DIR;
  await rm(workspace, { recursive: true, force: true });
});

describe("Daemon.reload() — user connector diff", () => {
  it("starts a newly-added user connector", async () => {
    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    expect(daemon.connectorIds()).not.toContain("after-add");

    await writeConnector({
      id: "after-add",
      version: "0.1.0",
      factoryJs: `
let started = 0;
export default () => ({
  id: "after-add",
  direction: "outbound",
  async start() { started++; },
  async stop() {},
  async send() {},
  __started: () => started,
});
`,
    });

    await daemon.reload();
    expect(daemon.connectorIds()).toContain("after-add");
    await daemon.stop();
  });

  it("restarts a user connector when its manifest version changes", async () => {
    await writeConnector({
      id: "versioned",
      version: "0.1.0",
      factoryJs: `
export default () => {
  const inst = {
    id: "versioned",
    direction: "outbound",
    __version: "0.1.0",
    stops: 0,
    async start() {},
    async stop() { this.stops++; },
  };
  return inst;
};
`,
    });
    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    const v1 = daemon.getConnector("versioned") as { __version: string } | undefined;
    expect(v1?.__version).toBe("0.1.0");

    await writeConnector({
      id: "versioned",
      version: "0.2.0",
      factoryJs: `
export default () => ({
  id: "versioned",
  direction: "outbound",
  __version: "0.2.0",
  async start() {},
  async stop() {},
});
`,
    });
    await daemon.reload();
    const v2 = daemon.getConnector("versioned") as { __version: string } | undefined;
    expect(v2?.__version).toBe("0.2.0");
    await daemon.stop();
  });

  it("stops a user connector when its directory is removed", async () => {
    await writeConnector({
      id: "ephemeral",
      version: "0.1.0",
      factoryJs: `
let stopped = 0;
const inst = {
  id: "ephemeral",
  direction: "outbound",
  async start() {},
  async stop() { stopped++; },
};
export default () => inst;
`,
    });
    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    expect(daemon.connectorIds()).toContain("ephemeral");

    await rm(path.join(connectorsDir, "ephemeral"), { recursive: true, force: true });
    await daemon.reload();
    expect(daemon.connectorIds()).not.toContain("ephemeral");
    await daemon.stop();
  });

  it("leaves an unchanged connector running across reloads", async () => {
    await writeConnector({
      id: "stable",
      version: "0.1.0",
      factoryJs: `
let factoryCalls = 0;
export default () => {
  factoryCalls++;
  return {
    id: "stable",
    direction: "outbound",
    __factoryCalls: factoryCalls,
    async start() {},
    async stop() {},
  };
};
`,
    });
    const daemon = new Daemon({ stateDir });
    await daemon.bootstrap();
    const before = daemon.getConnector("stable") as { __factoryCalls: number } | undefined;
    await daemon.reload();
    const after = daemon.getConnector("stable") as { __factoryCalls: number } | undefined;
    // Same instance — factory count unchanged
    expect(after?.__factoryCalls).toBe(before?.__factoryCalls);
    await daemon.stop();
  });
});
