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

export const TREE_STYLES = {
  nordmann: { needle: 'secondary', density: 1.0, width: 1.0, label: 'Nordmann (full)' },
  spruce: { needle: 'secondary', density: 0.85, width: 0.82, label: 'Spruce (narrow)' },
  pine: { needle: 'secondary', density: 1.15, width: 1.12, label: 'Pine (broad)' },
  snowy: { needle: 'secondary', density: 1.0, width: 1.0, snow: 2.0, label: 'Snow-laden' },
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
    snow: 1,
    ribbon: true,
    star: true,
    ...overrides,
  };
}

export function defaultFireplace(overrides = {}) {
  return {
    id: `fire-${Math.random().toString(36).slice(2, 8)}`,
    x: 0.5,
    scale: 1,
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
    // 'inherit' means "use the global snow density"; a number overrides it,
    // so one screen can be a blizzard and another calm.
    snowDensity: 'inherit',
    aurora: true,
    auroraIntensity: 1,
    stars: true,
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
