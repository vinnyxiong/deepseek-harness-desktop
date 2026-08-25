# DeepSeek Harness Desktop

Electron desktop wrapper for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The application can start the bundled `dsh web` service on a free local port, or connect to a remote DSH through an SSH tunnel that the user has already established.

## Connection modes

### Managed SSH tunnel

The recommended remote mode lets the App run and own the SSH forward automatically. The initial form is prefilled for:

```text
SSH host: 10.37.117.240
SSH user: xiongyuanwen
SSH port: 22
Local port: 3080
Remote DSH port: 3080
```

It safely invokes the argument-array equivalent of:

```bash
ssh -N -L 3080:127.0.0.1:3080 xiongyuanwen@10.37.117.240
```

The remote machine must already run `dsh web --port 3080`. The App starts the system `/usr/bin/ssh`, verifies the DSH page through the tunnel, and stops SSH when you disconnect, switch modes, or quit the App. Closing only the macOS window keeps the connection running, following normal macOS behavior.

Authentication is non-interactive: use `ssh-agent`, macOS Keychain, `~/.ssh/config`, or an already usable identity file. The App never asks for or stores SSH passwords or key passphrases. New host keys are accepted and recorded on first connection; changed host keys are rejected.

### Local DSH

Local mode is the default. The App starts the bundled `dsh web --port 0`, validates the local service, and stops that child process when the App exits.

### Local DSH upgrade data backup and recovery

The bundled DSH version can change between App releases (for example `0.1.0-rc.6` → `0.1.1-rc.2`). Before the first launch on a new DSH version touches your local data, the App takes a one-time, atomic backup of the `.dsh` directory so an incompatible upgrade cannot silently corrupt or lose existing sessions.

How it works:

- The App records the active DSH version in a marker file at `<userData>/.dsh-version`.
- On startup, before local DSH starts, the App compares the target DSH version against the marker. When they differ (any change, including downgrades), it copies `<userData>/.dsh` into `<userData>/.dsh-backups/<oldVersion>-<timestamp>/`, excluding lock, temporary, and socket artifacts.
- The backup is written to a `.partial-<pid>` staging directory and only revealed by an atomic rename after it fully succeeds. The version marker is written atomically only after the backup completes.
- If the backup fails, the App throws and refuses to start local DSH, leaving the marker unchanged so the next launch retries the backup. Your original `.dsh` data is never modified by this step.
- If `.dsh` does not exist or contains no real data (fresh install, or only lock/temp files), no copy is made; the App just records the current version.

To recover a previous version's data, quit the App and restore the desired snapshot from `<userData>/.dsh-backups/`:

```bash
# Locate the backups (macOS example)
cd ~/Library/Application\ Support/DeepSeek\ Harness/.dsh-backups
ls -1

# Restore a snapshot over the current .dsh directory
rm -rf ../.dsh
cp -a "0.1.0-rc.6-2026-08-25T00-00-00-000Z" ../.dsh
```

The `<userData>` directory is Electron's user-data path (for example `~/Library/Application Support/DeepSeek Harness` on macOS, `%APPDATA%/DeepSeek Harness` on Windows, and `~/.config/DeepSeek Harness` on Linux). Old backups are kept until you remove them manually.

### Existing SSH tunnel

The App can also load a remote DSH through a loopback port forwarded by an SSH process that you manage separately. Start DSH on the remote machine, keeping it bound to remote loopback:

```bash
dsh web --port 3080
```

Then establish the tunnel from the local Mac:

```bash
ssh -N -L 3080:127.0.0.1:3080 xiongyuanwen@10.37.117.240
```

Open **Connection → Connection Settings…**, choose **Existing SSH tunnel**, set the local forwarded port to `3080`, and connect. The App verifies and loads `http://127.0.0.1:3080`.

The App remembers the last selected mode and automatically retries it on the next launch. If the tunnel is unavailable, it opens the connection settings instead of silently falling back to local DSH.

Important security and lifecycle details:

- The App does not start or stop `ssh` and does not start DSH on the remote machine.
- SSH authentication, host-key checks, passwords, private keys, and `~/.ssh/config` remain entirely under the system SSH client. The App stores none of them.
- The App only accepts a numeric loopback port and always constructs the URL as `http://127.0.0.1:<port>`.
- The remote DSH should stay bound to `127.0.0.1`; do not expose it with `--host 0.0.0.0`.
- Desktop connection preferences are stored in Electron's user-data directory as `desktop-settings.json`. Local DSH data remains under the `.dsh` subdirectory.

