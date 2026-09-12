# 🎄 Christmas Theme

An open-source, free, cross-platform (macOS + Windows) desktop app that decorates your
computer for Christmas: an animated snow overlay, optional Dock/taskbar decorations, and
optional ambient sound — built on a configurable JSON theme engine instead of a single
hardcoded look.

No telemetry, no network access required, no paid "screensaver" nonsense.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design rationale
(why Tauri over Electron, how Dock/taskbar decoration works per OS, and why the
snow overlay isn't a security risk).

## Features (V1)

- **Snow overlay**: transparent, borderless, always-on-top window with animated,
  density-configurable falling snow and optional accumulation at the bottom of the screen.
- **Dock/taskbar decoration**:
  - Windows: a layered, click-through window positioned over the taskbar (`Shell_TrayWnd`).
  - macOS: experimental, opt-in, requires Accessibility permission — see
    [Known limitations](#known-limitations).
- **JSON theme system**: versioned schema (`themes/*.json`) covering colors, snow density,
  ambient sound, and which decorations are active. Reusable for future seasonal themes.
- **Ambient sound**: optional fireplace crackle / sleigh bells, volume-controlled, muted by default volume choice per theme.
- **Settings window**: theme picker, snow density slider, dock/taskbar toggle, volume
  slider, autostart toggle, and a "disable everything" button that removes all
  persisted state.

## Architecture at a glance

- **Tauri v2** (Rust core + OS webview), not Electron — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#1-framework-choice-tauri-not-electron)
  for the size/RAM/native-API comparison that drove this.
- Two windows: a small **settings** window and a full-screen transparent **overlay**
  window for snow.
- The settings and overlay UIs (`src/settings`, `src/overlay`) are plain HTML/CSS/JS with
  no Tauri-only calls in their render path (all OS calls go through `src/shared/bridge.js`,
  which falls back to `localStorage` when not running inside Tauri). This is what makes
  them testable with Playwright as ordinary web pages.

## Project layout

```
src-tauri/        Rust core: window management, theme loader, settings persistence,
                  platform-specific dock/taskbar decoration, ambient audio
src/settings/     Settings window UI
src/overlay/      Snow overlay canvas renderer
src/shared/       bridge.js — IPC-or-localStorage abstraction shared by both UIs
themes/           Built-in theme JSON files (classic-red, frosty-blue, minimal-white)
scripts/          dev-server.js — static file server used by Playwright + Tauri dev
tests/            Playwright test suite
docs/             Architecture notes
```

## Requirements

- Node.js 18+
- Rust toolchain (`rustup`) with `cargo`
- Tauri v2 platform prerequisites — **required even for `cargo check`**:
  - **Linux (dev only, not a target platform)**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
    `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`. Without these,
    `cargo check`/`cargo build` fails looking for `gdk-3.0` via pkg-config.
  - **macOS**: Xcode Command Line Tools.
  - **Windows**: Microsoft C++ Build Tools + WebView2 (preinstalled on Windows 11 and most
    Windows 10 updates).
  - Full list: https://tauri.app/start/prerequisites/

## Development

```bash
npm install
npm run dev        # tauri dev — launches the real app (settings + overlay windows)
```

Run just the UI in a browser (no Tauri, no Rust build) for quick iteration:

```bash
npm run serve:ui    # http://localhost:4173  (settings at /, overlay at /overlay)
```

## Building

```bash
npm run build       # produces platform installers via `tauri build`
                     # (.dmg on macOS, .msi/.exe via nsis on Windows)
```

Build for the platform you're running on; cross-compiling installers (e.g. producing a
`.dmg` from Linux) is not supported by Tauri and isn't attempted here.

## Testing

Automated visual + interaction tests run against the settings and overlay UIs via
Playwright, served by the plain static server in `scripts/dev-server.js` (no Tauri/Rust
build required):

```bash
npx playwright install chromium   # one-time browser download
npm test                          # runs tests/*.spec.js
npm run test:update-baselines     # regenerate screenshot baselines after an
                                   # intentional visual change
```

Test files:
- `tests/settings.spec.js` — control interaction (theme select, sliders, toggles, disable button).
- `tests/visual-regression.spec.js` — screenshot baselines for the settings window across
  theme/density states (`tests/screenshots/`).
- `tests/overlay.spec.js` — the snow canvas renderer in isolation (particle count, density
  changes, that it actually draws pixels).

### Why the full overlay window isn't in the automated suite

The production snow overlay is a native, transparent, always-on-top, click-through OS
window created by Tauri. Playwright drives a browser page, not an arbitrary native OS
window, so it cannot assert on those OS-level properties (always-on-top ordering,
click-through, spanning multiple monitors). What's covered instead: `src/overlay/snow.js`
has no Tauri-only calls, so it's served standalone and tested for actual rendering
behavior (particle count, live density changes, that pixels are actually drawn). The
native-window properties are verified manually per-OS — see the checklist below.

**Manual QA checklist (per OS, before each release):**
- [ ] Overlay spans the full virtual desktop across multiple monitors.
- [ ] Overlay stays on top of other windows and doesn't intercept clicks.
- [ ] Overlay survives display sleep/wake and resolution changes.
- [ ] Windows taskbar decoration tracks taskbar position after moving/resizing it.
- [ ] macOS Dock decoration (if enabled) behaves reasonably after Dock resize/auto-hide,
      and the Accessibility permission prompt is clear.

### Note on this repository's own CI/sandbox environment

This scaffold was built and code-reviewed in a sandboxed container without outbound
access to `cdn.playwright.dev` (browser binary download) or the Linux GTK/webkit2gtk
system packages Tauri needs for `cargo check`/`cargo build`. Both are ordinary
environment prerequisites, not code issues — install them locally (see Requirements
above and run `npx playwright install`) to build and run the full test suite.

## App icons

No app icon is committed yet (`src-tauri/tauri.conf.json` has no `bundle.icon` entry, so
`tauri build` uses Tauri's default icon). Add real icons with `tauri icon path/to/1024.png`
before shipping a release build, then add the generated `icons/` paths back into
`bundle.icon` in `tauri.conf.json`.

## Known limitations

- **macOS Dock decoration is experimental and opt-in.** There's no public, stable macOS
  API for the Dock's exact screen position — only the Accessibility API, which requires
  the user to grant Accessibility permission and can lag behind Dock
  resize/move/auto-hide since we poll rather than subscribe to a change notification.
  See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#4-docktaskbar-decoration--feasibility)
  for details and the V2 plan (subscribing to `NSWorkspace` notifications instead of polling).
- Windows taskbar decoration is implemented via `Shell_TrayWnd` lookup; if a future Windows
  version renames this window class, decoration silently fails to attach (falls back to no
  decoration rather than crashing).

## Contributing

Issues and PRs welcome. Please:
1. Keep new theme JSON files under `themes/`, following the existing schema
   (`schemaVersion: 1`).
2. Run `npm test` before submitting UI changes, and update screenshot baselines
   intentionally (`npm run test:update-baselines`) with an explanation in the PR.
3. Keep `src/settings` and `src/overlay` free of Tauri-only APIs outside
   `src/shared/bridge.js`, so they stay Playwright-testable as plain web pages.

## License

MIT — see [`LICENSE`](LICENSE).
