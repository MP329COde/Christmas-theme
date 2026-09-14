// The scene schema: what can be put on a screen, and how it is described.
//
// This is the single source of truth for the composition, shared by the
// settings window (which edits it) and the overlay (which renders it).
// The Rust side stores it as opaque JSON precisely so this file can own
// the shape — see the comment on AppSettings::scene.
//
// SHAPE
//
//   scene.screens["0"]        per-monitor composition, keyed by overlay index
//   scene.screens.default     used by any monitor with no entry of its own
//
// A screen holds LISTS of elements rather than booleans, which is what
// makes "two trees on the left screen and a fireplace on the right"
// expressible at all. Every element carries its own position, scale and
// light style, so nothing is hard-coded to a corner any more.

export const LIGHT_PALETTES = {
  multicolor: ['#ff5d5d', '#ffc93c', '#3ddc97', '#5b8def', '#c77dff'],
  warm: ['#ffcf8a', '#ffb347', '#ffe6b8', '#ff9d4d'],
  cool: ['#9fe8ff', '#5b8def', '#c9d9ff', '#7fe0e0'],
  'red-green': ['#e03b3b', '#2fbf5f'],
  'red-blue': ['#e03b3b', '#3b7fe0'],
  candy: ['#ff4d6d', '#ffffff'],
  ice: ['#dff6ff', '#a7d8f0', '#ffffff'],
  gold: ['#ffd75e', '#ffb02e', '#fff0c2'],
};

export const LIGHT_MODES = ['twinkle', 'sparkle', 'chase', 'wave', 'steady'];

export const AURORA_PALETTES = {
  classic: {
    colors: ['#5cffb0', '#82ebff', '#d678ff'],
    haze: ['#40be8c', '#50aadc', '#965ad2'],
  },
  emerald: {
    colors: ['#4dff8a', '#5dffc2', '#8fffd2'],
    haze: ['#2ca866', '#36b88a', '#4aa88a'],
  },
  arctic: {
    colors: ['#8ff5ff', '#78b9ff', '#d4c8ff'],
    haze: ['#58c2d2', '#4e7fc4', '#9078c8'],
  },
  twilight: {
    colors: ['#ff7eb6', '#b98cff', '#718cff'],
    haze: ['#bd5d8c', '#8064be', '#4d63b2'],
  },
};

/// Coordinated per-screen weather recipes. The numeric values are
/// multipliers applied to the user's global snow controls, preserving a
/// preferred baseline while letting each display have its own conditions.
export const WEATHER_PROFILES = {
  calm: { label: 'Calm', flakeScale: 0.7, wind: 0.35, accumulate: 0.45, glitterDensity: 0.45 },
  gentle: { label: 'Gentle snowfall', flakeScale: 0.9, wind: 0.7, accumulate: 0.8, glitterDensity: 0.8 },
  winter: { label: 'Winter day', flakeScale: 1, wind: 1, accumulate: 1, glitterDensity: 1 },
  blizzard: { label: 'Blizzard', flakeScale: 1.35, wind: 1.65, accumulate: 1.5, glitterDensity: 1.35 },
};

export function resolveWeatherProfile(profile) {
  return WEATHER_PROFILES[profile] ?? WEATHER_PROFILES.winter;
}

export const CAMERA_MOTION_PROFILES = {
  system: { label: 'System preference', motion: 1 },
  still: { label: 'Locked off', motion: 0 },
  gentle: { label: 'Gentle drift', motion: 0.45 },
  cinematic: { label: 'Cinematic drift', motion: 1 },
  immersive: { label: 'Immersive drift', motion: 1.6 },
};

export function resolveCameraMotionProfile(profile, reducedMotion = false) {
  if (profile === 'system' && reducedMotion) return 0;
  return (CAMERA_MOTION_PROFILES[profile] ?? CAMERA_MOTION_PROFILES.system).motion;
}

export function resolveAuroraPalette(palette) {
  return AURORA_PALETTES[palette] ?? AURORA_PALETTES.classic;
}

/// Species. `dark`/`light` are the two ends of the needle gradient the
/// WebGL foliage shader mixes between per sprig — they are part of the
/// species, not a theme colour, because what separates a Nordmann from a
/// blue spruce at a glance is the colour of the needles, not its width.
/// A tree may still override them (`needleDark` / `needleLight`).
export const TREE_STYLES = {
  nordmann: {
    needle: 'secondary', density: 1.0, width: 1.0,
    dark: '#0c2013', light: '#3c6b2b', label: 'Nordmann (full)',
  },
  spruce: {
    needle: 'secondary', density: 0.85, width: 0.82,
    dark: '#0a1c18', light: '#2f5f43', label: 'Spruce (narrow)',
  },
  pine: {
    needle: 'secondary', density: 1.15, width: 1.12,
    dark: '#12210e', light: '#4d7a2c', label: 'Pine (broad)',
  },
  snowy: {
    needle: 'secondary', density: 1.0, width: 1.0, snow: 2.0, frost: 0.55,
    dark: '#152a24', light: '#4a7566', label: 'Snow-laden',
  },
  blue: {
    needle: 'secondary', density: 0.95, width: 0.9, frost: 0.4,
    dark: '#0d1c2b', light: '#4a7a92', label: 'Blue spruce',
  },
  golden: {
    needle: 'accent', density: 1.05, width: 1.0,
    dark: '#1d2410', light: '#7e8a34', label: 'Golden fir',
  },
};

