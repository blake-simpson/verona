/**
 * post_response was removed in v0.4. Ensure the loader rejects any task
 * that still declares it and gives the user a clear migration message.
 */

import { describe, expect, it } from "vitest";
import { parseAgent } from "../../src/config/loader.js";

const TOML_WITH_POST_RESPONSE = `
[agent]
name = "hello-world"

[[tasks]]
id = "scan"
prompt = "./tasks/scan.md"
schedule = "0 9 * * *"
post_response = true
`;

const TOML_WITHOUT_POST_RESPONSE = `
[agent]
name = "hello-world"

[[tasks]]
id = "scan"
prompt = "./tasks/scan.md"
schedule = "0 9 * * *"
`;

describe("post_response removal", () => {
  it("rejects agent.toml that still declares post_response", () => {
    expect(() => parseAgent(TOML_WITH_POST_RESPONSE, "test-agent.toml")).toThrow(/post_response/);
    expect(() => parseAgent(TOML_WITH_POST_RESPONSE, "test-agent.toml")).toThrow(
      /slack__send_message/,
    );
  });

  it("accepts an agent.toml without post_response", () => {
    const cfg = parseAgent(TOML_WITHOUT_POST_RESPONSE, "test-agent.toml");
    expect(cfg.tasks).toHaveLength(1);
    expect(cfg.tasks[0]?.id).toBe("scan");
    // Removed field should not appear on the parsed object.
    expect("post_response" in (cfg.tasks[0] as object)).toBe(false);
  });
});
