<div align="center">

<img src="docs/logo.png" width="120" alt="Service Settings logo">

# Service Settings

### A one-page switchboard for the Windows services you actually care about

**Add a service once, then start and stop it with one switch instead of hunting through `services.msc` — and see its real state every time the window opens.**

[![Electron](https://img.shields.io/badge/Electron-38-47848F.svg)](https://www.electronjs.org/)
[![electron-vite](https://img.shields.io/badge/built%20with-electron--vite%204-orange.svg)](https://electron-vite.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#requirements)
[![License](https://img.shields.io/badge/license-not%20set-lightgrey.svg)](#license)

English | [中文](README_ZH.md)

**[Quick Start](#quick-start) · [Features](#features) · [FAQ](#faq)**

</div>

## Why Service Settings?

`services.msc` is designed for administrators, not for the two or three services a developer restarts all day: it takes a UAC prompt, a scroll through an alphabetical list, and a right-click → Start / Stop → wait → close. This app reduces that to a card with a switch.

- **One card per service** — the name you gave it, and a toggle that runs `net start` / `net stop`
- **State read from the real service** — on launch every card is refreshed with `sc query`, so a service stopped elsewhere doesn't show as running
- **Elevation handled once** — the app checks for administrator rights at startup and relaunches itself through the UAC prompt if it doesn't have them
- **The list survives restarts** — cards are stored in IndexedDB and read back on the next launch
- **Deletion is deliberate** — the × button only appears after hovering the card for 5 seconds, so a stray cursor can't remove a service

## Requirements

- **Node.js**: `^20.19.0 || >=22.12.0` (required by Vite 7)
- **Windows** with administrator rights — `net start` / `net stop` / `sc query` are Windows commands
- **Service names, not display names** — the app passes the value to `sc query`, which expects the _service name_ (e.g. `MySQL84`), not the display name shown in `services.msc`

## Quick Start

```bash
npm install
npm run dev
```

Build a production bundle or an installer:

```bash
npm run build          # bundles main / preload / renderer into out/
npm run build:win      # installer for Windows
npm run build:mac      # app bundle for macOS
npm run build:linux    # AppImage / snap / deb
```

> On first launch Windows asks for elevation. If you decline, the window opens but every command fails with a permission message — restart the app and accept the prompt.

## Usage

1. **Add** — click the `+` card, enter a label (what the card will show) and the Windows service name, then confirm.
2. **Toggle** — click the switch, or focus it and press <kbd>Space</kbd>. The switch moves only after the command returns, and further clicks are ignored while one is in flight.
3. **Delete** — rest the cursor on a card for 5 seconds; an `×` appears in the corner. Click it and confirm.

The starting list, when the database has no record yet, is a single `mysql` card pointing at the service `MySQL84` — edit or delete it as you like.

## How it works

| Layer        | File                         | Responsibility                                                                                                        |
| ------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Main process | `src/main/index.js`          | Elevation check (`fltmc`), self-relaunch via `Start-Process -Verb RunAs`, and executing commands through `cmd.exe /c` |
| Preload      | `src/preload/index.js`       | Exposes exactly one call to the page: `window.api.run(command)` → IPC `run-cmd-as-admin`                              |
| Renderer     | `src/renderer/src/switch.js` | Renders cards, debounces toggles (500 ms), reads state with `sc query`                                                |
| Renderer     | `src/renderer/src/delete.js` | Hover-to-reveal delete icon and confirm-then-remove                                                                   |
| Renderer     | `src/renderer/src/store.js`  | IndexedDB `TestDB` → `config`, single record with id `1`                                                              |

A service counts as running when `sc query <name>` output contains `4  RUNNING`. The four-digit state code is matched rather than the word alone, because `STOP_PENDING` and `START_PENDING` also contain letters that a looser check would misread.

## Features

### Service cards

- **Per-card switch** — custom-drawn toggle (a checkbox with styled slider); its `checked` state mirrors the service state, not the last click
- **Keyboard accessible** — the toggle is a real focusable checkbox, and <kbd>Space</kbd> flips it (the styled slider doesn't do that on its own)
- **Busy guard** — while a `net start` / `net stop` is running, further clicks on the same card are ignored, so state can't desynchronise
- **State refresh on launch** — each card's status is queried after the list renders

### Adding and deleting

- **Modal form** — label + service name, with an empty-value check; clicking the backdrop closes it
- **Hover delay before delete** — 5000 ms of continuous hover reveals `×`, leaving the card hides it again
- **Confirmation dialog** — deletion asks for the label first, then removes the card and persists the list

### Storage

- **IndexedDB only** — database `TestDB`, object store `config`, keyPath `id`, one record with id `1`
- **`put` instead of `add`** — the record already exists on every save after the first, and `add` would throw `ConstraintError`
- **No fallback data written to disk** — the default `mysql` card is only a first-run stand-in and is not persisted until you add or delete something

## FAQ

<details>
<summary><strong>Why does the app ask for elevation every time?</strong></summary>

`net start` and `net stop` require administrator rights, so the app checks with `fltmc` at startup and, if the check fails, relaunches itself via PowerShell's `Start-Process -Verb RunAs`. That relaunch always triggers a UAC prompt; there is no way for a normal process to elevate without one.

</details>

<details>
<summary><strong>I entered a display name and the switch does nothing.</strong></summary>

The app passes the string straight to `sc query` / `net start`, which expect the _service name_. For "MySQL 8.4" the service name is usually `MySQL84`. Find it under the service's properties in `services.msc`, or run `sc query state= all` and read the `SERVICE_NAME` lines.

</details>

<details>
<summary><strong>A service shows as off but it is running.</strong></summary>

Status is read once at launch and again only via toggles, so a service started outside the app keeps its old card state until you restart the app. Toggling it once re-reads the real state.

</details>

<details>
<summary><strong>Where are my cards stored?</strong></summary>

In IndexedDB inside the app's user-data folder — `%APPDATA%\service-settings` in a packaged build, and the Chromium profile directory of the Electron instance during `npm run dev`. Clearing site data or the folder resets the list.

</details>

<details>
<summary><strong>Does it work on macOS or Linux?</strong></summary>

It builds and starts, but the commands it runs are Windows-only: on macOS and Linux the elevation dialog says so, and `net start` / `sc query` don't exist. It is a Windows tool.

</details>

## Contributing

```bash
npm run format   # prettier --write .
npm run lint     # eslint --cache .
npm run build    # electron-vite build
```

**Tech stack**: Electron 38 · electron-vite 4 · Vite 7 · plain ES modules + DOM (no framework) · IndexedDB · prettier + eslint

## License

No license file is included in this repository yet — copyright © 2026 makabakax, all rights reserved. Open an issue if you need explicit permission to reuse it.
