use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// #[serde(default)] at the container level means a settings.json saved by
// an older version of the app (missing newly-added fields below) still
// loads fine, filling in Default::default() for whatever's missing,
// instead of failing to parse and silently discarding the user's saved
// choices.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    #[serde(rename = "themeId")]
    pub theme_id: String,
    #[serde(rename = "snowDensity")]
    pub snow_density: u32,
    #[serde(rename = "dockDecoration")]
    pub dock_decoration: bool,
    #[serde(rename = "taskbarDecoration")]
    pub taskbar_decoration: bool,
    #[serde(rename = "treesDecoration")]
    pub trees_decoration: bool,
    #[serde(rename = "garlandsDecoration")]
    pub garlands_decoration: bool,
    #[serde(rename = "fireplaceDecoration")]
    pub fireplace_decoration: bool,
    /// 0.0 (still air) to 1.0 (strong gusts). Overrides the active theme's
    /// own wind default, same as snow_density already does.
    #[serde(rename = "snowWind")]
    pub snow_wind: f32,
    /// Whether falling snow piles up at the bottom of the screen.
    /// Overrides the active theme's own default.
    #[serde(rename = "snowAccumulate")]
    pub snow_accumulate: bool,
    /// Garland bulb color palette: "multicolor" | "warm" | "cool".
    #[serde(rename = "garlandStyle")]
    pub garland_style: String,
    #[serde(rename = "soundVolume")]
    pub sound_volume: f32,
    pub autostart: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_id: "classic-red".into(),
            snow_density: 120,
            dock_decoration: true,
            taskbar_decoration: true,
            trees_decoration: true,
            garlands_decoration: true,
            fireplace_decoration: true,
            snow_wind: 0.3,
            snow_accumulate: true,
            garland_style: "multicolor".into(),
            sound_volume: 0.4,
            autostart: false,
        }
    }
}

impl AppSettings {
    pub fn load(path: &PathBuf) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        fs::write(path, raw)
    }

    /// Removes the persisted settings file entirely, leaving no residual
    /// state on disk ("disable everything" requirement).
    pub fn wipe(path: &PathBuf) -> std::io::Result<()> {
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}
