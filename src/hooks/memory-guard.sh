#!/usr/bin/env bash
# memory-guard.sh — PreToolUse hook for `claude -p`.
#
# Runs as a Claude Code hook on every Write/Edit tool call. Reads the tool
# input JSON on stdin, extracts the file_path, and emits a
# `permissionDecision: "deny"` for any path outside the writable zone:
#   - <agent-dir>/memory/INDEX.md
#   - <agent-dir>/memory/learned/**
#
# Additional cap: memory/learned/facts/preferences.md is eagerly loaded into
# every fresh-session system prompt, so it must stay tight. Writes that would
# push it past 60 lines are denied synchronously here — the agent is forced
# to rewrite-to-consolidate rather than append-and-bloat.
#
# The agent-dir is passed via $VERONA_AGENT_DIR (set by the claude-cli
# adapter when spawning the subprocess).
#
# Exit code 0 always — decision is communicated via stdout JSON.
# See knowledge/architecture/memory-protocol.md for the contract.

set -euo pipefail

PREFERENCES_LINE_CAP=60

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
preferences_path="$abs_agent/memory/learned/facts/preferences.md"

emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Path is outside the writable zone → deny.
if [[ "$abs_target" != "$writable_index" && "$abs_target" != "$writable_learned_prefix"* ]]; then
  emit_deny "verona memory-guard: writes outside memory/INDEX.md and memory/learned/ are denied. Attempted: $abs_target"
fi

# preferences.md cap — applies whether the file already exists or not.
if [[ "$abs_target" == "$preferences_path" ]]; then
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')
  resulting_lines=0

  if [[ "$tool_name" == "Write" ]]; then
    content=$(printf '%s' "$input" | jq -r '.tool_input.content // ""')
    resulting_lines=$(printf '%s' "$content" | awk 'END { print NR }')
  elif [[ "$tool_name" == "Edit" ]]; then
    old_string=$(printf '%s' "$input" | jq -r '.tool_input.old_string // ""')
    new_string=$(printf '%s' "$input" | jq -r '.tool_input.new_string // ""')
    old_lines=$(printf '%s' "$old_string" | awk 'END { print NR }')
    new_lines=$(printf '%s' "$new_string" | awk 'END { print NR }')
    if [[ -f "$abs_target" ]]; then
      existing_lines=$(awk 'END { print NR }' "$abs_target")
      resulting_lines=$((existing_lines - old_lines + new_lines))
    else
      # Edit against a non-existent file shouldn't normally happen, but treat
      # it as a Write of just new_string.
      resulting_lines=$new_lines
    fi
  fi
  # Other tool names (none expected for Write|Edit matcher) → fall through.

  if [[ $resulting_lines -gt $PREFERENCES_LINE_CAP ]]; then
    emit_deny "verona memory-guard: preferences.md would exceed ${PREFERENCES_LINE_CAP} lines (got ${resulting_lines}). Rewrite to consolidate, don't append."
  fi
fi

exit 0
