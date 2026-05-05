#!/usr/bin/env bash
# connector-guard.sh — PreToolUse hook for `mcp__verona__*` tool calls.
#
# Validates two things on every connector tool call:
#   1. The agent is subscribed to the targeted connector
#      (i.e. has a `[connectors.<id>]` block in agent.toml).
#   2. (Slack-specific Layer A) the destination channel is in the agent's
#      allowed channels list, when the policy declares one.
#
# Reads $VERONA_CONNECTOR_POLICY pointing at a per-run JSON file like:
#   {
#     "slack":     { "channels": ["C123", "U456"] },
#     "quickbooks": {}
#   }
# An entry with `channels: []` (or omitted) means no destination filter for
# that connector — Phase 5 will tighten this with sideEffect class checks.
#
# Stdin (from claude PreToolUse): { tool_name, tool_input, ... }.
# Stdout: empty (allow), or the deny JSON below.
# Exit code: 0 always — decisions are communicated via stdout JSON.
#
# See knowledge/architecture/connector-contract.md.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"verona connector-guard requires jq (not installed on host)"}}\n'
  exit 0
fi

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')

# Not an MCP verona tool → allow (memory-guard handles Write/Edit; other tools
# pass through unaffected). The settings.json matcher should already filter
# but we double-check defensively.
if [[ "$tool_name" != mcp__verona__* ]]; then
  exit 0
fi

# Extract connector id: mcp__verona__slack__send_message → slack
without_prefix="${tool_name#mcp__verona__}"
connector="${without_prefix%%__*}"

policy_path="${VERONA_CONNECTOR_POLICY:-}"
if [[ -z "$policy_path" || ! -f "$policy_path" ]]; then
  reason="verona connector-guard: no policy file at \"$policy_path\"; denying $tool_name for safety"
  jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
fi

policy=$(cat "$policy_path")
has_connector=$(printf '%s' "$policy" | jq --arg c "$connector" 'has($c)')

if [[ "$has_connector" != "true" ]]; then
  reason="verona connector-guard: agent is not subscribed to connector \"$connector\" (tool $tool_name)"
  jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
fi

# Slack-specific Layer A: enforce destination allowlist if the policy specifies one.
if [[ "$connector" == "slack" ]]; then
  channel=$(printf '%s' "$input" | jq -r '.tool_input.channel // empty')
  if [[ -n "$channel" ]]; then
    has_channels=$(printf '%s' "$policy" | jq '.slack.channels // [] | length')
    if [[ "$has_channels" -gt 0 ]]; then
      is_allowed=$(printf '%s' "$policy" | jq --arg ch "$channel" '.slack.channels // [] | any(.[]; . == $ch)')
      if [[ "$is_allowed" != "true" ]]; then
        reason="verona connector-guard: slack destination \"$channel\" not in agent allowlist (tool $tool_name)"
        jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
        exit 0
      fi
    fi
  fi
fi

# Layer B: deny "destructive" capabilities unless the agent's [connectors.<id>]
# block sets allow_destructive=true. The dispatcher writes per-capability
# sideEffect metadata into the policy file at run start.
capability="${without_prefix#${connector}__}"
side_effect=$(printf '%s' "$policy" | jq -r --arg c "$connector" --arg cap "$capability" '.[$c].capabilities[$cap].sideEffect // empty')
if [[ "$side_effect" == "destructive" ]]; then
  allow_destructive=$(printf '%s' "$policy" | jq -r --arg c "$connector" '.[$c].allow_destructive // false')
  if [[ "$allow_destructive" != "true" ]]; then
    reason="verona connector-guard: capability $tool_name is destructive and the agent's [connectors.$connector] block does not set allow_destructive=true"
    jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0
  fi
fi

exit 0
