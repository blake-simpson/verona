# Changelog

## v0.3.0

**Released:** 2026-05-05

### Changes since v0.2.4

- chore: add scripts/dev-smoke.sh for the local-edit / remote-run flow
- feat: verona reload auto-refreshes registered agents from source
- fix: drain in-flight audit appends in Daemon.stop()
- feat: user-authored connectors + ~/.verona/user/ git repo + auto-sync

## v0.2.4

**Released:** 2026-05-05

### Changes since v0.2.3

- fix: stop() only removes the pidfile the running daemon wrote

## v0.2.3

**Released:** 2026-05-05

### Changes since v0.2.2

- feat: auto-post task response to slack via post_response per-task flag

## v0.2.2

**Released:** 2026-05-05

### Changes since v0.2.1

- feat: pin claude binary path in rendered service units

## v0.2.1

**Released:** 2026-05-04

### Changes since v0.2.0

- feat: add --version / -v flag to the CLI

## v0.2.0

**Released:** 2026-05-04

### Changes since v0.1.3

- feat: add `verona service restart` and `verona service logs`

## v0.1.3

**Released:** 2026-05-04

### Changes since v0.1.2

- fix: set repo-local git identity in state-dir when no global config exists

## v0.1.2

**Released:** 2026-05-04

### Changes since v0.1.1

- Add release script
