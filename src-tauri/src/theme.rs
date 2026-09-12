use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ThemeError {
    #[error("io error reading theme file: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid theme json: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unsupported theme schema version {0} (expected {SUPPORTED_SCHEMA_VERSION})")]
    UnsupportedSchema(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeColors {
    pub primary: String,
    pub secondary: String,
    pub accent: String,
    pub background: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnowConfig {
    pub density: u32,
    pub accumulate: bool,
    pub wind: f32,
    #[serde(rename = "flakeSize")]
    pub flake_size: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundConfig {
    pub ambient: String,
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decorations {
    pub dock: bool,
    pub taskbar: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub colors: ThemeColors,
    pub snow: SnowConfig,
    pub sound: SoundConfig,
    pub decorations: Decorations,
}

impl Theme {
    /// Parses and validates a theme JSON string. Rejects unsupported
    /// schema versions so a malformed or future-versioned community
    /// theme can't silently corrupt app state.
    pub fn from_json(raw: &str) -> Result<Theme, ThemeError> {
        let theme: Theme = serde_json::from_str(raw)?;
        if theme.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(ThemeError::UnsupportedSchema(theme.schema_version));
        }
        Ok(theme)
    }

    pub fn default_builtin() -> Theme {
        serde_json::from_str(include_str!("../../themes/classic-red.json"))
            .expect("built-in default theme must always parse")
    }
}

/// Loads every `*.json` theme file in `dir`. Files that fail to parse or
/// validate are skipped with a logged warning rather than aborting the
/// whole load, so one broken community theme doesn't take down the app.
pub fn load_themes_from_dir(dir: &Path) -> Vec<Theme> {
    let mut themes = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return themes;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read_to_string(&path).map(|raw| Theme::from_json(&raw)) {
            Ok(Ok(theme)) => themes.push(theme),
            Ok(Err(e)) => eprintln!("skipping invalid theme {:?}: {e}", path),
            Err(e) => eprintln!("skipping unreadable theme {:?}: {e}", path),
        }
    }
    themes
}
