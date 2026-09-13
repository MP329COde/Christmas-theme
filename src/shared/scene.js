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
