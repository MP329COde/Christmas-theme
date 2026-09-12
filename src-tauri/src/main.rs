#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod decoration;
mod settings;
mod theme;

use audio::AmbientPlayer;
use serde::Serialize;
use settings::AppSettings;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use theme::Theme;

struct AppState {
    settings_path: std::path::PathBuf,
    themes_dir: std::path::PathBuf,
    player: Option<AmbientPlayer>,
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
    let _ = app.emit(
        "settings-changed",
        SettingsChanged { settings, theme },
    );
    Ok(())
}

#[tauri::command]
fn disable_everything(state: State<Mutex<AppState>>) -> Result<(), String> {
    let state = state.lock().unwrap();
    AppSettings::wipe(&state.settings_path).map_err(|e| e.to_string())?;
    if let Some(player) = &state.player {
        player.stop();
    }
    Ok(())
}

/// Creates one transparent, click-through, always-on-top snow overlay
/// window per connected monitor, each sized and positioned to exactly
/// cover that monitor. A single window sized to the primary monitor only
/// covered one screen; iterating `available_monitors()` is what makes the
/// snow show up on every display in a multi-monitor setup.
fn spawn_overlay_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    let monitors = app.available_monitors()?;
    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay-{i}");
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("overlay/index.html".into()))
            .title("Snow Overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
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

        // Critical: without this, the overlay (being always-on-top and
        // covering the whole screen) captures every click, making the
        // settings window and the rest of the desktop unusable underneath
        // it. This makes the overlay purely visual — all clicks pass
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
            }));

            spawn_overlay_windows(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_themes,
            get_settings,
            save_settings,
            disable_everything
        ])
        .run(tauri::generate_context!())
        .expect("error while running christmas-theme app");
}
