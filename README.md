<div align="center">

<img src="docs/logo.png" width="120" alt="Service Settings logo">

# Service Settings

### A one-page switchboard for the Windows services you actually care about

**Add a service once, then start and stop it with one switch instead of hunting through `services.msc` — and see its real state every time the window opens.**

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://v2.tauri.app/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF.svg)](https://vite.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-orange.svg)](https://www.rust-lang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#requirements)
[![License](https://img.shields.io/badge/license-not%20set-lightgrey.svg)](#license)

English | [中文](README_ZH.md)

**[Quick Start](#quick-start) · [Features](#features) · [FAQ](#faq)**

</div>

## Why Service Settings?

`services.msc` is designed for administrators, not for the two or three services a developer restarts all day: it takes a UAC prompt, a scroll through an alphabetical list, and a right-click → Start / Stop → wait → close. This app reduces that to a card with a switch.

- **One card per service** — the name you gave it, and a toggle that starts / stops the service through the Windows Service Control Manager
- **State read from the real service** — refreshed on launch and every 5 seconds, so a service stopped elsewhere doesn't stay "running"
- **Elevation handled once** — the app checks its token at startup and relaunches itself with the Windows `runas` verb if it isn't elevated; if UAC is declined, a 以管理员重启 button stays in the title bar so elevation can be retried without restarting the app
- **The list survives restarts** — cards are stored in a JSON file managed by the Rust backend
- **Back up and move your list** — export / import the configuration as a JSON file, from the buttons in the title bar
- **Update from the app** — checks GitHub Releases, downloads the NSIS installer, verifies its SHA256 and installs it; if `api.github.com` is rate-limited or unreachable, the check and the download fall back to plain `github.com` release pages and direct asset URLs
- **Frameless window** — the in-page title bar is white with a thin divider, above a white rounded panel with blue accents; drag it to move the window and use its minimize / maximize / close buttons
- **Editing is explicit** — the `+` card and delete × only appear in edit mode (the 编辑 / 完成 button in the title bar), so a stray click can't remove a service

## Requirements

- **Windows 10/11 (x64)** — the command layer uses the Win32 Service Control Manager, and the installer targets NSIS
- **Administrator rights** for starting and stopping services. Reading state is read-only and works without them
- **WebView2 Runtime** — included with Windows 11; on Windows 10 the NSIS installer downloads the bootstrapper if needed
- **Node.js** `^20.19.0 || >=22.12.0` (Vite 7) and **Rust stable** with the **MSVC Build Tools / Windows SDK** (Tauri's Windows target is MSVC-only) — build-time only
- **Service names, not display names** — the app passes the value to `OpenServiceW`, which expects the _service name_ (e.g. `MySQL84`), not the display name shown in `services.msc`

## Quick Start

```bash
npm install
npm run tauri dev
```

Build the frontend or produce an installer:

```bash
npm run build          # bundles the renderer into src/renderer/dist/
npm run tauri build    # NSIS installer (x64)
```

> On first launch Windows asks for elevation. If you decline, the window still opens but every start/stop fails with a permission message — click **以管理员重启** in the title bar to retry.

## Usage

1. **Add** — click 编辑 in the title bar, then click the `+` card (only visible in edit mode), enter a label and the Windows service name, then confirm.
2. **Toggle** — click the switch, or focus it and press <kbd>Space</kbd> / <kbd>Enter</kbd>. The switch springs back if the command fails, and further clicks are ignored while one is in flight.
3. **Delete** — in edit mode, click the plain × in a card's corner and confirm. Click 完成 to leave edit mode.
4. **Export / import** — the two title-bar buttons. Export downloads `service-settings.json`; import validates the file and reloads the page.

With no configuration yet the list is empty and shows an inline hint; click 编辑 and then the `+` card to add your first service.

## How it works

| Layer           | File                         | Responsibility                                                                                                                                                                                                                            |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust commands   | `src-tauri/src/lib.rs`       | Validates `action` / `name`, calls Win32 SCM (`OpenSCManagerW` / `OpenServiceW` / `QueryServiceStatusEx` / `StartServiceW` / `ControlService`), maps Win32 error codes, checks elevation via `TokenElevation` and relaunches with `runas` |
| Rust storage    | `src-tauri/src/lib.rs`       | `load_services` / `save_services` read and atomically write `app_data_dir()/services.json`                                                                                                                                                |
| Rust updater    | `src-tauri/src/update.rs`    | GitHub Releases API check with a plain-`github.com` fallback, SHA256-verified installer download, silent NSIS install                                                                                                                     |
| Frontend bridge | `src/renderer/src/api.js`    | `invoke` wrappers for service commands, elevation status and elevation restart                                                                                                                                                            |
| Renderer        | `src/renderer/src/update.js` | Update check / install dialog, download progress and "new version" badge                                                                                                                                                                  |
| Renderer        | `src/renderer/src/switch.js` | Renders cards, debounces toggles (500 ms), refreshes state every 5 s with an in-flight guard                                                                                                                                              |
| Renderer        | `src/renderer/src/config.js` | Export / import the configuration as JSON                                                                                                                                                                                                 |
| Renderer        | `src/renderer/src/delete.js` | Plain × delete button, shown only in edit mode, with confirm-then-remove                                                                                                                                                                  |
| Renderer        | `src/renderer/src/store.js`  | Load / save the list, with a one-time migration from the old IndexedDB store                                                                                                                                                              |
| Renderer        | `src/renderer/src/notify.js` | Non-blocking toast messages and an in-page confirmation dialog                                                                                                                                                                            |

The service name whitelist is enforced **in Rust**, not in the page: a Tauri frontend can call `invoke` directly, so the renderer's `SERVICE_NAME_PATTERN` is only an input hint. Both sides must stay in sync (see `src/shared/services.js`).

A service counts as running when SCM reports `dwCurrentState == SERVICE_RUNNING` (4). No `sc query` text is parsed, so `STOP_PENDING` / `START_PENDING` can't be misread and there is no console encoding to decode. Win32 error codes are mapped to readable Chinese messages; anything else falls back to the system's localized `FormatMessageW` text.

## Features

### Service cards

- **Per-card switch** — custom-drawn toggle (a checkbox with styled slider); its `checked` state mirrors the service state, not the last click
- **Keyboard accessible** — the toggle is a real focusable checkbox, and <kbd>Space</kbd> flips it (the styled slider doesn't do that on its own)
- **Running-state indicator** — a short bar at the top of each card lengthens and turns sage-green while the service is running; the scrollbar is a low-contrast, borderless ink-grey strip that reserves its gutter so the grid never jumps
- **Busy guard** — while a start / stop is running, further clicks on the same card are ignored, so state can't desynchronise
- **Periodic state refresh** — every 5 seconds each card re-reads the real state; cards being toggled or already removed are skipped, an in-flight guard prevents overlapping refreshes, and refresh never writes to disk

### Adding and deleting

- **Modal form** — label + service name, with an empty-value check; clicking the backdrop closes it
- **Edit mode gates add/delete** — the `+` card and × buttons appear only after clicking 编辑; no hover delay
- **Confirmation dialog** — an in-page dialog (not a blocking native `confirm`) asks for the label first, then removes the card and persists the list
- **Non-blocking feedback** — errors surface as an auto-dismissing toast instead of `alert`, so the 5-second refresh timer is never stalled

### Storage

- **Rust-side JSON file** — `app_data_dir()/services.json`, an array of `{ domName, serviceName }`; the toggle state is never persisted, it is always read back from SCM
- **Atomic write** — every save writes a unique temp file, `sync_all`s it and renames it into place, so concurrent saves can't collide and a crash can't leave a half-written list
- **One-time migration** — an existing v0.2.x IndexedDB list is imported and the old database dropped
- **Corrupt config is preserved** — if the JSON can't be parsed, Rust renames it to `services.json.bad-<timestamp>` and reports the error; no placeholder list is ever written over it
- **Export / import** — download a JSON backup or upload one; import checks structure, field types / lengths, legal service names, duplicates, entry count and file size before saving

## FAQ

<details>
<summary><strong>Why does the app ask for elevation every time?</strong></summary>

`StartServiceW` and `ControlService` require administrator rights. The app reads its own token at startup and, if it isn't elevated, relaunches itself with the Windows `runas` verb. That relaunch always triggers a UAC prompt; there is no way for a normal process to elevate without one. The check happens once; if the UAC prompt is declined, the **以管理员重启** button in the title bar lets you retry without restarting the app.

</details>

<details>
<summary><strong>I entered a display name and the switch does nothing.</strong></summary>

The app passes the string to `OpenServiceW`, which expects the _service name_. For "MySQL 8.4" the service name is usually `MySQL84`. Find it under the service's properties in `services.msc`, or run `sc query state= all` and read the `SERVICE_NAME` lines.

</details>

<details>
<summary><strong>A service shows as off but it is running.</strong></summary>

State is re-read every 5 seconds, so a service started outside the app catches up within one interval. Cards currently being toggled are skipped to avoid clobbering an in-flight command.

</details>

<details>
<summary><strong>Where are my cards stored?</strong></summary>

In `services.json` under the app's data directory — `%APPDATA%\com.makabakax.service-settings\services.json` for a packaged build. Use **Export** to keep a backup; deleting the file leaves an empty list with an inline hint.

</details>

<details>
<summary><strong>What if services.json is corrupt?</strong></summary>

The app won't overwrite it with placeholder data. Rust renames the bad file to `services.json.bad-<timestamp>` in the same directory and shows a toast with the backup name. Import a JSON backup (or re-add the services); the original file is kept for recovery.

</details>

<details>
<summary><strong>I upgraded from v0.1.x and my cards are gone.</strong></summary>

v0.1.x was an Electron app whose Chromium profile is not the WebView2 profile used here, and its list was never stored in `services.json`. Add the services again once (or import a JSON backup). Upgrading from **v0.2.x** is different: its IndexedDB list is migrated to `services.json` automatically on first launch.

</details>

<details>
<summary><strong>How do I back up or move my list?</strong></summary>

Click **导出配置 / Export** in the title bar to download `service-settings.json`. On the target machine click **导入配置 / Import**, pick that file, and the page reloads with the imported list. Import rejects malformed JSON, illegal or over-long service names, empty / over-long labels, duplicates and oversized files.

</details>

<details>
<summary><strong>How do updates work?</strong></summary>

The title-bar **检查更新** button asks the GitHub Releases API for the latest release. If the API is rate-limited or unavailable, the app reads the tag from the plain `releases/latest` redirect and the asset name plus `sha256:` digest from the release's asset HTML, then uses direct `github.com` download URLs. The installer is always checked against its SHA256 digest, required to start with the `MZ` header and capped at 512 MB before it is launched silently (`/S /UPDATE /R`). Start-up checks are throttled to once every 6 hours.

</details>

<details>
<summary><strong>Does it work on macOS or Linux?</strong></summary>

No. This build ships a Windows NSIS installer only, and the command layer is Windows-specific. On other platforms the service command returns an explicit "unsupported platform" error instead of trying to call Win32 SCM.

</details>

## Contributing

```bash
npm run format   # prettier --write .
npm run lint     # eslint --cache .
npm run build    # vite build
cargo test --manifest-path src-tauri/Cargo.toml
```

**Tech stack**: Tauri 2 · Vite 7 · Rust (windows, reqwest, sha2, semver, serde) · plain ES modules + DOM (no framework) · JSON config · prettier + eslint

## License

No license file is included in this repository yet — copyright © 2026 makabakax, all rights reserved. Open an issue if you need explicit permission to reuse it.
