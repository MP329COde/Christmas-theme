#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod decoration;
mod settings;
mod theme;

use audio::AmbientPlayer;
use decoration::DockStrip;
use serde::Serialize;
use settings::AppSettings;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindowBuilder};
use theme::Theme;

struct AppState {
    settings_path: std::path::PathBuf,
    themes_dir: std::path::PathBuf,
    player: Option<AmbientPlayer>,
    /// Last strip pushed to each dock window. The dock geometry is polled
    /// on a timer (the shells emit no reliable "I moved" notification), so
    /// this is what keeps that poll from re-emitting an identical payload
    /// once a second forever.
    dock_strips: HashMap<String, Option<DockStrip>>,
}

/// Payload broadcast to every window whenever settings are saved, so the
/// snow overlay window(s) can react live instead of only picking up a
/// changed theme/density on next launch.
#[derive(Debug, Clone, Serialize)]
struct SettingsChanged {
    settings: AppSettings,
    theme: Theme,
}

fn resolve_theme(themes: &[Theme], theme_id: &str) -> Theme {
    themes
        .iter()
        .find(|t| t.id == theme_id)
        .cloned()
        .unwrap_or_else(Theme::default_builtin)
}

/// All available themes: the built-ins embedded into the binary, plus any
/// user-contributed `*.json` files dropped into the app's config
/// directory under `themes/`. A user theme with the same `id` as a
/// built-in overrides it.
fn all_themes(themes_dir: &std::path::Path) -> Vec<Theme> {
    let mut themes = theme::embedded_themes();
    for user_theme in theme::load_themes_from_dir(themes_dir) {
        if let Some(existing) = themes.iter_mut().find(|t| t.id == user_theme.id) {
            *existing = user_theme;
        } else {
            themes.push(user_theme);
        }
    }
    themes
}

#[tauri::command]
fn list_themes(state: State<Mutex<AppState>>) -> Vec<Theme> {
    let state = state.lock().unwrap();
    all_themes(&state.themes_dir)
}

#[tauri::command]
fn get_settings(state: State<Mutex<AppState>>) -> AppSettings {
    let state = state.lock().unwrap();
    AppSettings::load(&state.settings_path)
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: State<Mutex<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    let state = state.lock().unwrap();
    settings.save(&state.settings_path).map_err(|e| e.to_string())?;
    if let Some(player) = &state.player {
        player.set_volume(settings.sound_volume);
    }

    let theme = resolve_theme(&all_themes(&state.themes_dir), &settings.theme_id);
    let dock_enabled = settings.dock_decoration || settings.taskbar_decoration;
    let _ = app.emit(
        "settings-changed",
        SettingsChanged { settings, theme },
    );
    // Released before syncing: sync_dock_windows locks the same state to
    // compare against the last pushed geometry.
    drop(state);
    sync_dock_windows(&app, dock_enabled);
    Ok(())
}

#[tauri::command]
fn disable_everything(
    app: tauri::AppHandle,
    state: State<Mutex<AppState>>,
) -> Result<(), String> {
    let state_guard = state.lock().unwrap();
    AppSettings::wipe(&state_guard.settings_path).map_err(|e| e.to_string())?;
    if let Some(player) = &state_guard.player {
        player.stop();
    }
    let config_dir = state_guard.settings_path.parent().map(|p| p.to_path_buf());
    drop(state_guard);
    // "No residual trace" means every file this app wrote, not only the
    // settings: stored background images go too.
    if let Some(dir) = config_dir {
        let _ = std::fs::remove_dir_all(dir.join("backgrounds"));
    }
    // It also includes screen furniture: take the dock decoration down
    // immediately rather than at next launch.
    sync_dock_windows(&app, false);
    Ok(())
}

/// One hidden decoration window per monitor, created up-front on the main
/// thread. The polling task below only ever moves, shows and hides them:
/// building a window from a background thread is not safe on every
/// platform, whereas position/size/visibility changes are proxied through
/// the event loop and are.
fn spawn_dock_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    let count = app.available_monitors()?.len();
    for i in 0..count {
        let label = format!("dock-{i}");
        let window =
            WebviewWindowBuilder::new(app, &label, WebviewUrl::App("dock/index.html".into()))
                .title("Dock Decoration")
                .transparent(true)
                .decorations(false)
                // Unlike the snow overlay (a live wallpaper, deliberately
                // at the bottom), this one has to sit above the desktop
                // to decorate the shell bar at all. It's a thin strip in
                // screen furniture no app window occupies, and it's
                // click-through, so it stays out of the way.
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .inner_size(16.0, 16.0)
                .build()?;
        window.set_ignore_cursor_events(true)?;
    }
    Ok(())
}

