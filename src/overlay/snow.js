// Snow + desktop decorations renderer. No Tauri-only APIs are used in the
// render path itself, so this file is directly testable via Playwright by
// loading index.html from a plain static server (see docs/ARCHITECTURE.md,
// section 5). Loading the initial theme/settings and reacting to live
// changes (below) does use the shared bridge, which itself no-ops outside
// Tauri.

import { getSettings, listThemes, onSettingsChanged } from '../shared/bridge.js';
import { drawGarland, drawTrees, drawFireplace, GARLAND_PALETTES } from './decor.js';

const canvas = document.getElementById('snow');
const ctx = canvas.getContext('2d');

let flakes = [];
let config = {
  density: 120,
  wind: 0.3,
  flakeSize: 3,
  accumulate: true,
  color: '#ffffff',
};

// Decorations are independent of the snow theme config: they come from
// AppSettings (user toggles), not the theme file, and only render on one
// overlay window — see isPrimaryOverlay() below — so a multi-monitor setup
// gets one decorated "scene", not the same trees repeated on every screen.
let decorConfig = { trees: true, garlands: true, fireplace: true, garlandStyle: 'multicolor' };
let themeColors = { primary: '#c0392b', secondary: '#1e7d32', accent: '#f1c40f' };

let accumulation = []; // per-column snow height, only used when accumulate=true
let running = true;
let rafId = null;
const clock = { start: performance.now() };

// A soft glow dot, pre-rendered once into an offscreen canvas and reused
// via drawImage() for every "soft dot" flake. Doing the blur once here
// instead of a live ctx.shadowBlur on every flake, every frame, is what
// keeps a few hundred glowing flakes cheap enough not to weigh down the
// CPU/GPU — shadowBlur per-shape at that scale is a well-known canvas
// performance trap.
const FLAKE_SPRITE_SIZE = 48;
const flakeSprite = document.createElement('canvas');
flakeSprite.width = FLAKE_SPRITE_SIZE;
flakeSprite.height = FLAKE_SPRITE_SIZE;
function renderFlakeSprite(color) {
  const sctx = flakeSprite.getContext('2d');
  sctx.clearRect(0, 0, FLAKE_SPRITE_SIZE, FLAKE_SPRITE_SIZE);
  const c = FLAKE_SPRITE_SIZE / 2;
  const gradient = sctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.55, color);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  sctx.fillStyle = gradient;
  sctx.beginPath();
  sctx.arc(c, c, c, 0, Math.PI * 2);
  sctx.fill();
}
renderFlakeSprite(config.color);

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  accumulation = new Array(Math.ceil(canvas.width / 4)).fill(0);
}
window.addEventListener('resize', resize);
resize();

function makeFlake() {
  const isCrystal = Math.random() < 0.35; // a minority render as a faceted crystal instead of a soft dot
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    r: config.flakeSize * (0.5 + Math.random()),
    speed: 0.6 + Math.random() * 1.4,
    drift: Math.random() * Math.PI * 2,
    opacity: 0.5 + Math.random() * 0.5,
    isCrystal,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.02,
  };
}

export function setDensity(density) {
  config.density = density;
  if (flakes.length < density) {
    while (flakes.length < density) flakes.push(makeFlake());
  } else {
    flakes.length = density;
  }
}

export function setConfig(partial) {
  config = { ...config, ...partial };
  setDensity(config.density);
}

export function getParticleCount() {
  return flakes.length;
}

export function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
}

export function start() {
  if (!running) {
    running = true;
    tick();
  }
}

