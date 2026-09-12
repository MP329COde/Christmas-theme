# Architecture

## 1. Framework choice: Tauri (not Electron)

| Criterion | Tauri | Electron |
|---|---|---|
| Bundle size | ~3-10 MB (uses OS webview) | ~80-150 MB (ships Chromium+Node) |
| Idle RAM | ~30-60 MB per window | ~150-300 MB per window |
| Native OS API access (accessibility, window layering) | Direct via Rust (`windows`, `objc2`/`cocoa` crates) | Requires native Node addons (n-api), more friction |
| Auto-start, tray, multi-window | Built-in plugins | Built-in via userland packages |
| Security model | Explicit capability/permission allowlist per window | Node integration is opt-out, larger attack surface by default |
| Maturity for this use case | Good enough (v2, stable) | Mature, huge ecosystem |

**Decision: Tauri v2.** The app is mostly idle (rendering a snow canvas + a small settings form), so Electron's overhead is wasted weight for an app whose entire pitch is "modern and light." Tauri also gives us a real Rust layer to talk to Win32 (`SetWindowLong`, `WS_EX_LAYERED`/`WS_EX_TRANSPARENT`) and macOS Accessibility/Cocoa APIs for the dock/taskbar decoration, without embedding Node. The webview is only used for the two UI surfaces (snow canvas, settings), not for OS integration logic.

Trade-off accepted: Tauri's cross-platform native code (dock/taskbar hooks) has to be written twice (Rust `cfg(target_os)` blocks), same as Electron would require anyway — no framework hides that difference, since it's genuinely OS-specific.

## 2. Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Tauri Rust core                       │
│  - App bootstrap, tray icon, autostart plugin                │
│  - Theme loader (reads themes/*.json, validates schema)      │
│  - Window manager:                                            │
│      • Settings window  (normal window)                       │
│      • Snow overlay window (transparent, click-through,       │
│        always-on-top, spans full virtual desktop)              │
│  - Platform decoration module (cfg(target_os)):                │
│      • macOS: AXUIElement accessibility calls to inspect Dock  │
│        frame, position an auxiliary transparent NSWindow with  │
│        garland/lights around it                                 │
│      • Windows: FindWindow("Shell_TrayWnd") to get taskbar rect,│
│        position a WS_EX_LAYERED|WS_EX_TRANSPARENT window there  │
│  - Audio: rodio-based ambient sound player (fire crackle,       │
│    sleigh bells), volume from settings                          │
│  - IPC commands exposed to the webviews via #[tauri::command]  │
└─────────────────────────────────────────────────────────────┘
              │                                   │
              ▼                                   ▼
   ┌────────────────────┐            ┌─────────────────────────┐
   │ Settings webview    │            │ Overlay webview(s)       │
   │ (src/settings)      │            │ (src/overlay, decor)     │
   │ - theme picker       │            │ - Canvas snow renderer    │
   │ - snow density slider│            │ - reads theme via IPC     │
   │ - dock/taskbar toggle│            │ - requestAnimationFrame,  │
   │ - volume slider       │            │   capped particle count   │
   │ - autostart toggle    │            └─────────────────────────┘
   │ - "disable everything"│
   └────────────────────┘
```

## 3. Theme system

`themes/*.json`, versioned schema:

```json
{
  "schemaVersion": 1,
  "id": "classic-red",
  "name": "Classic Red & Green",
  "colors": { "primary": "#c0392b", "secondary": "#1e7d32", "accent": "#f1c40f" },
  "snow": { "density": 120, "accumulate": true, "wind": 0.3 },
  "sound": { "ambient": "fireplace.mp3", "volume": 0.4 },
  "decorations": { "dock": true, "taskbar": true }
}
```

The Rust core validates `schemaVersion` and required fields on load and rejects/falls back to a built-in default theme on error, so a malformed community-contributed theme can't crash the app.

## 4. Dock/taskbar decoration — feasibility

- **Windows**: straightforward. `FindWindowW("Shell_TrayWnd", None)` gives the taskbar HWND; `GetWindowRect` gives its screen rect. We create a borderless, `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST` window sized/positioned to overlay it, and draw garlands/lights in its webview. `WS_EX_TRANSPARENT` makes it click-through so the real taskbar still receives clicks.
- **macOS**: harder and more fragile, same constraint Festivitas hits. There is no public, stable API to get the Dock's exact frame — it must be inferred via the Accessibility API (`AXUIElementCopyAttributeValue` on the Dock process for `kAXPositionAttribute`/`kAXSizeAttribute`), which:
  - Requires the user to grant **Accessibility permission** (System Settings → Privacy & Security), a real permission prompt we cannot avoid if we want this feature.
  - Can shift when the Dock is resized, auto-hidden, or moved to a screen edge — we poll on an interval and reposition the decoration window, which is not instant and can visibly lag.
  - Apple could tighten or break this at any OS update, as it's an accessibility API used off-label.

  **V1 decision**: ship the Windows taskbar decoration (lower risk, no special permission). Ship the macOS Dock decoration as an **opt-in, clearly-labeled "experimental" feature** behind a settings toggle that explains the Accessibility permission requirement before enabling it. Document known fragility in the README. A V2 could explore `NSWorkspace` notifications for Dock resize instead of polling.

## 5. Testing strategy

Tauri's overlay/settings windows are native OS windows, not something Playwright can attach to directly (no CDP endpoint by default, no DOM outside the webview accessible from outside the app). So:

- The **settings UI** (`src/settings`) is plain HTML/CSS/JS with no Tauri-only APIs in its render path — Tauri IPC calls are isolated behind a small `bridge.js` that no-ops (using `localStorage`) when `window.__TAURI__` is undefined. This lets us serve `src/settings` with a plain static dev server and drive it with Playwright exactly like a normal web page.
- The **snow overlay** (`src/overlay`) is a `<canvas>` renderer with no Tauri-only calls either, so it's also servable standalone and testable for "does it render particles, does density changes take effect" — but we cannot use Playwright to verify OS-level properties (always-on-top, click-through, spanning multiple monitors) since those only exist once Tauri creates the real native window. That part is manually verified per-OS and documented as a manual QA checklist, not an automated test.
