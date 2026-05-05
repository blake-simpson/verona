import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConnectorsAdd, runConnectorsBuild } from "../../src/cli/commands/connectors.js";
import { runInit } from "../../src/cli/commands/init.js";

let workspace: string;
let stateDir: string;
let connectorsDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "verona-conn-cli-"));
  stateDir = path.join(workspace, "state");
  connectorsDir = path.join(workspace, "user", "connectors");
  await runInit({ stateDir });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("verona connectors add (user connector)", () => {
  it("reads the manifest's secrets and writes them to state/secrets/_connectors/<id>/", async () => {
    const cdir = path.join(connectorsDir, "qb");
    await mkdir(path.join(cdir, "dist"), { recursive: true });
    await writeFile(
      path.join(cdir, "connector.toml"),
      `id = "qb"\ndirection = "outbound"\nversion = "0.1.0"\nsecrets = ["client_id", "refresh_token"]\n`,
      "utf8",
    );
    await writeFile(
      path.join(cdir, "dist", "index.js"),
      `export default () => ({ id: "qb", direction: "outbound" });\n`,
      "utf8",
    );

    const written = await runConnectorsAdd({
      connectorId: "qb",
      stateDir,
      connectorsDir,
      values: { client_id: "abc123", refresh_token: "rt-xyz" },
    });

    expect(written).toEqual([
      "state/secrets/_connectors/qb/client_id",
      "state/secrets/_connectors/qb/refresh_token",
    ]);
    const clientId = await readFile(
      path.join(stateDir, "secrets", "_connectors", "qb", "client_id"),
      "utf8",
    );
    expect(clientId).toBe("abc123");
  });

  it("throws a helpful error when the connector id is unknown", async () => {
    await expect(
      runConnectorsAdd({
        connectorId: "no-such-thing",
        stateDir,
        connectorsDir,
        values: {},
      }),
    ).rejects.toThrow(/no manifest at|unknown connector/);
  });

  it("returns [] when a user connector declares no secrets", async () => {
    const cdir = path.join(connectorsDir, "noseed");
    await mkdir(path.join(cdir, "dist"), { recursive: true });
    await writeFile(
      path.join(cdir, "connector.toml"),
      `id = "noseed"\ndirection = "outbound"\nversion = "0.1.0"\n`,
      "utf8",
    );
    await writeFile(
      path.join(cdir, "dist", "index.js"),
      `export default () => ({ id: "noseed", direction: "outbound" });\n`,
      "utf8",
    );
    const written = await runConnectorsAdd({
      connectorId: "noseed",
      stateDir,
      connectorsDir,
      values: {},
    });
    expect(written).toEqual([]);
  });
});

describe("verona connectors build", () => {
  it("bundles src/index.ts into the manifest's entry", async () => {
    const cdir = path.join(connectorsDir, "echo");
    await mkdir(path.join(cdir, "src"), { recursive: true });
    await writeFile(
      path.join(cdir, "connector.toml"),
      `id = "echo"\ndirection = "outbound"\nversion = "0.1.0"\n`,
      "utf8",
    );
    await writeFile(
      path.join(cdir, "src", "index.ts"),
      `interface Init { secrets: Record<string, string> }
export default function createConnector(_init: Init) {
  return {
    id: "echo",
    direction: "outbound" as const,
    async send() {},
  };
}
`,
      "utf8",
    );

    const result = await runConnectorsBuild({ connectorId: "echo", connectorsDir });
    expect(result.output).toBe(path.resolve(cdir, "dist/index.js"));
    expect(result.bytes).toBeGreaterThan(0);
    const out = await readFile(result.output, "utf8");
    expect(out).toContain("createConnector");
    // ESM output by default
    expect(out).toMatch(/export\s*\{|export default/);
    await stat(result.output);
  });

  it("throws when no source file is present", async () => {
    const cdir = path.join(connectorsDir, "bare");
    await mkdir(cdir, { recursive: true });
    await writeFile(
      path.join(cdir, "connector.toml"),
      `id = "bare"\ndirection = "outbound"\nversion = "0.1.0"\n`,
      "utf8",
    );
    await expect(runConnectorsBuild({ connectorId: "bare", connectorsDir })).rejects.toThrow(
      /no source file/,
    );
  });
});
