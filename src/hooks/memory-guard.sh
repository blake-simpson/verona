#!/usr/bin/env bash
# memory-guard.sh — PreToolUse hook for `claude -p`.
#
# Runs as a Claude Code hook on every Write/Edit tool call. Reads the tool
# input JSON on stdin, extracts the file_path, and emits a
# `permissionDecision: "deny"` for any path outside the writable zone:
#   - <agent-dir>/memory/INDEX.md
#   - <agent-dir>/memory/learned/**
#
# The agent-dir is passed via $VERONA_AGENT_DIR (set by the claude-cli
# adapter when spawning the subprocess).
#
# Exit code 0 always — decision is communicated via stdout JSON.
# See knowledge/architecture/memory-protocol.md for the contract.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"verona memory-guard requires jq (not installed on host)"}}'
  exit 0
fi

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

# No file_path → not a Write/Edit, allow.
if [[ -z "$file_path" ]]; then
  exit 0
fi

agent_dir="${VERONA_AGENT_DIR:-}"
if [[ -z "$agent_dir" ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"VERONA_AGENT_DIR not set; cannot validate write target"}}\n'
  exit 0
fi

# Resolve to absolute paths for comparison. macOS readlink lacks -f without
# coreutils, so we use a portable Python one-liner via realpath if available,
# else fall back to bash logic.
abs_target=$(cd "$(dirname "$file_path")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$file_path")" || printf '%s' "$file_path")
abs_agent=$(cd "$agent_dir" && pwd)

writable_index="$abs_agent/memory/INDEX.md"
writable_learned_prefix="$abs_agent/memory/learned/"

if [[ "$abs_target" == "$writable_index" ]]; then
  exit 0
fi

if [[ "$abs_target" == "$writable_learned_prefix"* ]]; then
  exit 0
fi

reason="verona memory-guard: writes outside memory/INDEX.md and memory/learned/ are denied. Attempted: $abs_target"
jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
