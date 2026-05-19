#!/usr/bin/env bash
# bash-guard.sh — PreToolUse hook for `claude -p` (matcher: Bash).
#
# Verona runs workers under `--permission-mode bypassPermissions` so the agent
# can do real work (generate a PDF, run a build script) without an interactive
# prompt that nobody can answer headlessly. This hook is the boundary that
# makes that "limited and safe": it reads the Bash tool input on stdin and
# denies commands that reach for secrets, SSH/cloud credentials, the system
# (apt/sudo/systemd/etc), other agents' state, or are catastrophically
# destructive. Everything else is allowed — agents are the user's own trusted
# models doing scoped work, the threat model is accidental damage and
# inbound-content prompt injection, not a determined attacker with a shell.
#
# Defense-in-depth, not a perfect sandbox: the subprocess is already
# --add-dir-scoped, ANTHROPIC_API_KEY is scrubbed from its env, and every
# memory write is git-committed. A shell denylist can be obfuscated around;
# that is an accepted tradeoff documented in claude-p-invocation.md.
#
# The agent-dir is passed via $VERONA_AGENT_DIR (set by the claude-cli adapter).
#
# Exit code 0 always — decision is communicated via stdout JSON.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"verona bash-guard requires jq (not installed on host)"}}'
  exit 0
fi

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')

# Only gate Bash. Anything else slips through (Write/Edit have memory-guard).
if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
if [[ -z "$command" ]]; then
  exit 0
fi

emit_deny() {
  jq -nc --arg r "verona bash-guard: $1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Single-line, lowercased view for matching. Newlines collapse to spaces so a
# multi-line script can't hide a banned token past a line break.
scan=$(printf '%s' "$command" | tr '\n' ' ' | tr '[:upper:]' '[:lower:]')

# Privilege escalation + host/service control.
if printf '%s' "$scan" | grep -Eq '(^| |;|&|\|)(sudo|doas)( |$)|(^| |;|&|\|)su( +-|$| +root)|systemctl|loginctl|journalctl|(^| |;|&|\|)service +|crontab|(^| |;|&|\|)(reboot|shutdown|halt|poweroff|init +[06])( |$)'; then
  emit_deny "privilege escalation / host control commands are not allowed (sudo, su, systemctl, reboot, crontab, …)."
fi

# System package managers / global installs.
if printf '%s' "$scan" | grep -Eq '(^| |;|&|\|)(apt|apt-get|aptitude|yum|dnf|zypper|pacman|apk|snap|brew)( |$)|(npm|pnpm|yarn) +(i|install|add) +.*(-g|--global)|(^| |;|&|\|)(pip|pip3|pipx|gem|cargo) +install'; then
  emit_deny "system / global package installs are not allowed."
fi

# Secrets, SSH keys, cloud + auth credential stores.
if printf '%s' "$scan" | grep -Eq '/secrets/|/secrets$|\.ssh/|id_rsa|id_ed25519|id_ecdsa|authorized_keys|\.pem( |$)|\.aws/credentials|\.config/gcloud|\.kube/config|\.git-credentials|(^| )\.netrc|\.npmrc|anthropic_api_key|anthropic_auth_token'; then
  emit_deny "reading or touching credential stores (secrets/, ~/.ssh, cloud creds, API tokens) is not allowed."
fi

# Catastrophic filesystem / device operations.
if printf '%s' "$scan" | grep -Eq 'rm +(-[a-z]* +)*-?[rf][rf]? +(/|~|\$home)( |$)|(^| )mkfs|(^| )dd +if=|>/dev/sd|>/dev/nvme|chmod +(-r +)?(777|-r) +/( |$)|:\(\)\{|fork *bomb'; then
  emit_deny "catastrophic filesystem/device operations are not allowed."
fi

# Writes into system locations.
if printf '%s' "$scan" | grep -Eq '(>|>>|tee +) */(etc|usr|bin|sbin|boot|lib|lib64|root|sys|proc)/'; then
  emit_deny "writing into system directories (/etc, /usr, /root, …) is not allowed."
fi

# Pipe-to-shell of network-fetched content (curl … | sh, wget … | bash).
if printf '%s' "$scan" | grep -Eq '(curl|wget|fetch)\b.*\|\s*(sudo +)?(ba)?sh\b'; then
  emit_deny "piping network-fetched content straight into a shell is not allowed."
fi

# Other agents' state. The worker may only operate inside its own agent dir
# (and its run dir, which is outside agents/). If the command names the shared
# agents root with a different agent than this one, deny.
agent_dir="${VERONA_AGENT_DIR:-}"
if [[ -n "$agent_dir" ]]; then
  agents_root=$(dirname "$agent_dir")
  agent_name=$(basename "$agent_dir")
  if printf '%s' "$command" | grep -Fq "$agents_root/"; then
    # Strip every reference to this agent's own dir, then see if any other
    # "<agents_root>/<something>" path remains.
    residue=$(printf '%s' "$command" | sed "s|${agents_root}/${agent_name}|__SELF__|g")
    if printf '%s' "$residue" | grep -Fq "$agents_root/"; then
      emit_deny "accessing another agent's state under ${agents_root}/ is not allowed."
    fi
  fi
fi

exit 0
