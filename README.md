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
- **Elevation handled once** — the app checks its token at startup and relaunches itself with the Windows `runas` verb if it isn't elevated
- **The list survives restarts** — cards are stored in a JSON file managed by the Rust backend
- **Back up and move your list** — export / import the configuration as a JSON file
- **Deletion is deliberate** — the × button only appears after hovering the card for 5 seconds, so a stray cursor can't remove a service

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

> On first launch Windows asks for elevation. If you decline, the window still opens but every start/stop fails with a permission message — restart the app and accept the prompt.

## Usage

1. **Add** — click the `+` card, enter a label (what the card will show) and the Windows service name, then confirm.
2. **Toggle** — click the switch, or focus it and press <kbd>Space</kbd> / <kbd>Enter</kbd>. The switch springs back if the command fails, and further clicks are ignored while one is in flight.
3. **Delete** — rest the cursor on a card for 5 seconds; an `×` appears in the corner. Click it and confirm.
4. **Export / import** — use the two buttons at the bottom of the window. Export downloads `service-settings.json`; import validates the file and reloads the page.

The starting list, when there is no configuration yet, is a single `mysql` card pointing at the service `MySQL84` — edit or delete it as you like.

## How it works

| Layer           | File                         | Responsibility                                                                                                                                                                                                                            |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust commands   | `src-tauri/src/lib.rs`       | Validates `action` / `name`, calls Win32 SCM (`OpenSCManagerW` / `OpenServiceW` / `QueryServiceStatusEx` / `StartServiceW` / `ControlService`), maps Win32 error codes, checks elevation via `TokenElevation` and relaunches with `runas` |
| Rust storage    | `src-tauri/src/lib.rs`       | `load_services` / `save_services` read and atomically write `app_data_dir()/services.json`                                                                                                                                                |
| Frontend bridge | `src/renderer/src/api.js`    | The single service call to the backend: `invoke('service_command', { action, name })`                                                                                                                                                     |
| Renderer        | `src/renderer/src/switch.js` | Renders cards, debounces toggles (500 ms), refreshes state every 5 s                                                                                                                                                                      |
| Renderer        | `src/renderer/src/config.js` | Export / import the configuration as JSON                                                                                                                                                                                                 |
| Renderer        | `src/renderer/src/delete.js` | Hover-to-reveal delete icon and confirm-then-remove                                                                                                                                                                                       |
| Renderer        | `src/renderer/src/store.js`  | Load / save the list, with a one-time migration from the old IndexedDB store                                                                                                                                                              |

The service name whitelist is enforced **in Rust**, not in the page: a Tauri frontend can call `invoke` directly, so the renderer's `SERVICE_NAME_PATTERN` is only an input hint. Both sides must stay in sync (see `src/shared/services.js`).

A service counts as running when SCM reports `dwCurrentState == SERVICE_RUNNING` (4). No `sc query` text is parsed, so `STOP_PENDING` / `START_PENDING` can't be misread and there is no console encoding to decode. Win32 error codes are mapped to readable Chinese messages; anything else falls back to the system's localized `FormatMessageW` text.

## Features

### Service cards

- **Per-card switch** — custom-drawn toggle (a checkbox with styled slider); its `checked` state mirrors the service state, not the last click
- **Keyboard accessible** — the toggle is a real focusable checkbox, and <kbd>Space</kbd> flips it (the styled slider doesn't do that on its own)
- **Busy guard** — while a start / stop is running, further clicks on the same card are ignored, so state can't desynchronise
- **Periodic state refresh** — every 5 seconds each card re-reads the real state; cards being toggled or already removed are skipped, and refresh never writes to disk

### Adding and deleting

- **Modal form** — label + service name, with an empty-value check; clicking the backdrop closes it
- **Hover delay before delete** — 5000 ms of continuous hover reveals `×`, leaving the card hides it again
- **Confirmation dialog** — deletion asks for the label first, then removes the card and persists the list

### Storage

- **Rust-side JSON file** — `app_data_dir()/services.json`, an array of `{ domName, serviceName, status }`; `isChanging` is runtime-only and never persisted
- **Atomic write** — the file is written to `services.json.tmp` and renamed into place, so a crash can't leave a half-written list
- **One-time migration** — an existing v0.2.x IndexedDB list is imported and the old database dropped
- **No fallback data written to disk** — the default `mysql` card is only a first-run stand-in
- **Export / import** — download a JSON backup or upload one; import checks the structure, legal service names and duplicates before saving

## FAQ

<details>
<summary><strong>Why does the app ask for elevation every time?</strong></summary>

`StartServiceW` and `ControlService` require administrator rights. The app reads its own token at startup and, if it isn't elevated, relaunches itself with the Windows `runas` verb. That relaunch always triggers a UAC prompt; there is no way for a normal process to elevate without one. The check happens once and the UAC prompt is raised at most once per run.

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

In `services.json` under the app's data directory — `%APPDATA%\com.makabakax.service-settings\services.json` for a packaged build. Use **Export** to keep a backup; deleting the file resets the list to the first-run placeholder.

</details>

<details>
<summary><strong>I upgraded from v0.1.x and my cards are gone.</strong></summary>

v0.1.x was an Electron app whose Chromium profile is not the WebView2 profile used here, and its list was never stored in `services.json`. Add the services again once (or import a JSON backup). Upgrading from **v0.2.x** is different: its IndexedDB list is migrated to `services.json` automatically on first launch.

</details>

<details>
<summary><strong>How do I back up or move my list?</strong></summary>

Click **导出配置 / Export** at the bottom of the window to download `service-settings.json`. On the target machine click **导入配置 / Import**, pick that file, and the page reloads with the imported list. Import rejects malformed JSON, illegal service names and duplicate entries.

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

**Tech stack**: Tauri 2 · Vite 7 · Rust (windows, serde) · plain ES modules + DOM (no framework) · JSON config · prettier + eslint

## License

No license file is included in this repository yet — copyright © 2026 makabakax, all rights reserved. Open an issue if you need explicit permission to reuse it.
