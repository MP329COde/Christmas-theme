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
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
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
    /// Derniers réglages enregistrés, gardés en mémoire : la boucle de
    /// surveillance du Dock relisait et re-parsait settings.json sur le
    /// disque toutes les 1,2 s, pour toujours.
    settings: AppSettings,
    /// Vrai après « Tout désactiver » : plus rien n'est affiché jusqu'au
    /// prochain enregistrement des réglages.
    disabled: bool,
    tray_items: Option<TrayItems>,
    tray_labels: TrayLabels,
}

struct TrayItems {
    open: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Libellés du menu de la barre des menus / zone de notification. Ils
/// viennent de l'interface (src/i18n) pour que toutes les traductions
/// vivent à un seul endroit ; les valeurs par défaut ne servent que le
/// temps que la fenêtre des paramètres se charge.
#[derive(Debug, Clone, serde::Deserialize)]
struct TrayLabels {
    open: String,
    pause: String,
    resume: String,
    quit: String,
    tooltip: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Ouvrir les paramètres".into(),
            pause: "Mettre en pause".into(),
            resume: "Reprendre la décoration".into(),
            quit: "Quitter".into(),
            tooltip: "Décoration de Noël".into(),
        }
    }
}

fn refresh_tray(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let state = state.lock().unwrap();
    if let Some(items) = &state.tray_items {
        let labels = &state.tray_labels;
        let _ = items.open.set_text(&labels.open);
        let _ = items.quit.set_text(&labels.quit);
        let hidden = state.settings.paused || state.disabled;
        let _ = items.pause.set_text(if hidden { &labels.resume } else { &labels.pause });
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&state.tray_labels.tooltip));
    }
}

#[tauri::command]
fn set_tray_labels(app: tauri::AppHandle, state: State<Mutex<AppState>>, labels: TrayLabels) {
    state.lock().unwrap().tray_labels = labels;
    refresh_tray(&app);
}

/// Applique aux fenêtres ce que les réglages disent d'elles : visibles ou
/// non (pause), et à quel niveau (fond d'écran ou par-dessus tout).
fn apply_window_state(app: &tauri::AppHandle) {
    let (hidden, front, dock_enabled) = {
        let state = app.state::<Mutex<AppState>>();
        let state = state.lock().unwrap();
        let s = &state.settings;
        (
            s.paused || state.disabled,
            s.display_mode == "front",
            s.dock_decoration || s.taskbar_decoration,
        )
    };
    for (label, window) in app.webview_windows() {
        if !label.starts_with("overlay-") {
            continue;
        }
        if hidden {
            let _ = window.hide();
        } else {
            let _ = window.set_always_on_bottom(!front);
            let _ = window.set_always_on_top(front);
            let _ = window.show();
            let _ = window.set_ignore_cursor_events(true);
        }
    }
    sync_dock_windows(app, dock_enabled && !hidden);
    refresh_tray(app);
}

/// Bascule la pause depuis le menu : même chemin qu'un enregistrement
/// depuis la fenêtre des paramètres, pour que tout le monde soit prévenu.
fn toggle_pause(app: &tauri::AppHandle) {
    let payload = {
        let state = app.state::<Mutex<AppState>>();
        let mut state = state.lock().unwrap();
        if state.disabled {
            state.disabled = false;
            state.settings.paused = false;
        } else {
            state.settings.paused = !state.settings.paused;
        }
        let _ = state.settings.save(&state.settings_path);
        let theme = resolve_theme(&all_themes(&state.themes_dir), &state.settings.theme_id);
        SettingsChanged { settings: state.settings.clone(), theme }
    };
    let _ = app.emit("settings-changed", payload);
    apply_window_state(app);
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
    state.lock().unwrap().settings.clone()
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: State<Mutex<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    settings.save(&state.settings_path).map_err(|e| e.to_string())?;
    state.settings = settings.clone();
    state.disabled = false;
    if let Some(player) = &state.player {
        player.set_volume(settings.sound_volume);
    }

    // Le réglage « démarrage automatique » n'était que mémorisé : on
    // l'applique réellement auprès du système (LaunchAgent / clé Run).
    {
        use tauri_plugin_autostart::ManagerExt;
        let launcher = app.autolaunch();
        if let Ok(enabled) = launcher.is_enabled() {
            if enabled != settings.autostart {
                let _ = if settings.autostart { launcher.enable() } else { launcher.disable() };
            }
        }
    }

    let theme = resolve_theme(&all_themes(&state.themes_dir), &settings.theme_id);
    let _ = app.emit(
        "settings-changed",
        SettingsChanged { settings, theme },
    );
    // Released before syncing: apply_window_state locks the same state.
    drop(state);
    apply_window_state(&app);
    Ok(())
}

