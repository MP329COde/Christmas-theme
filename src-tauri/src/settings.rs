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
    /// How deep settled snow is allowed to pile up, in pixels.
    #[serde(rename = "maxSnowHeight")]
    pub max_snow_height: u32,
    /// Multiplier on flake size, on top of the theme's own flakeSize.
    #[serde(rename = "flakeScale")]
    pub flake_scale: f32,
    /// Multiplier on the size of the trees and fireplace.
    #[serde(rename = "decorScale")]
    pub decor_scale: f32,
    /// Warm string lights woven through the trees.
    #[serde(rename = "treeLights")]
    pub tree_lights: bool,
    /// Stockings hung from the mantel.
    pub stockings: bool,
    /// Pine swag draped over the mantel.
    #[serde(rename = "mantelGarland")]
    pub mantel_garland: bool,
    /// Light animation driving every string in the scene at once:
    /// "twinkle" | "sparkle" | "chase" | "wave" | "steady".
    #[serde(rename = "lightAnimation")]
    pub light_animation: String,
    /// Global brightness multiplier for every animated light (0.2 - 2.0).
    #[serde(rename = "lightIntensity")]
    pub light_intensity: f32,
    /// Aurora curtains drifting across the sky.
    pub aurora: bool,
    /// Twinkling star field and the occasional shooting star.
    pub stars: bool,
    /// Icicle fringe along the top edge, with a travelling glint and drips.
    pub icicles: bool,
    /// Specular sparkles on the surface of the settled snow.
    #[serde(rename = "snowGlitter")]
    pub snow_glitter: bool,
    /// Per-screen scene composition and saved presets.
    ///
    /// Deliberately stored as opaque JSON rather than modelled field by
    /// field in Rust. This part of the configuration is a tree of
    /// user-composed content — a list of trees per screen, each with its
    /// own position, scale and light style, plus any number of saved
    /// presets — and its shape is owned by the renderer that consumes it.
    /// Mirroring every field here would mean editing two languages to add
    /// one slider, and would make an older binary reject a newer config
    /// instead of carrying it through untouched.
    #[serde(default)]
    pub scene: serde_json::Value,
    /// Saved presets: [{ id, name, createdAt, scene, global }].
    #[serde(default)]
    pub presets: serde_json::Value,
    /// Tree renderer: "auto" (WebGL only on a real GPU), "webgl" (force it,
    /// including on a software rasteriser) or "canvas" (never).
    #[serde(default = "default_renderer")]
    pub renderer: String,
    /// Frame rate cap. This is a permanent background wallpaper, not a
    /// game, so the default (30) deliberately does NOT chase the
    /// display's full refresh rate — see src/shared/perf.js for the rest
    /// of the automatic performance budget this is one part of. 0 means
    /// uncapped for anyone who wants it back.
    #[serde(rename = "fpsLimit")]
    pub fps_limit: u32,
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
            max_snow_height: 60,
            flake_scale: 1.0,
            decor_scale: 1.0,
            tree_lights: true,
            stockings: true,
            mantel_garland: true,
            light_animation: "twinkle".into(),
            light_intensity: 1.0,
            aurora: true,
            stars: true,
            icicles: true,
            snow_glitter: true,
            renderer: default_renderer(),
            scene: serde_json::Value::Null,
            presets: serde_json::Value::Null,
            fps_limit: 30,
            sound_volume: 0.4,
            autostart: false,
        }
    }
}

fn default_renderer() -> String {
    "auto".into()
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
