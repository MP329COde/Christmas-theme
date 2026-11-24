// Le schéma de la scène : ce qui peut être mis sur un écran, et comment il est décrit.
//
// C'est la source unique de vérité pour la composition, partagée par la
// fenêtre des paramètres (qui la modifie) et la superposition (qui la rend).
// Le côté Rust la stocke comme JSON opaque précisément pour que ce fichier
// possède le contrôle du format — voir le commentaire sur AppSettings::scene.
//
// STRUCTURE
//
//   scene.screens["0"]        composition par moniteur, indexée par overlay
//   scene.screens.default     utilisée par tout moniteur sans entrée propre
//
// Un écran contient des LISTES d'éléments plutôt que des booléens, ce qui
// rend possible « deux sapins sur l'écran de gauche et une cheminée sur le droit ».
// Chaque élément porte sa propre position, taille et style de lumière,
// rien n'est donc plus codé en dur dans un coin.

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

export const LIGHT_PALETTE_LABELS = {
  multicolor: 'Multicolore', warm: 'Blanc chaud', cool: 'Blanc froid', 'red-green': 'Rouge et vert',
  'red-blue': 'Rouge et bleu', candy: 'Sucre d\'orge', ice: 'Glace', gold: 'Or',
};

export const LIGHT_MODE_LABELS = {
  twinkle: 'Scintillement', sparkle: 'Étincelles', chase: 'Poursuite', wave: 'Vague',
  pulse: 'Pulsation', shimmer: 'Chatoiement', steady: 'Fixe',
};

export const AURORA_PALETTE_LABELS = {
  classic: 'Classique', emerald: 'Émeraude', arctic: 'Arctique', twilight: 'Crépuscule',
};

export const LIGHT_MODES = ['twinkle', 'sparkle', 'chase', 'wave', 'pulse', 'shimmer', 'steady'];

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
  custom: {
    colors: ['#5cffb0', '#82ebff', '#d678ff'],
    haze: ['#40be8c', '#50aadc', '#965ad2'],
  },
};

export const BACKGROUND_PALETTES = {
  midnight: { label: 'Bleu lunaire', sky: '#06101f', horizon: '#48677d', snow: '#b5cee0' },
  glacier: { label: 'Bleu glacier', sky: '#071c26', horizon: '#518b96', snow: '#c6e5e6' },
  twilight: { label: 'Crépuscule hivernal', sky: '#20162e', horizon: '#9c748c', snow: '#e0d0e1' },
  festive: { label: 'Rouge de fête', sky: '#1c0a10', horizon: '#8c3b3b', snow: '#f1dcd2' },
  emerald: { label: 'Vert sapin', sky: '#06170f', horizon: '#3f7a5c', snow: '#d5e8dc' },
  dawn: { label: 'Aube dorée', sky: '#1a2238', horizon: '#d99a6c', snow: '#f4e3d3' },
};

/// Lighten/darken a hex colour by a percentage, returning a hex string.
function shadeHex(hex, amt) {
  const value = hex.slice(1);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const rgb = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  const d = Math.round((amt / 100) * 255);
  return `#${rgb.map((c) => clamp(c + d).toString(16).padStart(2, '0')).join('')}`;
}

/// Recettes météo coordonnées par écran. Les valeurs numériques sont
/// des multiplicateurs appliqués aux contrôles globaux de neige de l'utilisateur,
/// préservant une ligne de base tout en permettant à chaque écran
/// d'avoir ses propres conditions.
export const WEATHER_PROFILES = {
  calm: { label: 'Calme', flakeScale: 0.7, wind: 0.35, accumulate: 0.45, glitterDensity: 0.45 },
  gentle: { label: 'Neige légère', flakeScale: 0.9, wind: 0.7, accumulate: 0.8, glitterDensity: 0.8 },
  winter: { label: 'Jour d\'hiver', flakeScale: 1, wind: 1, accumulate: 1, glitterDensity: 1 },
  blizzard: { label: 'Blizzard', flakeScale: 1.35, wind: 1.65, accumulate: 1.5, glitterDensity: 1.35 },
};

export function resolveWeatherProfile(profile) {
  return WEATHER_PROFILES[profile] ?? WEATHER_PROFILES.winter;
}