/// Places (or hides) every dock decoration window to match the current
/// Dock/taskbar geometry. Called at startup, after every settings save,
/// and from the poll loop so moving the Dock, resizing it or plugging in
/// a monitor is picked up without a restart.
fn sync_dock_windows(app: &tauri::AppHandle, enabled: bool) {
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("dock-{i}");
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        let strip = if enabled {
            decoration::detect(monitor)
        } else {
            None
        };

        let changed = {
            let state = app.state::<Mutex<AppState>>();
            let mut state = state.lock().unwrap();
            let previous = state.dock_strips.get(&label).copied().flatten();
            if previous == strip {
                false
            } else {
                state.dock_strips.insert(label.clone(), strip);
                true
            }
        };
        if !changed {
            continue;
        }

        match strip {
            Some(s) => {
                let _ = window.set_position(tauri::PhysicalPosition::new(s.x, s.y));
                let _ = window.set_size(tauri::PhysicalSize::new(s.width, s.height));
                let _ = window.set_ignore_cursor_events(true);
                let _ = app.emit_to(EventTarget::webview_window(&label), "dock-geometry", s);
                let _ = window.show();
            }
            None => {
                let _ = window.hide();
            }
        }
    }
}

/// One connected display, as the settings window needs to describe it:
/// which overlay window belongs to it, how big it is, and a label a person
/// can recognise. Without this the per-screen editor could only say
/// "screen 0", which is useless on a four-monitor desk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenInfo {
    index: usize,
    label: String,
    name: String,
    /// Position in the OS's virtual desktop space (physical pixels), i.e.
    /// where this monitor's top-left corner sits relative to the primary
    /// monitor's origin. This is what lets overlay windows derive a shared
    /// global coordinate space instead of each starting back at (0, 0) —
    /// needed so a star field (or anything else meant to look continuous)
    /// lines up across monitor edges.
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    /// The monitor containing the origin is the primary one on every
    /// platform we target.
    primary: bool,
    /// The virtual desktop's own top-left corner — the minimum x/y across
    /// ALL connected monitors, not just this one. Identical on every entry
    /// in the returned list; included per-entry so a caller that only
    /// fetches its own screen's info still gets it. Monitors laid out
    /// above/left of the primary one (a common arrangement) have negative
    /// positions, so this is not always (0, 0).
    virtual_origin_x: i32,
    virtual_origin_y: i32,
}

#[tauri::command]
fn list_screens(app: tauri::AppHandle) -> Vec<ScreenInfo> {
    let monitors = app.available_monitors().unwrap_or_default();
    let virtual_origin_x = monitors.iter().map(|m| m.position().x).min().unwrap_or(0);
    let virtual_origin_y = monitors.iter().map(|m| m.position().y).min().unwrap_or(0);
    monitors
        .iter()
        .enumerate()
        .map(|(index, m)| ScreenInfo {
            index,
            label: format!("overlay-{index}"),
            name: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Display {}", index + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            virtual_origin_x,
            virtual_origin_y,
            scale_factor: m.scale_factor(),
            primary: m.position().x == 0 && m.position().y == 0,
        })
        .collect()
}

/// Background images live in their own files, one per screen, NOT inside
/// settings.json. A 4K photo as a data URL is megabytes; putting that in
/// the settings file would mean rewriting it on every slider change and
/// re-broadcasting it to every window on every save.
fn background_path(dir: &std::path::Path, key: &str) -> std::path::PathBuf {
    // The key comes from the settings window and only ever identifies a
    // screen, but it reaches the filesystem, so it is restricted to
    // characters that cannot escape the directory.
    let safe: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    dir.join("backgrounds").join(format!("{safe}.txt"))
}

