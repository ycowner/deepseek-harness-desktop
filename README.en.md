# DSH Desktop

> An unofficial Electron desktop client for DeepSeek Harness — by 零物实验室 (Lingwu Lab)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node.js-22.19.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows&logoColor=white)](#system-requirements)
[![DSH](https://img.shields.io/badge/DSH-@deepseek--ai/dsh-blue)](https://github.com/deepseek-ai/deepseek-harness)

[English](./README.en.md) | [简体中文](./README.md)

---

## About

**DSH Desktop** is a **third-party, unofficial** desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (a.k.a. DSH, an open-source AI agent framework by DeepSeek AI). It wraps DSH's Web UI (default `http://127.0.0.1:3080`) in a standalone Windows Electron app, so end users do not need to install Node.js or the DSH CLI manually.

> ⚠️ **Disclaimer**: This project is maintained by 零物实验室 (Lingwu Lab). It is **not** affiliated with, sponsored by, or endorsed by DeepSeek AI. DSH itself — its features, versions, and license — is governed by the [upstream repository](https://github.com/deepseek-ai/deepseek-harness). This desktop client is released under the MIT License.

### Goals

- **Zero-dependency, works out of the box**: bundles Node.js v22.19.0 and a pre-installed `@deepseek-ai/dsh`, so the app runs **fully offline** after installation.
- **Self-healing install**: if the bundled DSH package is corrupted or missing, the error page exposes a one-click **"Online Repair"** that re-downloads it from the npm registry.
- **Process lifecycle management**: spawns the DSH child process, performs health checks, handles port conflicts, and tears down the whole process tree on exit.
- **Better desktop UX**: custom `loading.html` / `error.html` pages, real-time IPC status push, external links opened in the system browser.

---

## Screenshots

<!-- TODO: Loading screen -->
![Loading](./docs/screenshots/loading.png)

<!-- TODO: DSH Web main UI (after launch) -->
![Main](./docs/screenshots/main.png)

<!-- TODO: Error page with the Online Repair button -->
![Error](./docs/screenshots/error.png)

---

## Technical Features

| Area | Details |
| --- | --- |
| **Runtime isolation** | Bundles Node.js v22.19.0 (win-x64). No dependency on the system's global Node — avoids version and `PATH` conflicts. |
| **First-launch offline** | Pre-bundles the DSH package into `resources/dsh-bundled/`, so **no network download is required** on first launch. |
| **Process management** | Parses the DSH service URL from stdout/stderr via regex, polls a health check every 500 ms, and fails fast on a 60 s timeout. |
| **Port handling** | Defaults to 3080. If taken, first checks whether an existing DSH is already running (reuse), otherwise increments to the next free port (up to 20 retries). |
| **Process teardown** | On Windows, uses `taskkill /f /t` to kill the whole process tree, so any npx-spawned children are cleaned up when the app exits. |
| **Online repair** | When the DSH package is corrupted, uses the bundled `node.exe` to `https`-GET the package tarball directly from the npm registry, then calls the system `tar.exe` (under `System32`) to extract it into the user's writable directory (`%LOCALAPPDATA%/DSH Desktop/dsh-cache/`). |
| **Cache isolation** | Runtime npm cache is written to `%LOCALAPPDATA%/DSH Desktop/npm-cache/`, sidestepping read-only issues under `Program Files`. |
| **Loading UX** | Custom `loading.html` (CSS spinner + status text) and `error.html` (error details + Retry / Online Repair buttons). Status updates flow over the IPC `status` channel. |
| **Security baseline** | Renderer runs with `contextIsolation: true` and `nodeIntegration: false`. A preload script exposes a narrow, audited API surface. |
| **CSP** | Both loading and error pages declare a `Content-Security-Policy` that blocks foreign-domain scripts and styles. |
| **Packaging** | `electron-builder` NSIS installer, `perMachine`, with `requestedExecutionLevel: requireAdministrator` to fix EPERM when DSH creates symlinks. |
| **Size optimization** | `extraResources` filters exclude `node_modules/**`, `.d.ts`, `docs/`, `.md`, etc. — only `node.exe` is shipped. |

---

## System Requirements

| Item | Requirement |
| --- | --- |
| OS | Windows 10 / 11 (x64) |
| Privileges | Administrator (DSH creates symlinks internally and requires `requireAdministrator`) |
| Ports | 3080 by default; auto-increments if taken |
| Disk | ~200 MB (bundled Node.js + DSH package) |
| Memory | ≥ 512 MB free |
| Network | Only required for: ① online DSH repair ② DSH itself calling the DeepSeek API |

> Only Windows x64 is currently shipped. The macOS / Linux teardown logic in `dsh-manager` is already written; you only need to add the relevant `electron-builder` targets.

---

## End-User Installation

Download the NSIS installer → right-click → **Run as administrator** → choose install directory → finish.

On launch, DSH Desktop will automatically:

1. Verify the bundled Node.js and DSH package
2. Start the DSH service (default `http://127.0.0.1:3080`)
3. Load the Web UI once the service is ready

If the DSH package is corrupted, an error page appears with an **"Online Repair"** button.

---

## Development

### Prerequisites

- Node.js ≥ 18 (only for running electron-vite and the build itself)
- npm ≥ 9
- Windows 10/11 x64 (build target is win-x64)
- PowerShell (for running `pnpm` / `npm`)

### Clone and install

```powershell
git clone https://github.com/ycowner/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install
```

The `postinstall` hook automatically calls `scripts/download-node.js` to download Node.js v22.19.0 (~30 MB) into `resources/node/`. The script prefers the China mirror and falls back to `nodejs.org`. To force a re-download:

```powershell
npm run download-node -- --force
```

### Run in dev mode

```powershell
npm run dev
```

`electron-vite` will:

- Start a Vite dev server for the renderer
- Watch `src/main` / `src/preload` / `src/renderer` and hot-reload
- Spawn Electron, load the loading page, and launch DSH

> Note: dev mode also uses `resources/node/node.exe` and `resources/dsh-bundled/`. Make sure `npm install` has finished (which auto-downloads node). If the DSH package is missing, dev mode will trigger the "Online Repair" flow.

### Pre-install the DSH package (optional)

The `package` script does this automatically. To pre-warm `resources/dsh-bundled/` in dev:

```powershell
npm run preinstall-dsh
```

### Project layout

```
deepseek-harness-desktop/
├─ src/
│  ├─ main/              # Electron main process
│  │  ├─ index.ts        # App entry, window management, IPC handlers
│  │  ├─ dsh-manager.ts  # DSH child-process lifecycle (start / stop / restart / URL parse / port probe)
│  │  ├─ dsh-repair.ts   # Online repair: download tarball + system tar extraction
│  │  └─ node-binary.ts  # Bundled Node.js path resolution (dev / packaged)
│  ├─ preload/           # Renderer bridge
│  │  └─ index.ts
│  └─ renderer/          # Custom HTML pages
│     ├─ loading.html    # Startup loading (CSS spinner + status text)
│     ├─ error.html      # Error page (details + Retry / Online Repair)
│     └─ renderer.ts
├─ resources/            # Runtime resources (gitignored)
│  ├─ node/              # Bundled Node.js v22.19.0 (downloaded at build time)
│  └─ dsh-bundled/       # Pre-installed DSH package (downloaded at build time)
├─ build/                # electron-builder resources
│  ├─ icon.ico
│  └─ *.jpg              # App icon source files
├─ scripts/              # Build scripts
│  ├─ download-node.js       # Download bundled Node.js
│  ├─ preinstall-dsh.js      # Pre-install DSH into resources/dsh-bundled
│  ├─ generate-icon.js       # Generate icon.ico from source images
│  ├─ png-to-ico.ps1         # PowerShell icon conversion helper
│  └─ archive-dist-exe.js    # Archive dist-exe after packaging
├─ electron-builder.yml  # NSIS packaging config
├─ electron.vite.config.ts
├─ package.json
├─ tsconfig.json
├─ tsconfig.node.json
└─ README.md / README.en.md
```

---

## Build & Distribution

### Build the NSIS installer

```powershell
npm run package
```

The pipeline:

1. `scripts/download-node.js`: download Node.js into `resources/node/` if missing
2. `scripts/preinstall-dsh.js`: pre-install the DSH package into `resources/dsh-bundled/` if missing
3. `electron-vite build`: compile main / preload / renderer to `dist/`
4. `electron-builder`: produce an NSIS installer in `dist-exe/` per `electron-builder.yml`
5. `scripts/archive-dist-exe.js`: archive the `dist-exe` output

> **Note**: the build needs administrator privileges (`electron-builder` requests UAC to create symlinks). If you cannot elevate, temporarily set `requestedExecutionLevel: asInvoker` in `electron-builder.yml` and accept the runtime EPERM risk.

### Build without packaging

```powershell
npm run build   # Produce dist/ only
npm run start   # Preview dist/ with a local Electron
```

---

## IPC Channels

The main process (`src/main/index.ts`) exposes the following IPC channels:

| Channel | Direction | Trigger | Description |
| --- | --- | --- | --- |
| `status` | main → renderer | Each DSH startup phase | Status text (e.g. "Starting DSH service...", "Service started, waiting for ready (http://...)...") |
| `retry` | renderer → main | Error page "Retry" button | Stop the old DSH → reload loading page → relaunch |
| `repair-dsh` | renderer → main (invoke) | Error page "Online Repair" button | Download the DSH tarball and extract it; returns `{ success, cachePath \| error }` |
| `repair-progress` | main → renderer | Each repair phase | Progress text pushed to the error page |

---

## Runtime Directories

| Path | Purpose |
| --- | --- |
| `<install>/resources/node/` | Bundled Node.js (read-only) |
| `<install>/resources/dsh-bundled/` | Pre-installed DSH package (read-only) |
| `%LOCALAPPDATA%/DSH Desktop/npm-cache/` | Runtime npm cache (writable) |
| `%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/` | Online-repair DSH package (writable) |

DSH package lookup order (`dsh-manager.ts#findCachedDshEntry`):

1. `resources/dsh-bundled/` (pre-installed, read-only)
2. `%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/` (online-repair cache, writable)
3. npx cache fallback (dev only — `node_modules` is excluded after packaging)

---

## Troubleshooting

### "DSH package is missing or corrupted"

Click **"Online Repair"** on the error page. The tool will download the latest `@deepseek-ai/dsh` from the npm registry into `%LOCALAPPDATA%/DSH Desktop/dsh-cache/`, then click **"Retry"**.

### "No available port in range 3080–3300"

Run:

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

If a large port range is excluded by the system, close whatever is using it and retry, or tweak `DEFAULT_DSH_PORT` / `MAX_PORT_RETRIES` in `src/main/dsh-manager.ts`.

### "Bundled Node.js not found"

Usually caused by `resources/node/` being wiped. Re-run:

```powershell
npm run download-node
```

### DSH starts, but the UI loads slowly

First run may take tens of seconds while DSH loads plugins and JITs. Up to 60 s is normal; beyond that, a timeout fires and the error page is shown — just retry.

### DSH processes remain after closing the app

In theory, `taskkill /f /t` cleans up the whole tree on Windows. If something lingers:

```powershell
tasklist | findstr node
taskkill /pid <pid> /f /t
```

---

## Roadmap

- [ ] macOS / Linux packaging (currently win-x64 only)
- [ ] Auto-update via `electron-updater`
- [ ] Show the DSH service port in the main window title
- [ ] Localized UI (zh-CN / en)
- [ ] In-app DSH log viewer

---

## Contributing

PRs and issues are welcome. Before you start:

1. Sync with `main`
2. Run `npm run build` to confirm TypeScript is clean before touching `src/main`
3. Use Conventional Commits: `feat:` / `fix:` / `refactor:` / `docs:` / `chore:`

---

## License

This project is released under the [MIT](./LICENSE) License. © 零物实验室 (Lingwu Lab).

The bundled `@deepseek-ai/dsh` package follows its upstream license (see `THIRD_PARTY_NOTICES.md` if present).

---

## Acknowledgments

- [DeepSeek AI](https://deepseek.com/) — creators of the upstream DeepSeek Harness
- [Electron](https://www.electronjs.org/) / [Vite](https://vitejs.dev/) / [electron-vite](https://electron-vite.org/)
- All contributors

## Related Links

- Upstream DSH: <https://github.com/deepseek-ai/deepseek-harness>
- Upstream DSH (中文): <https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md>
- DSH project site: <https://www.deepseek.com/harness/>
- This repository: <https://github.com/ycowner/deepseek-harness-desktop>
- Team: 零物实验室 (Lingwu Lab)
