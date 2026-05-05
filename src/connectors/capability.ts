/**
 * ConnectorCapability — a tool exposed to agents during a task spawn.
 *
 * Connectors publish `capabilities()` returning a list of these. The per-spawn
 * MCP server registers each as an MCP tool named
 * `mcp__verona__<connectorId>__<capability.name>`, validates inputs against
 * `inputSchema`, dispatches `invoke`, and writes one `connector_call` audit
 * record per call.
 *
 * Capabilities are how the agent itself reaches the outside world — distinct
 * from `Connector.send()` which is the system's daemon-side outbound for
 * notifications and the legacy auto-post fallback.
 *
 * See knowledge/architecture/connector-contract.md.
 */

export type CapabilitySideEffect = "read" | "write" | "destructive";

export interface ConnectorCapability {
  /**
   * kebab-case name unique within the connector. Final tool name is
   * `mcp__verona__<connectorId>__<name>`.
   */
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the capability input. The MCP server validates before invoke(). */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Side-effect class. The PreToolUse connector-guard hook denies destructive
   * calls unless the agent's [connectors.<id>] subscription opts in.
   */
  readonly sideEffect: CapabilitySideEffect;
  invoke(input: unknown, ctx: CapabilityCallContext): Promise<CapabilityResult>;
}

export interface CapabilityCallContext {
  /** ULID of the parent task spawn — same for every call inside one spawn. */
  readonly runId: string;
  /** The agent the spawn belongs to. */
  readonly agentName: string;
  /**
   * Per-run scratch dir, scoped to (agentName, runId). Capabilities read
   * inbound attachments here and stage outbound files. Created by the
   * dispatcher before the spawn starts. Capabilities MUST stay inside it.
   */
  readonly attachmentsDir: string;
  /**
   * Anchor a future inbound message to the current claude-p session. Called
   * by capabilities that produce a stable conversation key on success
   * (e.g. Slack returns `ts` after chat.postMessage). The MCP server appends
   * the anchor to anchors.ndjson; the dispatcher drains it after the spawn
   * exits and writes (agent, threadKey) → sessionId into SessionStore.
   */
  anchorThread(threadKey: string): void;
}

export interface CapabilityResult {
  /** Returned to the agent verbatim as the MCP tool response. */
  output: unknown;
  /** Optional fields copied into the connector_call audit record. */
  destination?: string;
  threadKey?: string;
  messageBytes?: number;
}