## Task completion notifications

DeepSeek Harness Desktop can show native notifications when an Agent stops running and when background jobs complete, fail, or are killed. Open **DeepSeek Harness → Notification Settings…** from the macOS application menu to configure event categories, focus suppression, sound, and click-to-focus behavior.

The notification watcher uses DSH's official host and mux event streams for local DSH, managed SSH, and external loopback tunnels. Existing idle sessions and terminal jobs are baselined without notification, so startup and reconnect do not replay old completions. Completions that happen while the App or event stream is disconnected are not replayed.

Notifications are emitted by the Electron main process; DSH web content remains sandboxed and has no native notification permission. Clicking a notification only focuses or restores the App and never opens an event-provided URL. macOS notification permissions, Focus mode, sound, and lock-screen previews can override the App settings. Signed builds with a stable bundle identifier provide the most reliable Notification Center identity; unsigned test builds may behave differently.

## Menu language

Custom desktop menu labels and completion notifications follow DSH's `locale.preference` (`中文` or `English`) and update without restarting after the DSH language setting changes. If DSH has no explicit preference, the App follows the first supported system preferred language and falls back to Chinese. Native Electron role items such as About, Services, Copy, and Quit continue to follow the operating system language.


- Node.js 24
- npm
- macOS is required to create macOS packages

## Development

```bash
npm ci
npm run dev
```

## Build caches

The DSH bundle and generated application icons use content fingerprints. Re-running a build skips unchanged outputs only when their cache metadata and output validation both succeed. Outputs and metadata are written through temporary files and renamed into place so a failed generation does not replace the last good artifact.

Use the force variants to rebuild regardless of cache state:

```bash
npm run build:bundle:force
npm run build:icons:force
npm run build:icons:mac:force # requires macOS/iconutil
```

For a quick unsigned, unpacked macOS application build:

```bash
npm run pack:mac:unsigned
```

The existing `dist*` commands retain their packaged distribution behavior.

## Linux packages

```bash
npm run dist:linux
```

Outputs:

- `release/DeepSeek Harness-<version>.AppImage`
- `release/deepseek-harness-desktop_<version>_amd64.deb`

## macOS packages

Build each architecture on matching macOS hardware. Do not reuse `node_modules` installed on Linux or for another architecture.

```bash
npm ci
npm run dist:mac:arm64  # Apple Silicon
npm run dist:mac:x64    # Intel
```

Outputs include the architecture in their names:

```text
DeepSeek-Harness-<version>-mac-arm64.dmg
DeepSeek-Harness-<version>-mac-arm64.zip
DeepSeek-Harness-<version>-mac-x64.dmg
DeepSeek-Harness-<version>-mac-x64.zip
```

A universal build is intentionally not produced. DeepSeek Harness includes architecture-specific native dependencies, so separate native builds are easier to verify and distribute safely.

## GitHub Actions

The `Build macOS installers` workflow runs on native GitHub-hosted runners:

- Intel: `macos-15-intel`
- Apple Silicon: `macos-15`

Run it manually from the Actions tab, or push a tag matching `v*`. Each matrix job installs a fresh dependency tree, builds DMG/ZIP files, checks the executable architecture, starts the packaged `dsh` backend, validates the web page, verifies the archives, and uploads checksums with the installers.

The repository must be committed and pushed to GitHub before the workflow can run.

## Signing and notarization

Without signing secrets, the workflow still produces unsigned testing packages. macOS Gatekeeper may block them; users may need to approve the application in **System Settings → Privacy & Security**.

To sign packages, configure:

- `MAC_CSC_LINK` — base64 certificate or supported certificate URL
- `MAC_CSC_KEY_PASSWORD`
- `MAC_CSC_NAME` — optional signing identity selector

To notarize with an App Store Connect API key, also configure:

- `APPLE_API_KEY_BASE64` — base64 contents of the `.p8` key
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Alternatively, use Apple ID credentials:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Notarization is enabled only when signing and one complete credential set are available.
