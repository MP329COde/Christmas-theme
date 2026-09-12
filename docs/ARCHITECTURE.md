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
│  - Theme loader (themes/*.json embedded via include_str!)    │
│  - Window manager:                                            │
│      • Settings window  (normal window)                       │
│      • One snow overlay window PER MONITOR (transparent,      │
│        click-through, always-on-BOTTOM so it behaves like a    │
│        live wallpaper and never covers other apps)             │
│  - Dock/taskbar decoration (decoration.rs):                     │
│      • Derives the shell strip from Monitor::work_area() —     │
│        one code path for the macOS Dock and the Windows        │
│        taskbar, no permission prompt, no private API           │
│      • Windows fallback: FindWindow("Shell_TrayWnd") for an    │
│        auto-hiding taskbar, which reserves no work area        │
│      • One transparent click-through strip window per monitor, │
│        repositioned by a 1.2 s poll                            │
│  - Audio: rodio-based ambient sound player (fire crackle,       │
│    sleigh bells), volume from settings                          │
│  - IPC commands exposed to the webviews via #[tauri::command]  │
└─────────────────────────────────────────────────────────────┘
              │                                   │
              ▼                                   ▼
   ┌────────────────────┐            ┌─────────────────────────┐
   │ Settings webview    │            │ Overlay webview(s)       │
   │ (src/settings)      │            │ (src/overlay)            │
   │ - theme picker       │            │ - snow.js  particles      │
   │ - snow / light / decor│           │ - decor.js trees, garland,│
   │   controls            │           │   fireplace               │
   │ - live fps readout    │           │ - lights.js aurora, stars,│
   │ - dock status line    │           │   icicles, glitter        │
   │ - "disable everything"│           └─────────────────────────┘
   └────────────────────┘                         │
                                       ┌─────────────────────────┐
                                       │ Dock webview(s)          │
                                       │ (src/dock)               │
                                       │ - strip garland + lights │
                                       │ - geometry over an event │
                                       └─────────────────────────┘
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

## 4. Dock/taskbar decoration — implemented

**The approach that works on both platforms: the monitor work area.**

The first design here (and the one the earlier scaffold in this repo was
written against) went after the Dock and the taskbar directly — `FindWindowW`
on Windows, the Accessibility API on macOS. Windows was fine; macOS was the
problem, because there is no public, stable API for the Dock's frame. Getting
one means `AXUIElementCopyAttributeValue` against the Dock process, which
demands an Accessibility permission prompt, is an accessibility API used
off-label, and can break at any OS update. That is why the feature sat
unimplemented.

The way out is that we do not actually need the Dock's window — we need the
*region of the screen it occupies*, and every desktop OS already publishes
that to every window manager as the **work area**: the part of a display
left over for ordinary windows once the shell's reserved bars are taken out.
Tauri exposes it as `Monitor::work_area()`.

```
monitor bounds  ──────────────────────────────┐
                │                              │
                │        work area             │   insets = monitor − work area
                │                              │
                ├──────────────────────────────┤ ← the strip we decorate
                │   Dock / taskbar             │
                └──────────────────────────────┘
```

Subtracting one rect from the other gives the strip directly, with:

- **no Accessibility permission** on macOS and no undocumented API,
- **one code path** for the macOS Dock and the Windows taskbar,
- correct results for a Dock on the left, right or bottom, a taskbar on any
  of the four edges, multiple monitors, mixed HiDPI scale factors, and the
  "smaller/larger Dock" size slider,
- automatic tracking of changes: re-running the subtraction is all it takes.

On macOS the menu bar also reserves work area at the top; the top inset is
therefore never treated as the Dock there.

**Windows fallback.** One case the work area cannot describe is an
*auto-hiding* taskbar, which reserves nothing. There we fall back to
`FindWindowW("Shell_TrayWnd")` + `GetWindowRect` and clamp the result onto
the monitor.

**Change detection.** Neither OS offers a dependable "the Dock moved"
notification, so `main.rs` polls every 1.2 s on the main thread and only
pushes geometry to a strip window when it actually differs from what that
window was last given. Windows are created once at startup on the main
thread; the poll only ever moves, shows and hides them, because creating a
window from a background thread is not safe on every platform while
position/size/visibility changes are proxied through the event loop.

### Known limitation (macOS) — reported, not worked around

On macOS the Dock is composited at a window level above ordinary floating
windows. A normal always-on-top window therefore **cannot** be drawn on top
of the Dock itself. The decoration is consequently hung over the strip's
*leading edge*: `OVERHANG` (26 px, scaled) of the strip window sits outside
the work area, on the desktop side of the bar, and that band carries the snow
ledge, the garland and the roots of the icicles. That part is always visible;
anything that would fall behind the Dock simply is not important to the
composition. On Windows the strip is covered directly and the whole bar is
decorated.

The other macOS case we do not silently swallow: with the Dock set to
auto-hide, no strip can be found at all. Rather than leaving a toggle that
appears to do nothing, `dock_status()` reports it and the settings window
prints the reason under the toggle.

### Not always-on-bottom, unlike the snow overlay

The snow overlay is deliberately `always_on_bottom` so it behaves like a live
wallpaper and never covers the app you are using. The dock strip has to be
`always_on_top` — decorating screen furniture means drawing over it. It is a
thin strip in a region no application window occupies, and it is
click-through (`set_ignore_cursor_events(true)`), so the real Dock and
taskbar keep receiving every click.

## 5. Testing strategy

Tauri's overlay/settings windows are native OS windows, not something Playwright can attach to directly (no CDP endpoint by default, no DOM outside the webview accessible from outside the app). So:

- The **settings UI** (`src/settings`) is plain HTML/CSS/JS with no Tauri-only APIs in its render path — Tauri IPC calls are isolated behind a small `bridge.js` that no-ops (using `localStorage`) when `window.__TAURI__` is undefined. This lets us serve `src/settings` with a plain static dev server and drive it with Playwright exactly like a normal web page.
- The **snow overlay** (`src/overlay`) is a `<canvas>` renderer with no Tauri-only calls either, so it's also servable standalone and testable for "does it render particles, does density changes take effect" — but we cannot use Playwright to verify OS-level properties (z-order, click-through, one window per monitor) since those only exist once Tauri creates the real native window. That part is manually verified per-OS and documented as a manual QA checklist, not an automated test.
- The **dock decoration** (`src/dock`) splits the same way, and the split is deliberate: *where* the strip is (`decoration.rs`, work-area subtraction) is native and untestable from Playwright; *what is drawn in it* is a canvas renderer driven by an explicit geometry contract — `{ edge, barThickness, scaleFactor }` — which arrives from Rust as a `dock-geometry` event in the app and from query parameters (`/dock/index.html?edge=left&thickness=64`) outside it. `tests/dock.spec.js` drives that renderer through all four edges. What Playwright cannot check is whether the strip lands on the real Dock, which is in the manual QA checklist.
- **Frame budget** is a test, not a claim: `tests/overlay.spec.js` fails if a full scene frame (snow + trees + fireplace + aurora + stars + icicles + glitter) costs more than 4 ms, which is less than half of the 8.33 ms a 120 fps frame allows.
