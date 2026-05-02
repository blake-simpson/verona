# Deploying Verona as a service

Verona's daemon runs as a long-lived process. To survive reboots and run unattended, register it with your OS service manager. Two templates are provided.

## Prerequisites (every host)

1. **Node 25.9+** installed and on `PATH`. Verify: `node --version`. (Recommended: install via `mise` and check `.tool-versions` is respected on the host.)
2. **The `claude` CLI installed and logged in.** Run `claude login` once. The default `claude-cli` adapter uses your subscription — Verona never sees the credentials.
3. **The runtime artifact deployed.** Build with `verona build` on a dev host, then copy the `verona-runtime/` directory to the target host (e.g. via `rsync -av verona-runtime/ host:/opt/verona/runtime/`).
4. **A state directory.** Pick a path (e.g. `~/.verona/state` on Mac, `/var/lib/verona/state` on a server). Run `VERONA_STATE_DIR=<path> verona init` once on the host. The state dir is **never overwritten** by deploys.

## macOS — launchd

```bash
# 1. Customize the template
sed -e "s|{{VERONA_RUNTIME}}|/opt/verona/runtime|g" \
    -e "s|{{VERONA_STATE_DIR}}|$HOME/.verona/state|g" \
    -e "s|{{NODE_BIN}}|$(which node)|g" \
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

## Why not Docker (yet)?

Docker support is intentionally post-v1. The `claude-cli` adapter relies on the host's `claude login` credentials — running it inside a container adds an auth-passthrough headache without enabling anything you can't do natively. We may add a Docker layout later for users who want to ship API-key adapters in containers.
