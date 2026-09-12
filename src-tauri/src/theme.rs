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
        Self::from_json(EMBEDDED_THEME_JSON[0]).expect("built-in default theme must always parse")
    }
}

/// The `themes/*.json` files, embedded into the binary at compile time
/// with `include_str!`.
///
/// Earlier this was loaded at runtime from `app.path().resource_dir()`,
/// but that directory is only populated for paths listed in
/// `tauri.conf.json`'s `bundle.resources` — which this project never set.
/// So in both dev and any packaged build, that directory was always
/// empty and `list_themes` silently fell back to a single hardcoded
/// theme, no matter how many files existed under `themes/`. Embedding at
/// compile time makes theme availability independent of bundle/resource
/// configuration entirely.
const EMBEDDED_THEME_JSON: &[&str] = &[
    include_str!("../../themes/classic-red.json"),
    include_str!("../../themes/frosty-blue.json"),
    include_str!("../../themes/minimal-white.json"),
    include_str!("../../themes/midnight-gold.json"),
    include_str!("../../themes/candy-cane.json"),
    include_str!("../../themes/gingerbread.json"),
    include_str!("../../themes/arctic-aurora.json"),
    include_str!("../../themes/santa-classic.json"),
];

/// Returns every embedded built-in theme. A malformed embedded file would
/// be a build-time bug (they're compiled into the binary), so this
/// panics rather than silently dropping a theme.
pub fn embedded_themes() -> Vec<Theme> {
    EMBEDDED_THEME_JSON
        .iter()
        .map(|raw| Theme::from_json(raw).expect("embedded theme JSON must always parse"))
        .collect()
}

/// Loads every `*.json` theme file in `dir`, for user-contributed themes
/// dropped into the app's config directory (see `main.rs`). Files that
/// fail to parse or validate are skipped with a logged warning rather
/// than aborting the whole load, so one broken community theme doesn't
/// take down the app. Missing directory is not an error (most users
/// won't have one).
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
