#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod decoration;
mod settings;
mod theme;

use audio::AmbientPlayer;
use settings::AppSettings;
use std::sync::Mutex;
use tauri::{Manager, State};
use theme::Theme;

struct AppState {
    settings_path: std::path::PathBuf,
    player: Option<AmbientPlayer>,
}

#[tauri::command]
fn list_themes(app: tauri::AppHandle) -> Vec<Theme> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map(|p| p.join("themes"))
        .unwrap_or_default();
    let mut themes = theme::load_themes_from_dir(&resource_dir);
    if themes.is_empty() {
        themes.push(Theme::default_builtin());
    }
    themes
}

#[tauri::command]
fn get_settings(state: State<Mutex<AppState>>) -> AppSettings {
    let state = state.lock().unwrap();
    AppSettings::load(&state.settings_path)
}

#[tauri::command]
fn save_settings(state: State<Mutex<AppState>>, settings: AppSettings) -> Result<(), String> {
    let state = state.lock().unwrap();
    settings.save(&state.settings_path).map_err(|e| e.to_string())?;
    if let Some(player) = &state.player {
        player.set_volume(settings.sound_volume);
    }
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

            let player = AmbientPlayer::new();

            app.manage(Mutex::new(AppState {
                settings_path,
                player,
            }));

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