/// A light string's appearance. Used by garlands, tree strings and the
/// mantel swag alike, so "red and blue, chasing" means the same thing
/// wherever it is set.
export function defaultLightStyle(overrides = {}) {
  return {
    palette: 'multicolor',
    // Only read when palette === 'custom'. Kept alongside rather than
    // replacing `palette`, so switching to a preset palette and back does
    // not lose the colours someone picked.
    customColors: ['#ff5d5d', '#ffc93c', '#3ddc97'],
    mode: 'twinkle',
    intensity: 1,
    size: 1,
    speed: 1,
    ...overrides,
  };
}

export function resolvePalette(style) {
  if (!style) return LIGHT_PALETTES.multicolor;
  if (style.palette === 'custom') {
    const colors = (style.customColors ?? []).filter(Boolean);
    return colors.length ? colors : LIGHT_PALETTES.multicolor;
  }
  return LIGHT_PALETTES[style.palette] ?? LIGHT_PALETTES.multicolor;
}

export function defaultTree(overrides = {}) {
  return {
    id: `tree-${Math.random().toString(36).slice(2, 8)}`,
    // x is a fraction of the screen width, so a layout survives a
    // resolution change or being moved to another monitor.
    x: 0.12,
    scale: 1,
    style: 'nordmann',
    flip: false,
    seed: Math.floor(Math.random() * 100000),
    lightsOn: true,
    lights: defaultLightStyle({ palette: 'warm', mode: 'twinkle' }),
    ornaments: 1,
    // 0 = matte painted baubles, 1 = mirror-glass. The same geometry
    // either way; only how much of the light rig it reflects changes.
    ornamentGloss: 1,
    // 'auto' takes the species' own needle colours (see TREE_STYLES);
    // anything else is a hex pair the shader uses verbatim, which is what
    // makes a black-and-gold or an all-white tree possible at all.
    needleColors: 'auto',
    needleDark: '#0c2013',
    needleLight: '#3c6b2b',
    snow: 1,
    // Rime on the outermost needles. 'auto' follows the species.
    frost: 'auto',
    // How much this particular tree moves in the shared wind field: a
    // tree tucked behind a wall does not sway like one on a ridge.
    sway: 1,
    ribbon: true,
    ribbonColor: '#c0392b',
    ribbonWidth: 1,
    ribbonTurns: 4,
    star: true,
    starSize: 1,
    starColor: '#fff0c2',
    ...overrides,
  };
}

/// The look of the scene as a whole: the grade the post chain applies,
/// the weather every layer answers to, and how much the camera drifts.
/// Separate from the element list because it is not a thing on the
/// screen, it is how everything on the screen is rendered — and because
/// all of it is a per-frame uniform, so changing any of it is free and
/// never rebuilds geometry.
export function defaultLook(overrides = {}) {
  return {
    exposure: 1,
    bloom: 0.85,
    saturation: 1,
    windStrength: 1,
    windGustiness: 1,
    windDirection: 0,
    cameraMotion: 1,
    cameraMotionProfile: 'system',
    ...overrides,
  };
}

/// Resolves a tree's needle colours: the species' own unless the tree has
/// been given explicit ones. One place, because both renderers and the
/// settings preview need the same answer.
export function resolveNeedles(tree) {
  const style = TREE_STYLES[tree?.style] ?? TREE_STYLES.nordmann;
  if (tree?.needleColors === 'custom') {
    return { dark: tree.needleDark ?? style.dark, light: tree.needleLight ?? style.light };
  }
  return { dark: style.dark, light: style.light };
}

export function resolveFrost(tree) {
  if (tree?.frost !== undefined && tree.frost !== 'auto') return Number(tree.frost) || 0;
  const style = TREE_STYLES[tree?.style] ?? TREE_STYLES.nordmann;
  return style.frost ?? 0.18;
}

export function defaultFireplace(overrides = {}) {
  return {
    id: `fire-${Math.random().toString(36).slice(2, 8)}`,
    x: 0.5,
    scale: 1,
    // 'rustic' (dry-stone surround, tall arched firebox, mantel beam) or
    // 'modern' (flat panel, suspended shelf, a wide linear flame) — see
    // decor.js's bakeFireplace/bakeModernSurround. A theme can set its own
    // default via themes/*.json's "fireplaceStyle"; each fireplace can
    // still override it individually here.
    fireplaceStyle: overrides.fireplaceStyle ?? 'rustic',
    stockings: true,
    mantelGarland: true,
    candles: true,
    lights: defaultLightStyle({ palette: 'warm', mode: 'twinkle' }),
    ...overrides,
  };
}

