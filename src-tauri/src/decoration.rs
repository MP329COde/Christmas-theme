//! Dock / taskbar decoration.
//!
//! THE SOLUTION: instead of poking at the Dock through undocumented or
//! permission-gated APIs, we derive the strip it occupies from data the
//! OS already publishes to every window manager — the monitor's *work
//! area*. The work area is the part of a screen left over for ordinary
//! windows once the shell's reserved bars (macOS Dock + menu bar,
//! Windows taskbar) are taken out, and Tauri surfaces it as
//! `Monitor::work_area()`.
//!
//! Subtracting the work area from the full monitor bounds therefore gives
//! the shell strip directly, on both platforms, with:
//!
//!   * no Accessibility permission prompt on macOS,
//!   * no undocumented AXUIElement traversal of the Dock process,
//!   * automatic correctness for a Dock on the left/right/bottom, a
//!     taskbar on any of the four edges, multiple monitors, HiDPI, and
//!     "smaller/larger Dock" size changes.
//!
//! Windows keeps a `Shell_TrayWnd` lookup as a *fallback* for the one
//! case the work area can't describe: an auto-hiding taskbar reserves no
//! work area at all, so the subtraction yields nothing and we ask the
//! shell window directly.
//!
//! KNOWN LIMITATION, reported rather than papered over: on macOS the Dock
//! is drawn at a window level above ordinary floating windows, so a
//! decoration cannot be composited *on top of* the Dock itself. We
//! therefore hang the decoration over the strip's leading edge — the
//! garland, icicles and snow ledge sit in the band just outside the work
//! area and remain fully visible, and anything that would fall behind the
//! Dock is simply not drawn. On Windows the strip is covered directly.

use serde::Serialize;
use tauri::Monitor;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Bottom,
    Top,
    Left,
    Right,
}

/// The screen region a decoration should occupy for one monitor, in
/// physical pixels. `edge` says which screen edge the Dock/taskbar is
/// docked against, so the page knows which way to hang the garland.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockStrip {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub edge: Edge,
    /// Thickness of the shell bar itself, before the overhang below is
    /// added. The page uses it to know where the Dock's own edge is.
    pub bar_thickness: u32,
    pub scale_factor: f64,
}

/// How far the decoration is allowed to reach out of the shell strip and
/// over the desktop, in physical pixels at scale 1. This band is what
/// stays visible on macOS, where the Dock itself sits above us.
const OVERHANG: i32 = 26;

/// Derives the shell strip from the gap between the monitor bounds and
/// its work area. Returns `None` when the monitor reserves nothing (an
/// auto-hidden Dock/taskbar, or a secondary display with no shell bar).
pub fn strip_from_work_area(monitor: &Monitor) -> Option<DockStrip> {
    let scale = monitor.scale_factor();
    let mx = monitor.position().x;
    let my = monitor.position().y;
    let mw = monitor.size().width as i32;
    let mh = monitor.size().height as i32;

    let wa = monitor.work_area();
    let wx = wa.position.x;
    let wy = wa.position.y;
    let ww = wa.size.width as i32;
    let wh = wa.size.height as i32;

    // A work area equal to the whole monitor means nothing is reserved.
    let left = wx - mx;
    let top = wy - my;
    let right = (mx + mw) - (wx + ww);
    let bottom = (my + mh) - (wy + wh);

    // The macOS menu bar also eats into the work area at the top, and it
    // is not the Dock — never treat the top inset as the Dock there.
    let mut candidates: Vec<(Edge, i32)> = vec![
        (Edge::Bottom, bottom),
        (Edge::Left, left),
        (Edge::Right, right),
    ];
    if !cfg!(target_os = "macos") {
        candidates.push((Edge::Top, top));
    }

    // Ignore 1-2px rounding noise; a real Dock/taskbar is dozens of pixels.
    let (edge, thickness) = candidates.into_iter().max_by_key(|(_, v)| *v)?;
    if thickness < 8 {
        return None;
    }

    Some(build_strip(edge, thickness, scale, mx, my, mw, mh))
}

fn build_strip(
    edge: Edge,
    thickness: i32,
    scale: f64,
    mx: i32,
    my: i32,
    mw: i32,
    mh: i32,
) -> DockStrip {
    let overhang = (OVERHANG as f64 * scale).round() as i32;
    let span = thickness + overhang;

    let (x, y, width, height) = match edge {
        Edge::Bottom => (mx, my + mh - span, mw, span),
        Edge::Top => (mx, my, mw, span),
        Edge::Left => (mx, my, span, mh),
        Edge::Right => (mx + mw - span, my, span, mh),
    };

    DockStrip {
        x,
        y,
        width: width.max(1) as u32,
        height: height.max(1) as u32,
        edge,
        bar_thickness: thickness.max(1) as u32,
        scale_factor: scale,
    }
}

/// Full detection for one monitor: work-area subtraction first, then the
/// platform fallback for the cases it cannot see.
pub fn detect(monitor: &Monitor) -> Option<DockStrip> {
    if let Some(strip) = strip_from_work_area(monitor) {
        return Some(strip);
    }
    platform_fallback(monitor)
}

#[cfg(target_os = "windows")]
fn platform_fallback(monitor: &Monitor) -> Option<DockStrip> {
    // An auto-hiding taskbar reserves no work area, so ask the shell
    // window for its rect instead. It still reports a real rect while
    // hidden (parked just off-screen), which we clamp back onto the
    // monitor so the decoration sits where the bar will reappear.
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};

    let rect: RECT = unsafe {
        let hwnd: HWND = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        rect
    };

    let mx = monitor.position().x;
    let my = monitor.position().y;
    let mw = monitor.size().width as i32;
    let mh = monitor.size().height as i32;

    let bar_w = (rect.right - rect.left).max(1);
    let bar_h = (rect.bottom - rect.top).max(1);

    // Horizontal bar => top or bottom, vertical bar => left or right.
    let edge = if bar_w >= bar_h {
        if rect.top - my > mh / 2 {
            Edge::Bottom
        } else {
            Edge::Top
        }
    } else if rect.left - mx > mw / 2 {
        Edge::Right
    } else {
        Edge::Left
    };
    let thickness = if bar_w >= bar_h { bar_h } else { bar_w };

    Some(build_strip(
        edge,
        thickness,
        monitor.scale_factor(),
        mx,
        my,
        mw,
        mh,
    ))
}

#[cfg(not(target_os = "windows"))]
fn platform_fallback(_monitor: &Monitor) -> Option<DockStrip> {
    // macOS: an auto-hidden Dock reserves no work area and exposes no
    // public API for its hidden frame. Rather than poll the Accessibility
    // API (permission prompt, undocumented, laggy), we decorate nothing
    // and let the app report it — see `dock_status()` in main.rs, which
    // surfaces this in the settings window instead of failing silently.
    None
}

/// Human-readable explanation shown in the settings window when no strip
/// could be found, so "the toggle is on but I see nothing" is never a
/// mystery.
pub fn unavailable_reason() -> &'static str {
    if cfg!(target_os = "macos") {
        "No Dock strip detected — the Dock is probably set to auto-hide. \
         Turn auto-hide off in System Settings › Desktop & Dock to decorate it."
    } else if cfg!(target_os = "windows") {
        "No taskbar strip detected — Explorer may not be running."
    } else {
        "Dock/taskbar decoration needs a desktop shell that reserves screen \
         work area (macOS Dock or Windows taskbar)."
    }
}
