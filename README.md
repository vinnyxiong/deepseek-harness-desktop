# DeepSeek Harness Desktop

Electron desktop wrapper for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The application starts the bundled `dsh web` service on a free local port and opens it in an Electron window.

## Requirements

- Node.js 24
- npm
- macOS is required to create macOS packages

## Development

```bash
npm ci
npm run dev
```

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