#[tauri::command]
fn disable_everything(
    app: tauri::AppHandle,
    state: State<Mutex<AppState>>,
) -> Result<(), String> {
    let mut state_guard = state.lock().unwrap();
    AppSettings::wipe(&state_guard.settings_path).map_err(|e| e.to_string())?;
    // La langue est conservée : tout désactiver ne doit pas faire
    // rebasculer l'interface dans une autre langue sous les yeux.
    let language = state_guard.settings.language.clone();
    state_guard.settings = AppSettings { language, ..AppSettings::default() };
    state_guard.disabled = true;
    if let Some(player) = &state_guard.player {
        player.stop();
    }
    let config_dir = state_guard.settings_path.parent().map(|p| p.to_path_buf());
    drop(state_guard);
    {
        use tauri_plugin_autostart::ManagerExt;
        let _ = app.autolaunch().disable();
    }
    // "No residual trace" means every file this app wrote, not only the
    // settings: stored background images go too.
    if let Some(dir) = config_dir {
        let _ = std::fs::remove_dir_all(dir.join("backgrounds"));
    }
    // It also includes screen furniture: the snow overlays and the dock
    // decoration come down immediately rather than at next launch (the
    // overlays used to keep snowing after "disable everything").
    apply_window_state(&app);
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
                .title("Décoration de Bureau")
                .transparent(true)
                .decorations(false)
                // Without this, macOS draws its native drop shadow behind
                // whatever the window's content alpha shape is — since this
                // window is a large transparent rect around a thin strip of
                // garland/icicles, that shadow renders as an ugly black
                // halo hugging the decoration's outline instead of a clean
                // transparent edge.
                .shadow(false)
                // Le niveau (devant / derrière les fenêtres) dépend du
                // réglage `dockPlacement` : voir sync_dock_windows.
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
    let dock_front = {
        let state = app.state::<Mutex<AppState>>();
        let state = state.lock().unwrap();
        state.settings.dock_placement == "front"
    };
    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("dock-{i}");
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        // Appliqué à chaque synchronisation (et pas seulement quand la
        // géométrie change) pour qu'un changement de réglage soit immédiat.
        let _ = window.set_always_on_bottom(!dock_front);
        let _ = window.set_always_on_top(dock_front);
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
                .unwrap_or_else(|| format!("Écran {}", index + 1)),
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
            .title("Superposition de Neige")
            .transparent(true)
            .decorations(false)
            // Same reasoning as the dock windows: this window covers the
            // whole monitor but its own content (trees, fireplace, snow) is
            // mostly transparent, so macOS's native drop shadow traces
            // that content's silhouette instead of the window's edge —
            // a black outline around every tree and a black box around
            // the fireplace. Disabling it is what makes the overlay read
            // as painted directly on the desktop rather than floating in
            // its own shadowed pane.
            .shadow(false)
            .always_on_bottom(true)
            .skip_taskbar(true)
            .focused(false)
            // Affichée par apply_window_state une fois les réglages connus
            // (pause, mode d'affichage), jamais avant.
            .visible(false)
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

/// Réaffiche la fenêtre des paramètres (fermée vers la zone de notification).
fn show_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Icône de la zone de notification : l'application vit en arrière-plan,
/// fermer les paramètres ne doit donc pas arrêter la décoration.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let labels = TrayLabels::default();
    let open = MenuItem::with_id(app, "open", &labels.open, true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", &labels.pause, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep1, &pause, &sep2, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(&labels.tooltip)
        .menu(&menu)
        // macOS : un clic sur une icône de la barre des menus ouvre son
        // menu, c'est la convention. Windows / Linux : le clic gauche ouvre
        // directement les paramètres, le clic droit le menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_settings(app),
            "pause" => toggle_pause(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_settings(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.state::<Mutex<AppState>>().lock().unwrap().tray_items =
        Some(TrayItems { open, pause, quit });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
            let initial = AppSettings::load(&settings_path);
            let first_run = !initial.onboarding_done;

            app.manage(Mutex::new(AppState {
                settings_path,
                themes_dir,
                player,
                dock_strips: HashMap::new(),
                settings: initial,
                disabled: false,
                tray_items: None,
                tray_labels: TrayLabels::default(),
            }));

            // macOS : application « accessoire » — aucune icône dans le Dock
            // ni dans le sélecteur d'applications, seulement l'icône de la
            // barre des menus. Sous Windows et Linux, les fenêtres de
            // décoration sont déjà hors barre des tâches (skip_taskbar) et
            // l'application vit dans la zone de notification.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app)?;
            spawn_overlay_windows(app.handle())?;
            spawn_dock_windows(app.handle())?;
            apply_window_state(app.handle());

            // La fenêtre des paramètres ne s'ouvre d'elle-même qu'au tout
            // premier lancement (assistant de configuration). Ensuite, un
            // démarrage — notamment automatique à l'ouverture de session —
            // reste silencieux : on y revient par l'icône.
            if first_run {
                show_settings(app.handle());
            }

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
                        let state = state.lock().unwrap();
                        let s = &state.settings;
                        (s.dock_decoration || s.taskbar_decoration)
                            && !s.paused
                            && !state.disabled
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
            load_background,
            set_tray_labels
        ])
        .run(tauri::generate_context!())
        .expect("erreur lors de l'exécution de Décoration de Noël");
}
