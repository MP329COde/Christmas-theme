//! Dock/taskbar decoration. See docs/ARCHITECTURE.md section 4 for the
//! full feasibility writeup. Summary:
//!
//! - Windows: reliable, no special permission — we locate the
//!   `Shell_TrayWnd` window and position a layered, click-through window
//!   over it.
//! - macOS: experimental and opt-in. There is no public stable API for
//!   the Dock's frame; we rely on the Accessibility API, which requires
//!   the user to grant Accessibility permission and can lag when the
//!   Dock resizes/moves/auto-hides.

#[cfg(target_os = "windows")]
#[allow(dead_code)] // not wired into main.rs yet: see taskbar_rect() below
pub mod windows_impl {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use windows::core::w;

    /// Returns the screen rect of the Windows taskbar (`Shell_TrayWnd`),
    /// or `None` if it can't be found (e.g. Explorer not running).
    pub fn taskbar_rect() -> Option<RECT> {
        unsafe {
            let hwnd: HWND = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
            let mut rect = RECT::default();
            windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect).ok()?;
            Some(rect)
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(dead_code)] // not wired into main.rs yet: see dock_frame() below
pub mod macos_impl {
    //! Requires Accessibility permission (System Settings > Privacy &
    //! Security > Accessibility). We poll the Dock's frame on an
    //! interval rather than subscribing to a change notification,
    //! because no reliable public notification exists for Dock
    //! resize/reposition; polling means the decoration can visibly lag
    //! for a fraction of a second after the user moves/resizes the Dock.

    #[derive(Debug, Clone, Copy)]
    pub struct DockFrame {
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
    }

    /// Placeholder for the AXUIElement-based lookup. Real implementation
    /// requires linking `ApplicationServices` and calling
    /// `AXUIElementCopyAttributeValue` on the Dock process for
    /// `kAXPositionAttribute` / `kAXSizeAttribute`; left unimplemented in
    /// this scaffold pending a maintainer with a macOS machine to verify
    /// against real OS versions (see docs/ARCHITECTURE.md section 4).
    pub fn dock_frame() -> Option<DockFrame> {
        None
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[allow(dead_code)] // not wired into main.rs yet
pub mod unsupported {
    pub fn unsupported_platform_notice() -> &'static str {
        "Dock/taskbar decoration is only implemented for Windows and macOS."
    }
}