export function defaultGarland(overrides = {}) {
  return {
    enabled: true,
    sag: 1,
    spacing: 1,
    lights: defaultLightStyle(),
    ...overrides,
  };
}

export function defaultScreen(overrides = {}) {
  return {
    enabled: true,
    weatherProfile: 'winter',
    // 'inherit' means "use the global snow density"; a number overrides it,
    // so one screen can be a blizzard and another calm.
    snowDensity: 'inherit',
    look: defaultLook(),
    aurora: true,
    auroraIntensity: 1,
    auroraPalette: 'classic',
    stars: true,
    starDensity: 1,
    shootingStarFrequency: 1,
    icicles: true,
    snowGlitter: true,
    background: 'none', // 'none' | 'image'
    backgroundFit: 'cover', // cover | contain | stretch | tile
    backgroundOpacity: 1,
    garland: defaultGarland(),
    trees: [
      defaultTree({ x: 0.1, seed: 1337 }),
      defaultTree({ x: 0.9, seed: 90210, flip: true }),
    ],
    fireplaces: [defaultFireplace()],
    ...overrides,
  };
}

export function defaultScene() {
  return {
    screens: {
      // The primary screen gets the full composition; every other monitor
      // gets the trees and the sky but not a second fireplace, because
      // four identical fireplaces across a desk reads as duplication
      // rather than decoration. Both are editable per screen.
      0: defaultScreen(),
      default: defaultScreen({ fireplaces: [] }),
    },
  };
}

/// Resolves the composition for one monitor. A screen with no entry of its
/// own falls back to `default`, which is what makes a four-monitor setup
/// work out of the box while still allowing any single screen to be
/// customised without touching the others.
export function screenConfig(scene, index) {
  const screens = scene?.screens ?? {};
  const own = screens[String(index)];
  const fallback = screens.default;
  const base = defaultScreen();
  // Shallow merge per key, then per element list: a stored screen written
  // by an older version is missing the newest keys, and must pick up
  // their defaults rather than rendering as undefined.
  const merged = { ...base, ...(fallback ?? {}), ...(own ?? {}) };
  merged.look = { ...defaultLook(), ...(merged.look ?? {}) };
  merged.garland = { ...defaultGarland(), ...(merged.garland ?? {}) };
  merged.garland.lights = defaultLightStyle(merged.garland.lights ?? {});
  merged.trees = (merged.trees ?? []).map((t) => {
    const tree = { ...defaultTree(), ...t };
    tree.lights = defaultLightStyle(tree.lights ?? {});
    return tree;
  });
  merged.fireplaces = (merged.fireplaces ?? []).map((f) => {
    const fire = { ...defaultFireplace(), ...f };
    fire.lights = defaultLightStyle(fire.lights ?? {});
    return fire;
  });
  return merged;
}

/// Preset = a named snapshot of the whole look. Stored with the settings
/// so it survives a restart, and exportable as a plain JSON file so it can
/// be shared — which is also how a community theme would be distributed.
export function makePreset(name, settings) {
  return {
    id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    createdAt: new Date().toISOString(),
    settings: JSON.parse(JSON.stringify(settings)),
  };
}

/// How bright bulb `index` is at `time`, under the chosen animation mode.
///
/// Lives here, in the shared scene model, because BOTH renderers consume
/// it: the Canvas 2D garlands and the WebGL tree have to agree on what
/// "chase" means, or switching renderer would silently change the
/// animation. Pure arithmetic per bulb, no allocation.
export function bulbLevel(mode, time, index, phase = 0, count = 1, speed = 1) {
  time *= speed;
  switch (mode) {
    case 'steady':
      // Never fully flat: even mains-powered warm white breathes a little.
      return 0.92 + 0.08 * Math.sin(time * 0.9 + phase);
    case 'chase': {
      // A lit head running along the string, wrapping at the end.
      const head = (time * 3.4) % count;
      let d = Math.abs(index - head);
      d = Math.min(d, count - d);
      return 0.16 + 0.84 * Math.max(0, 1 - d / 3.2);
    }
    case 'wave':
      // A phase offset per bulb turns the shared sine into a travelling swell.
      return 0.32 + 0.68 * (0.5 + 0.5 * Math.sin(time * 2.4 - index * 0.55));
    case 'sparkle': {
      // Mostly off, with short bright flashes — the "twinkle" setting on a
      // real light string, as opposed to a slow fade.
      const f = Math.sin(time * 2.7 + phase * 3.1);
      return 0.2 + 0.8 * Math.max(0, f) ** 6;
    }
    case 'twinkle':
    default:
      return 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 1.7 + phase));
  }
}