export const CAMERA_MOTION_PROFILES = {
  system: { label: 'Préférence système', motion: 1 },
  still: { label: 'Fixe', motion: 0 },
  gentle: { label: 'Dérive douce', motion: 0.45 },
  cinematic: { label: 'Dérive cinématique', motion: 1 },
  immersive: { label: 'Dérive immersive', motion: 1.6 },
};

export function resolveCameraMotionProfile(profile, reducedMotion = false) {
  if (profile === 'system' && reducedMotion) return 0;
  return (CAMERA_MOTION_PROFILES[profile] ?? CAMERA_MOTION_PROFILES.system).motion;
}

export function resolveAuroraPalette(palette, customColors = null) {
  if (palette === 'custom' && customColors?.colors?.length === 3) {
    return {
      colors: customColors.colors,
      haze: customColors.haze ?? customColors.colors.map((c) => shadeHex(c, -22)),
    };
  }
  return AURORA_PALETTES[palette] ?? AURORA_PALETTES.classic;
}

/// Essences. `dark`/`light` sont les deux extrémités du dégradé d'aiguilles que
/// le shader de feuillage WebGL mélange par brin — elles font partie de
/// l'essence, pas d'une couleur de thème, car ce qui distingue un Nordmann
/// d'un épicéa bleu d'un coup d'oeil est la couleur des aiguilles, pas leur largeur.
/// Un sapin peut toujours les surcharger (`needleDark` / `needleLight`).
export const TREE_STYLES = {
  nordmann: {
    needle: 'secondary', density: 1.0, width: 1.0,
    dark: '#0c2013', light: '#3c6b2b', label: 'Nordmann (dense)',
  },
  spruce: {
    needle: 'secondary', density: 0.85, width: 0.82,
    dark: '#0a1c18', light: '#2f5f43', label: 'Épicéa (étroit)',
  },
  pine: {
    needle: 'secondary', density: 1.15, width: 1.12,
    dark: '#12210e', light: '#4d7a2c', label: 'Pin (large)',
  },
  snowy: {
    needle: 'secondary', density: 1.0, width: 1.0, snow: 2.0, frost: 0.55,
    dark: '#152a24', light: '#4a7566', label: 'Chargé de neige',
  },
  blue: {
    needle: 'secondary', density: 0.95, width: 0.9, frost: 0.4,
    dark: '#0d1c2b', light: '#4a7a92', label: 'Picea bleu',
  },
  golden: {
    needle: 'accent', density: 1.05, width: 1.0,
    dark: '#1d2410', light: '#7e8a34', label: 'Sapin doré',
  },
};

