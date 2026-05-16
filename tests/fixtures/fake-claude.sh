#!/usr/bin/env bash
# Fake `claude` binary for tests. Records args + selected env to a file
# specified by $VERONA_FAKE_CLAUDE_LOG, then emits a synthetic stream-json
# success event so the adapter can complete its parse.
#
# Set $VERONA_FAKE_CLAUDE_EXIT to a non-zero code to simulate failure.

set -u

log="${VERONA_FAKE_CLAUDE_LOG:-/dev/null}"

{
  echo "ARGS:"
  for a in "$@"; do
    printf '  %s\n' "$a"
  done
  echo "ENV:"
  for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN VERONA_AGENT_DIR; do
    val="${!var-__UNSET__}"
    printf '  %s=%s\n' "$var" "$val"
  done
} >> "$log"

exit_code="${VERONA_FAKE_CLAUDE_EXIT:-0}"
if [[ "$exit_code" != "0" ]]; then
  # Optionally emit a stream-json line on stdout before dying — mirrors real
  # claude -p, which reports API/image errors as a stdout result event and
  # often writes nothing to stderr.
  if [[ -n "${VERONA_FAKE_CLAUDE_STDOUT_JSON:-}" ]]; then
    printf '%s\n' "$VERONA_FAKE_CLAUDE_STDOUT_JSON"
  fi
  if [[ -n "${VERONA_FAKE_CLAUDE_STDERR:-}" ]]; then
    printf '%s\n' "$VERONA_FAKE_CLAUDE_STDERR" >&2
  else
    echo "fake-claude: forced exit $exit_code" >&2
  fi
  exit "$exit_code"
fi

# Synthetic stream-json output. The adapter only requires a `result` event
# with subtype=success.
cat <<'JSON'
{"type":"system","subtype":"init","session_id":"fake-session","tools":[]}
{"type":"result","subtype":"success","is_error":false,"duration_ms":42,"num_turns":2,"result":"hello from fake claude","session_id":"fake-session-out","total_cost_usd":0.001234,"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}
JSON
