# Deploying Verona as a service

Verona's daemon runs as a long-lived process. To survive reboots and run unattended, register it with your OS service manager.

## Recommended: `verona service install`

```bash
npm install -g verona-ai
verona init
verona service install     # detects platform, renders template, enables + starts the daemon
```

`verona service install` auto-detects the runtime path (where `verona-ai` was installed), the node binary (`process.execPath`), and the state dir (`$VERONA_STATE_DIR` or `~/.verona/state`). On Linux it writes `~/.config/systemd/user/verona-daemon.service` and runs `systemctl --user enable --now`. On macOS it writes `~/Library/LaunchAgents/com.verona.daemon.plist` and bootstraps it.

- Render without enabling: `verona service install --dry-run`
- Remove: `verona service uninstall`
- Status: `verona service status`

The rest of this document is the **manual** path — useful when you need to customize the unit file or deploy with infrastructure-as-code.

## Prerequisites (every host)

1. **Node 25.9+** installed and on `PATH`. Verify: `node --version`. (Recommended: install via `mise` and check `.tool-versions` is respected on the host.)
2. **The `claude` CLI installed and logged in.** Run `claude login` once. The default `claude-cli` adapter uses your subscription — Verona never sees the credentials.
3. **The runtime present on the host.** Either `npm install -g verona-ai` (then the runtime lives in your npm global `lib/node_modules/verona-ai/`) or build from source with `npm run build` and use the repo path as the runtime.
4. **A state directory.** Pick a path (e.g. `~/.verona/state` on Mac, `/var/lib/verona/state` on a server). Run `VERONA_STATE_DIR=<path> verona init` once on the host. The state dir is **never overwritten** by deploys.

## macOS — launchd

```bash
# 1. Customize the template
sed -e "s|{{VERONA_RUNTIME}}|/opt/verona/runtime|g" \
    -e "s|{{VERONA_STATE_DIR}}|$HOME/.verona/state|g" \
    -e "s|{{NODE_BIN}}|$(which node)|g" \
    -e "s|{{CLAUDE_BIN}}|$(which claude)|g" \
    -e "s|{{USER}}|$(id -un)|g" \
    /opt/verona/runtime/deploy/launchd/com.verona.daemon.plist.template \
    > ~/Library/LaunchAgents/com.verona.daemon.plist

# 2. Load it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.verona.daemon.plist
launchctl enable    gui/$(id -u)/com.verona.daemon
launchctl kickstart -k gui/$(id -u)/com.verona.daemon

# 3. Tail logs
tail -f ~/.verona/state/logs/daemon.stdout.log
```

To stop / remove:

```bash
launchctl bootout gui/$(id -u)/com.verona.daemon
rm ~/Library/LaunchAgents/com.verona.daemon.plist
```

## Linux — systemd (user-mode)

```bash
# 1. Customize the template
mkdir -p ~/.config/systemd/user
sed -e "s|{{VERONA_RUNTIME}}|/opt/verona/runtime|g" \
    -e "s|{{VERONA_STATE_DIR}}|$HOME/.verona/state|g" \
    -e "s|{{NODE_BIN}}|$(which node)|g" \
    -e "s|{{CLAUDE_BIN}}|$(which claude)|g" \
    /opt/verona/runtime/deploy/systemd/verona-daemon.service.template \
    > ~/.config/systemd/user/verona-daemon.service

# 2. Enable + start
systemctl --user daemon-reload
systemctl --user enable --now verona-daemon.service

# 3. Survive logouts (so the daemon keeps running on a headless server)
loginctl enable-linger $USER

# 4. Tail logs
journalctl --user -u verona-daemon -f
```

To stop / remove:

```bash
systemctl --user disable --now verona-daemon.service
rm ~/.config/systemd/user/verona-daemon.service
```

## Verifying the install

After registering the service:

```bash
verona doctor                         # state dir, secrets perms, claude login
verona schedule list                  # what jobs are scheduled
verona schedule next                  # what fires next, when
verona logs <agent> --latest          # most recent run log for an agent
```

## Troubleshooting

### `[claude-cli] failed to spawn claude`

systemd `--user` and launchd both start services with a sanitised `PATH` that
usually doesn't include `~/.local/bin`, fnm/nvm/mise version dirs, or wherever
your interactive shell happens to find `claude`. The unit pins
`VERONA_CLAUDE_BIN` to an absolute path to avoid this. If you see
`failed to spawn claude` in the logs after upgrading from an older install,
either re-run `verona service install` (it will re-render the unit with the
detected path) or add the env var manually:

```ini
# ~/.config/systemd/user/verona-daemon.service.d/override.conf
[Service]
Environment=VERONA_CLAUDE_BIN=/absolute/path/to/claude
```

Then `systemctl --user daemon-reload && systemctl --user restart verona-daemon`.

### `status=218/CAPABILITIES` restart loop on Linux

Some VPS providers run user systemd inside LXC/OpenVZ-style containers that
forbid namespace + capability operations. Hardening directives that need those
operations will fail with `Operation not permitted` and the daemon will loop on
restart. The shipped template avoids them — but if you've layered a drop-in
with extra hardening (or inherited one from a configuration-management tool),
remove or comment out:

```
ProtectHostname=    CapabilityBoundingSet=    AmbientCapabilities=
ProtectHome=        ProtectProc=              ProtectSystem=strict
BindReadOnlyPaths=  PrivateUsers=             RestrictNamespaces=
```

The shipped `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full`
combination works in every container we've tested.

## Why not Docker (yet)?

Docker support is intentionally post-v1. The `claude-cli` adapter relies on the host's `claude login` credentials — running it inside a container adds an auth-passthrough headache without enabling anything you can't do natively. We may add a Docker layout later for users who want to ship API-key adapters in containers.