export const HOLIDAY_DECORATION_TYPES = {
  snowman: { label: 'Bonhomme de neige', glyph: '⛄', y: 0.84 },
  presents: { label: 'Cadeaux', glyph: '🎁', y: 0.88 },
  wreath: { label: 'Couronne', glyph: '🎀', y: 0.24 },
  'candy-cane': { label: 'Sucre d\'orge', glyph: '🍬', y: 0.86 },
  lantern: { label: 'Lanterne', glyph: '🏮', y: 0.87 },
  reindeer: { label: 'Renne', glyph: '🦌', y: 0.84 },
  bell: { label: 'Cloches', glyph: '🔔', y: 0.2 },
  star: { label: 'Étoile lumineuse', glyph: '🌟', y: 0.16 },
  gingerbread: { label: 'Bonhomme en pain d\'épices', glyph: '🍪', y: 0.86 },
  sleigh: { label: 'Traîneau', glyph: '🛷', y: 0.87 },
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

export function defaultHolidayDecoration(overrides = {}) {
  const type = HOLIDAY_DECORATION_TYPES[overrides.type] ? overrides.type : 'presents';
  return {
    id: `holiday-${Math.random().toString(36).slice(2, 8)}`,
    type,
    x: 0.5,
    y: HOLIDAY_DECORATION_TYPES[type].y,
    scale: 1,
    // 'theme' suit les couleurs du thème ; sinon une couleur hexadécimale
    // qui remplace la teinte principale de cette décoration.
    color: 'theme',
    flip: false,
    opacity: 1,
    ...overrides,
    type,
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
    ambientWarmth: 1,
    fireplaceContribution: 1,
    shadowStrength: 1,
    shadowSoftness: 1,
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
    // 'classic' (briques, manteau peint), 'rustic' (pierre sèche, poutre) ou
    // 'modern' (panneau plat, étagère suspendue) — voir bakeFireplace dans
    // decor.js. Un thème peut définir le sien via "fireplaceStyle" ;
    // chaque cheminée peut le remplacer individuellement.
    fireplaceStyle: overrides.fireplaceStyle ?? 'classic',
    // Style « classique » : teinte des briques (red | ochre | grey | white)
    // et couleur du manteau ; intensité du feu pour tous les styles.
    brick: 'red',
    mantelColor: '#ece6d8',
    flameIntensity: 1,
    stockings: true,
    mantelGarland: true,
    candles: true,
    // Garnitures optionnelles : couronne au-dessus du manteau (style
    // classique) et pare-feu devant le foyer.
    wreath: false,
    fireScreen: false,
    lights: defaultLightStyle({ palette: 'warm', mode: 'twinkle' }),
    ...overrides,
  };
}

export function defaultGarland(overrides = {}) {
  return {
    enabled: true,
    // Voir GARLAND_STYLES : même câble, rendu différent.
    style: 'classic',
    // Nombre de festons entre deux points d'accroche.
    swags: 3,
    bulbShape: 'drop', // drop | round | star | globe
    glow: 1,
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
    auroraCustomColors: { colors: ['#5cffb0', '#82ebff', '#d678ff'], haze: ['#40be8c', '#50aadc', '#965ad2'] },
    stars: true,
    starDensity: 1,
    shootingStarFrequency: 1,
    icicles: true,
    snowGlitter: true,
    background: 'none', // none | image | animated-forest | alpine-lake
    backgroundImageKey: null,
    backgroundFit: 'cover', // cover | contain | stretch | tile
    backgroundOpacity: 1,
    backgroundAnimation: 'drift', // none | drift | kenburns
    backgroundMotion: 1,
    backgroundPalette: 'midnight',
    backgroundSky: '#06101f',
    backgroundHorizon: '#48677d',
    backgroundSnow: '#b5cee0',
    backgroundFog: 0.45,
    backgroundMoon: 1,
    backgroundMoonX: 0.78,
    backgroundMoonY: 0.18,
    garland: defaultGarland(),
    trees: [
      defaultTree({ x: 0.1, seed: 1337 }),
      defaultTree({ x: 0.9, seed: 90210, flip: true }),
    ],
    decorations: [],
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
  // Materialised per-screen edits retain the inherited image reference;
  // selecting a new file later gives that screen its own storage key.
  merged.backgroundImageKey = own?.backgroundImageKey
    ?? (own?.background === 'image' ? `screen-${index}` : null)
    ?? fallback?.backgroundImageKey
    ?? (fallback?.background === 'image' ? 'screen-default' : `screen-${index}`);
  merged.look = { ...defaultLook(), ...(merged.look ?? {}) };
  merged.garland = { ...defaultGarland(), ...(merged.garland ?? {}) };
  merged.garland.lights = defaultLightStyle(merged.garland.lights ?? {});
  merged.trees = (merged.trees ?? []).map((t) => {
    const tree = { ...defaultTree(), ...t };
    tree.lights = defaultLightStyle(tree.lights ?? {});
    return tree;
  });
  merged.decorations = (merged.decorations ?? []).map((d) => defaultHolidayDecoration(d));
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
export function makePreset(name, settings, thumbnail = null) {
  return {
    id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    createdAt: new Date().toISOString(),
    // A small dataURL rendering of the look, so a preset list reads at a
    // glance instead of by name alone. Optional: older presets and
    // imports from before this existed simply show no thumbnail.
    thumbnail,
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
    case 'pulse':
      // A whole string breathing in and out together, like a dimmer cycle.
      return 0.22 + 0.78 * (0.5 + 0.5 * Math.sin(time * 2.1 + phase * 0.35));
    case 'shimmer': {
      // Fast high-frequency flicker with a floor still high enough that the
      // string reads as energized rather than randomly switching off.
      const flicker = 0.5 + 0.5 * Math.sin(time * 8.5 + index * 0.9 + phase * 2.2);
      return 0.3 + 0.7 * flicker * flicker;
    }
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

// ---------------------------------------------------------------------------
// guirlandes, fonds animés, modes et profils de performance
// ---------------------------------------------------------------------------

export const GARLAND_STYLES = {
  classic: { label: 'Ampoules rétro' },
  pine: { label: 'Branches de sapin' },
  curtain: { label: 'Rideau lumineux' },
  tinsel: { label: 'Guirlande scintillante' },
  bunting: { label: 'Fanions de fête' },
};

export const BULB_SHAPES = {
  drop: 'Goutte', round: 'Ronde', globe: 'Globe', star: 'Étoile',
};

/// Fonds animés procéduraux (background.js). Tous sont cuits une fois en
/// calques puis animés par simples copies : leur coût par image est fixe.
export const ANIMATED_BACKGROUNDS = {
  'animated-forest': { label: 'Forêt hivernale illuminée' },
  'alpine-lake': { label: 'Lac alpin gelé' },
  village: { label: 'Village enneigé' },
  'sleigh-night': { label: 'Nuit du traîneau' },
  bokeh: { label: 'Lumières de fête (moderne)' },
  'aurora-gradient': { label: 'Dégradé boréal (moderne)' },
};

export function isAnimatedBackground(id) {
  return Object.prototype.hasOwnProperty.call(ANIMATED_BACKGROUNDS, id);
}

/// Où la décoration se place par rapport aux fenêtres.
export const DISPLAY_MODES = {
  wallpaper: { label: 'Fond d\'écran', hint: 'Derrière vos fenêtres, sur le bureau' },
  front: { label: 'Par-dessus tout', hint: 'La neige tombe devant vos fenêtres, sans gêner les clics' },
};

export const DOCK_PLACEMENTS = {
  behind: { label: 'Derrière les fenêtres', hint: 'La bande reste sous vos fenêtres et ne gêne rien' },
  front: { label: 'Par-dessus tout', hint: 'La bande passe devant les fenêtres, sans gêner les clics' },
};

/// Profils de performance. C'est LE réglage qui décide si les ventilateurs
/// se déclenchent : cadence, résolution interne (plafond de DPR), palier de
/// qualité minimal imposé et moteur des sapins. « custom » laisse la main
/// aux réglages détaillés (fpsLimit / renderer).
export const PERFORMANCE_PROFILES = {
  eco: {
    label: 'Silencieux', hint: 'Ventilateurs au repos : 15 i/s, graphismes allégés',
    fpsLimit: 15, dprCap: 1, minTier: 2, renderer: 'canvas', dockFps: 8, snowScale: 0.5, motion: 0.6,
  },
  balanced: {
    label: 'Équilibré', hint: 'Recommandé : 30 i/s, qualité adaptée automatiquement',
    fpsLimit: 30, dprCap: 1.5, minTier: 0, renderer: 'auto', dockFps: 20, snowScale: 1, motion: 1,
  },
  quality: {
    label: 'Qualité maximale', hint: '60 i/s et tous les détails : pour les machines puissantes',
    fpsLimit: 60, dprCap: 2, minTier: 0, renderer: 'auto', dockFps: 30, snowScale: 1, motion: 1,
  },
};

export function resolvePerformance(settings) {
  const profile = PERFORMANCE_PROFILES[settings?.performanceMode];
  if (profile) return { mode: settings.performanceMode, ...profile };
  return {
    mode: 'custom',
    fpsLimit: Number(settings?.fpsLimit ?? 30) || 0,
    dprCap: Number(settings?.dprCap ?? 2) || 2,
    minTier: Number(settings?.minTier ?? 0) || 0,
    renderer: settings?.renderer ?? 'auto',
    dockFps: 30,
    snowScale: 1,
    motion: 1,
  };
}

/// Modes : une composition complète en un clic. Chaque mode réécrit
/// l'écran visé à partir de defaultScreen, et peut ajuster quelques
/// réglages globaux (neige, thème). Rien de définitif : tout reste
/// modifiable ensuite.
export const SCENE_MODES = {
  cosy: {
    label: 'Coin du feu', glyph: '🔥', hint: 'Cheminée, sapins et guirlande de sapin',
    global: { snowDensity: 120, themeId: 'classic-red' },
    screen: () => defaultScreen({
      garland: defaultGarland({ style: 'pine', lights: defaultLightStyle({ palette: 'warm' }) }),
      decorations: [defaultHolidayDecoration({ type: 'presents', x: 0.28 })],
    }),
  },
  forest: {
    label: 'Forêt enchantée', glyph: '🌲', hint: 'Forêt animée, aurore et sapins givrés',
    global: { snowDensity: 180, themeId: 'frosty-blue' },
    screen: () => defaultScreen({
      background: 'animated-forest', fireplaces: [],
      trees: [
        defaultTree({ x: 0.08, seed: 11, style: 'snowy', scale: 1.15 }),
        defaultTree({ x: 0.24, seed: 23, style: 'blue', scale: 0.8 }),
        defaultTree({ x: 0.9, seed: 37, style: 'spruce', flip: true }),
      ],
      garland: defaultGarland({ style: 'curtain', lights: defaultLightStyle({ palette: 'ice', mode: 'shimmer' }) }),
      decorations: [defaultHolidayDecoration({ type: 'reindeer', x: 0.62 })],
    }),
  },
  village: {
    label: 'Village de Noël', glyph: '🏘️', hint: 'Village enneigé, lanternes et bonhomme de neige',
    global: { snowDensity: 160, themeId: 'midnight-gold' },
    screen: () => defaultScreen({
      background: 'village', aurora: false, fireplaces: [],
      trees: [defaultTree({ x: 0.9, seed: 5, flip: true, lights: defaultLightStyle({ palette: 'gold' }) })],
      garland: defaultGarland({ style: 'classic', bulbShape: 'globe', lights: defaultLightStyle({ palette: 'warm', mode: 'steady' }) }),
      decorations: [
        defaultHolidayDecoration({ type: 'snowman', x: 0.16 }),
        defaultHolidayDecoration({ type: 'lantern', x: 0.3 }),
      ],
    }),
  },
  party: {
    label: 'Fête', glyph: '🎉', hint: 'Lumières multicolores, fanions et cadeaux',
    global: { snowDensity: 120, themeId: 'candy-cane' },
    screen: () => defaultScreen({
      background: 'bokeh', aurora: false, stars: false, fireplaces: [],
      trees: [
        defaultTree({ x: 0.12, seed: 71, lights: defaultLightStyle({ palette: 'multicolor', mode: 'chase' }) }),
        defaultTree({ x: 0.88, seed: 72, flip: true, lights: defaultLightStyle({ palette: 'multicolor', mode: 'chase' }) }),
      ],
      garland: defaultGarland({ style: 'bunting', lights: defaultLightStyle({ palette: 'multicolor', mode: 'wave' }) }),
      decorations: [
        defaultHolidayDecoration({ type: 'presents', x: 0.3 }),
        defaultHolidayDecoration({ type: 'candy-cane', x: 0.7 }),
        defaultHolidayDecoration({ type: 'bell', x: 0.5 }),
      ],
    }),
  },
  polar: {
    label: 'Nuit polaire', glyph: '🌌', hint: 'Traîneau devant la lune, étoiles et aurore',
    global: { snowDensity: 90, themeId: 'arctic-aurora' },
    screen: () => defaultScreen({
      background: 'sleigh-night', fireplaces: [], icicles: true,
      auroraPalette: 'arctic', starDensity: 1.5,
      trees: [defaultTree({ x: 0.92, seed: 404, style: 'snowy', flip: true })],
      garland: defaultGarland({ style: 'tinsel', lights: defaultLightStyle({ palette: 'cool', mode: 'sparkle' }) }),
    }),
  },
  minimal: {
    label: 'Minimal', glyph: '❄️', hint: 'Seulement la neige, discrète et légère',
    global: { snowDensity: 60, themeId: 'minimal-white', snowAccumulate: false },
    screen: () => defaultScreen({
      aurora: false, stars: false, icicles: false, snowGlitter: false,
      trees: [], fireplaces: [], decorations: [],
      garland: defaultGarland({ enabled: false }),
    }),
  },
};

/// Applique un mode à `settings` (en place) pour l'écran donné, ou pour
/// tous les écrans connus si `screen` vaut null.
export function applySceneMode(settings, modeId, screen = null) {
  const mode = SCENE_MODES[modeId];
  if (!mode) return false;
  if (!settings.scene?.screens) settings.scene = defaultScene();
  const keys = screen === null ? Object.keys(settings.scene.screens) : [String(screen)];
  for (const key of keys) {
    const next = mode.screen();
    // Un seul foyer sur un bureau multi-écran : seul l'écran 0 le garde.
    if (screen === null && key !== '0') next.fireplaces = [];
    settings.scene.screens[key] = next;
  }
  Object.assign(settings, mode.global);
  settings.sceneMode = modeId;
  return true;
}
