# Secrets handling

## Why this matters

Verona is open source. Every line of code, every example, every docs change is publicly scrutinized. One leaked token is a credibility crater. Every `.env.example`, every README snippet, every test fixture has to assume it'll be on a public README screenshot tomorrow.

## Invariant

1. **Secrets live in `state/secrets/` only.** Never in `process.env` for daemon-managed secrets (Anthropic API keys, OpenAI keys, OpenRouter keys, Slack tokens, OAuth refresh tokens, etc.). Env vars are for daemon-level config (log level, state dir path).
2. **Per-agent scoping.** `state/secrets/<agent>/` is readable only by that agent's runs. The dispatcher injects a scoped view into the subprocess env at invoke time.
3. **Perms enforced.** `state/secrets/` is `0700`; files inside are `0600`. The daemon refuses to start otherwise (`verona doctor` flags it; the daemon has the same check).
4. **Never log secret values.** Audit-log fields like `messageBytes` are size-only. If a secret accidentally appears in a connector error, redact it.
5. **Examples use `<replace-me>` placeholders.** Never paste a real-looking token even if it's revoked.

## How it's enforced

- `src/secrets/store.ts` is the single read path. It checks file mode on every read; refuses if perms are wrong.
- `scripts/check-secrets.sh` is a pre-commit hook that greps for known token prefixes (`xoxb-`, `xapp-`, `sk-ant-`, `sk-or-`, `ghp_`, `gho_`, etc.).
- `state/` is in `.gitignore` at the source-repo level, AND the state-tree's own `.git` (memory history) is local-only by default.
- Tests use throwaway tokens generated per-test, never reused.

## Failure mode if you break it

- Secret committed to public repo → revoke + rotate + force-push history (visible to anyone who cloned in the meantime; assume compromised).
- Wrong perms on `state/secrets/` → another local user on the host can read agent tokens.
- Loading a global env var as a fallback → user moves to a multi-user host and one account's keys leak across agents.

## Don't re-do

- **Don't add a "secrets in env vars" fallback.** Tempting for "just one quick test." Don't. Secrets always come from the store.
- **Don't encrypt secrets at rest in v1.** Considered (age, sops). Rejected because it adds a passphrase prompt at daemon startup, which breaks unattended boot. v2 design problem.
- **Don't use the OS keychain in v1.** macOS Keychain works on Mac; libsecret on Linux is fragmented. Filesystem with chmod is the consistent option.

## Evidence

- Store: `src/secrets/store.ts`
- Pre-commit hook: `scripts/check-secrets.sh`
- Doctor command: `src/cli/commands/doctor.ts`

## Revisions

- 2026-05-02 — initial entry; chmod-enforced filesystem store with per-agent scoping.