#[tauri::command]
fn save_background(
    app: tauri::AppHandle,
    state: State<Mutex<AppState>>,
    key: String,
    data_url: Option<String>,
) -> Result<(), String> {
    let dir = {
        let state = state.lock().unwrap();
        state.settings_path.parent().unwrap().to_path_buf()
    };
    let path = background_path(&dir, &key);
    match data_url {
        Some(url) => {
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&path, url).map_err(|e| e.to_string())?;
        }
        // None clears it, and clearing must actually remove the file so
        // "disable everything" leaves nothing behind.
        None => {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    let _ = app.emit("background-changed", &key);
    Ok(())
}

#[tauri::command]
fn load_background(state: State<Mutex<AppState>>, key: String) -> Option<String> {
    let dir = {
        let state = state.lock().unwrap();
        state.settings_path.parent().unwrap().to_path_buf()
    };
    std::fs::read_to_string(background_path(&dir, &key)).ok()
}

/// What the settings window shows next to the Dock toggle: the strips we
/// actually found, or why we found none. Silence here was the whole
/// problem with the previous scaffold.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockStatus {
    strips: Vec<DockStrip>,
    reason: Option<&'static str>,
}

#[tauri::command]
fn dock_status(app: tauri::AppHandle) -> DockStatus {
    let strips: Vec<DockStrip> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .filter_map(decoration::detect)
        .collect();
    let reason = if strips.is_empty() {
        Some(decoration::unavailable_reason())
    } else {
        None
    };
    DockStatus { strips, reason }
}

/// Creates one transparent, click-through, always-on-top snow overlay
/// window per connected monitor, each sized and positioned to exactly
/// cover that monitor. A single window sized to the primary monitor only
/// covered one screen; iterating `available_monitors()` is what makes the
/// snow show up on every display in a multi-monitor setup.
///
/// Deliberately `always_on_bottom`, not `always_on_top`: this is meant to
/// behave like a live wallpaper (visible on empty desktop space, quietly
/// covered by whatever window you're actually using), not a layer that
/// floats above every other app and gets in the way of using them. It's
/// also not marked visible-on-all-workspaces, so it doesn't follow you
/// into another Space/virtual desktop or over a fullscreen app.
fn spawn_overlay_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    let monitors = app.available_monitors()?;
    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay-{i}");
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("overlay/index.html".into()))
            .title("Snow Overlay")
            .transparent(true)
            .decorations(false)
            .always_on_bottom(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(true)
            .inner_size(monitor.size().width as f64, monitor.size().height as f64)
            .position(monitor.position().x as f64, monitor.position().y as f64)
            .build()?;

        // Exact placement: builder position()/inner_size() are in logical
        // pixels and get scaled by the *primary* monitor's scale factor,
        // which is wrong for a secondary monitor with a different scale
        // factor. Setting physical position/size directly afterwards
        // guarantees the overlay lines up with this monitor exactly.
        window.set_position(*monitor.position())?;
        window.set_size(*monitor.size())?;

        // Critical regardless of z-order: without this, the overlay (which
        // covers the whole screen) still captures every click and desktop
        // icon interaction. This makes it purely visual — all clicks pass
        // through to whatever is beneath it.
        window.set_ignore_cursor_events(true)?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let settings_path = app
                .path()
                .app_config_dir()
                .expect("app config dir must resolve")
                .join("settings.json");
            let themes_dir = app
                .path()
                .app_config_dir()
                .expect("app config dir must resolve")
                .join("themes");

            let player = AmbientPlayer::new();

            app.manage(Mutex::new(AppState {
                settings_path,
                themes_dir,
                player,
                dock_strips: HashMap::new(),
            }));

            spawn_overlay_windows(app.handle())?;
            spawn_dock_windows(app.handle())?;

            let initial = AppSettings::load(
                &app.state::<Mutex<AppState>>().lock().unwrap().settings_path.clone(),
            );
            sync_dock_windows(app.handle(), initial.dock_decoration || initial.taskbar_decoration);

            // Poll for Dock/taskbar geometry changes. Neither macOS nor
            // Windows offers a dependable notification for "the Dock moved
            // or was resized", so a low-frequency poll on the main thread
            // is the reliable option; at 1.2s it is invisible in a CPU
            // profile and picks up a moved Dock, a resized taskbar or a
            // newly connected monitor on its own.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let enabled = {
                        let state = h.state::<Mutex<AppState>>();
                        let path = state.lock().unwrap().settings_path.clone();
                        let s = AppSettings::load(&path);
                        s.dock_decoration || s.taskbar_decoration
                    };
                    sync_dock_windows(&h, enabled);
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_themes,
            get_settings,
            save_settings,
            disable_everything,
            dock_status,
            list_screens,
            save_background,
            load_background
        ])
        .run(tauri::generate_context!())
        .expect("error while running christmas-theme app");
}