/// Draws one snowflake. Small flakes stay cheap soft dots; larger ones get
/// a faceted six-branch crystal outline for a more "real snowflake" look,
/// gently rotating as they fall.
function drawFlake(f) {
  ctx.globalAlpha = f.opacity;

  if (!f.isCrystal || f.r < 1.6) {
    // Soft, slightly-out-of-focus dot via the pre-rendered sprite (see
    // above) instead of a flat circle — cheap regardless of flake count.
    const size = f.r * 4;
    ctx.drawImage(flakeSprite, f.x - size / 2, f.y - size / 2, size, size);
    return;
  }

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.rotation);
  ctx.strokeStyle = config.color;
  ctx.lineWidth = Math.max(0.6, f.r * 0.18);
  ctx.lineCap = 'round';
  const branchLen = f.r * 2.2;
  for (let b = 0; b < 6; b++) {
    ctx.save();
    ctx.rotate((Math.PI / 3) * b);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -branchLen);
    ctx.moveTo(0, -branchLen * 0.55);
    ctx.lineTo(branchLen * 0.28, -branchLen * 0.75);
    ctx.moveTo(0, -branchLen * 0.55);
    ctx.lineTo(-branchLen * 0.28, -branchLen * 0.75);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function tick() {
  if (!running) return;
  const time = (performance.now() - clock.start) / 1000;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (decorConfig.garlands) {
    const palette = GARLAND_PALETTES[decorConfig.garlandStyle] ?? GARLAND_PALETTES.multicolor;
    drawGarland(ctx, canvas.width, time, palette);
  }
  if (decorConfig.trees) {
    drawTrees(ctx, canvas.width, canvas.height, themeColors);
  }
  if (decorConfig.fireplace) {
    drawFireplace(ctx, canvas.width, canvas.height, time);
  }

  for (const f of flakes) {
    f.y += f.speed;
    f.drift += 0.01;
    f.x += Math.sin(f.drift) * config.wind;
    f.rotation += f.spin;

    const col = Math.max(0, Math.min(accumulation.length - 1, Math.floor(f.x / 4)));
    const groundY = config.accumulate
      ? canvas.height - accumulation[col]
      : canvas.height;

    if (f.y > groundY) {
      if (config.accumulate && accumulation[col] < 60) {
        accumulation[col] += 0.15;
      }
      Object.assign(f, makeFlake(), { y: -10 });
    }

    drawFlake(f);
  }
  ctx.globalAlpha = 1;

  if (config.accumulate) {
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    for (let i = 0; i < accumulation.length; i++) {
      ctx.lineTo(i * 4, canvas.height - accumulation[i]);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fillStyle = config.color;
    ctx.fill();

    // A faint bluish shadow just under the ridge line reads as depth in
    // the snow rather than a flat white shelf.
    ctx.strokeStyle = 'rgba(150,180,210,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < accumulation.length; i++) {
      const x = i * 4;
      const y = canvas.height - accumulation[i];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  rafId = requestAnimationFrame(tick);
}

setDensity(config.density);
tick();

// Expose for Playwright / manual debugging without a module bundler step.
window.snowOverlay = { setDensity, setConfig, getParticleCount, start, stop };

/// Only one overlay window (per app launch, whichever monitor got
/// "overlay-0") draws the trees/garland/fireplace scene. With one overlay
/// window per monitor, drawing the same full-size decorations on every
/// screen would look like duplicated clutter rather than one decorated
/// desktop. Falls back to true when not running inside Tauri (standalone
/// page / Playwright), so the decorations stay visible and testable there.
function isPrimaryOverlay() {
  if (typeof window.__TAURI__ === 'undefined') return true;
  try {
    return window.__TAURI__.window.getCurrentWindow().label === 'overlay-0';
  } catch {
    return true;
  }
}

// Apply the theme's snow settings and the user's decoration toggles. A
// user-chosen density overrides the theme's own default so the settings
// window's slider stays authoritative.
function applyThemeAndSettings(theme, settings) {
  if (!theme) return;
  setConfig({
    density: settings?.snowDensity ?? theme.snow.density,
    wind: settings?.snowWind ?? theme.snow.wind,
    flakeSize: theme.snow.flakeSize,
    accumulate: settings?.snowAccumulate ?? theme.snow.accumulate,
  });
  themeColors = theme.colors;
  const primary = isPrimaryOverlay();
  decorConfig = {
    trees: primary && (settings?.treesDecoration ?? true),
    garlands: primary && (settings?.garlandsDecoration ?? true),
    fireplace: primary && (settings?.fireplaceDecoration ?? true),
    garlandStyle: settings?.garlandStyle ?? 'multicolor',
  };
}

async function initFromBackend() {
  try {
    const [themes, settings] = await Promise.all([listThemes(), getSettings()]);
    const theme = themes.find((t) => t.id === settings.themeId) ?? themes[0];
    applyThemeAndSettings(theme, settings);
  } catch (err) {
    // Overlay still renders with the built-in defaults above even if the
    // initial fetch fails (e.g. standalone Playwright run), rather than
    // showing a blank screen.
    console.error('Failed to load initial theme/settings for overlay:', err);
  }
}

// Exposed so tests (and anything else driving this page from the outside)
// can await the initial theme/settings load before asserting on state or
// calling setDensity() themselves — otherwise the async fetch above could
// resolve afterwards and silently overwrite a value the caller just set.
window.snowOverlayReady = initFromBackend();

// Live updates: react immediately when the settings window saves a new
// theme or density, instead of requiring an app restart.
onSettingsChanged(({ theme, settings }) => {
  applyThemeAndSettings(theme, settings);
});
