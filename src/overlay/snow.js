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

// Flake sprites, pre-rendered once into offscreen canvases and reused via
// drawImage(). Doing the falloff once here instead of a live
// ctx.shadowBlur on every flake, every frame, is what keeps a few hundred
// glowing flakes cheap enough not to weigh down the CPU/GPU — shadowBlur
// per-shape at that scale is a well-known canvas performance trap.
//
// Three softness levels give the snow depth of field: distant flakes stay
// small and fairly crisp, near ones are large and bloom out of focus, the
// way real snow does between a camera and the background.
const FLAKE_SPRITE_SIZE = 64;
const FLAKE_SOFTNESS = [0.72, 0.5, 0.24]; // far -> near: core radius fraction
const flakeSprites = FLAKE_SOFTNESS.map((coreStop) => {
  const cv = document.createElement('canvas');
  cv.width = FLAKE_SPRITE_SIZE;
  cv.height = FLAKE_SPRITE_SIZE;
  const sctx = cv.getContext('2d');
  const c = FLAKE_SPRITE_SIZE / 2;
  const gradient = sctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(coreStop, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  sctx.fillStyle = gradient;
  sctx.beginPath();
  sctx.arc(c, c, c, 0, Math.PI * 2);
  sctx.fill();
  return cv;
});

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  accumulation = new Array(Math.ceil(canvas.width / 4)).fill(0);
}
window.addEventListener('resize', resize);
resize();

function makeFlake() {
  // depth: 0 = far away, 1 = close to the viewer. Everything else about a
  // flake follows from it, which is what sells the sense of volume: near
  // flakes are big, fast, bright and out of focus; distant ones are small,
  // slow, dim and slightly blue from the air between.
  const depth = Math.random() ** 1.6; // biased toward distant: fewer big foreground flakes
  const layer = depth > 0.72 ? 2 : depth > 0.38 ? 1 : 0;
  // Only mid/near flakes are ever detailed crystals — a distant flake is
  // too small for the shape to read, so drawing one is wasted work.
  const isCrystal = depth > 0.45 && Math.random() < 0.4;
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    depth,
    layer,
    r: config.flakeSize * (0.35 + depth * 1.5) * (0.75 + Math.random() * 0.5),
    speed: (0.35 + depth * 1.5) * (0.8 + Math.random() * 0.5),
    drift: Math.random() * Math.PI * 2,
    driftRate: 0.006 + Math.random() * 0.012,
    opacity: 0.35 + depth * 0.6,
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

/// Draws one snowflake, scaled and softened by its depth. Distant flakes
/// are cheap soft dots; nearer ones can be faceted six-branch crystals
/// with side-branches, gently rotating as they fall.
function drawFlake(f) {
  ctx.globalAlpha = f.opacity;

  if (!f.isCrystal || f.r < 2.2) {
    // Pre-rendered sprite, picked by depth layer so near flakes bloom
    // out of focus and far ones stay tight — cheap regardless of count.
    const size = f.r * 4;
    ctx.drawImage(flakeSprites[f.layer], f.x - size / 2, f.y - size / 2, size, size);
    return;
  }

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.rotation);
  ctx.strokeStyle = config.color;
  ctx.lineWidth = Math.max(0.7, f.r * 0.16);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const branchLen = f.r * 2.1;
  for (let b = 0; b < 6; b++) {
    ctx.save();
    ctx.rotate((Math.PI / 3) * b);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -branchLen);
    // Two pairs of side branches at different heights, plus a small tip
    // fork — that asymmetry along the arm is what makes the silhouette
    // read as a dendrite rather than an asterisk.
    ctx.moveTo(0, -branchLen * 0.42);
    ctx.lineTo(branchLen * 0.3, -branchLen * 0.62);
    ctx.moveTo(0, -branchLen * 0.42);
    ctx.lineTo(-branchLen * 0.3, -branchLen * 0.62);
    ctx.moveTo(0, -branchLen * 0.68);
    ctx.lineTo(branchLen * 0.2, -branchLen * 0.83);
    ctx.moveTo(0, -branchLen * 0.68);
    ctx.lineTo(-branchLen * 0.2, -branchLen * 0.83);
    ctx.stroke();
    ctx.restore();
  }
  // Tiny bright core so the crystal doesn't look hollow.
  ctx.globalAlpha = f.opacity * 0.8;
  ctx.fillStyle = config.color;
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(0.8, f.r * 0.3), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/// Advances one flake and recycles it once it lands. Kept separate from
/// drawing so the scene can be composited in depth order (far snow, then
/// the decorations, then near snow) while each flake is still stepped
/// exactly once per frame.
function stepFlake(f) {
  f.y += f.speed;
  f.drift += f.driftRate;
  // Nearer flakes are pushed further by the same wind, which is what makes
  // the layers visibly separate instead of moving as one sheet.
  f.x += Math.sin(f.drift) * config.wind * (0.35 + f.depth * 1.3);
  f.rotation += f.spin;

  if (f.x < -40) f.x = canvas.width + 40;
  else if (f.x > canvas.width + 40) f.x = -40;

  const col = Math.max(0, Math.min(accumulation.length - 1, Math.floor(f.x / 4)));
  const groundY = config.accumulate ? canvas.height - accumulation[col] : canvas.height;

  if (f.y > groundY) {
    if (config.accumulate && accumulation[col] < 60) {
      accumulation[col] += 0.15;
    }
    Object.assign(f, makeFlake(), { y: -10 });
  }
}

function tick() {
  if (!running) return;
  const time = (performance.now() - clock.start) / 1000;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Step every flake first, then draw in depth order: distant snow sits
  // behind the trees and fireplace, close snow passes in front of them.
  for (const f of flakes) stepFlake(f);

  for (const f of flakes) {
    if (f.layer === 0) drawFlake(f);
  }
  ctx.globalAlpha = 1;

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
    if (f.layer !== 0) drawFlake(f);
  }
  ctx.globalAlpha = 1;

  if (config.accumulate) {
    // Smooth the drift profile before drawing: raw per-column heights give
    // a noisy sawtooth, whereas real settled snow has soft rolling banks.
    const ridge = [];
    for (let i = 0; i < accumulation.length; i++) {
      const a = accumulation[Math.max(0, i - 1)];
      const b = accumulation[i];
      const c = accumulation[Math.min(accumulation.length - 1, i + 1)];
      ridge.push((a + b * 2 + c) / 4);
    }

    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    ctx.lineTo(0, canvas.height - ridge[0]);
    for (let i = 1; i < ridge.length; i++) {
      const x = i * 4;
      const prevX = (i - 1) * 4;
      ctx.quadraticCurveTo(
        prevX, canvas.height - ridge[i - 1],
        (prevX + x) / 2, canvas.height - (ridge[i - 1] + ridge[i]) / 2
      );
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();

    // Snow lit from above: bright crest falling off to a cooler, shaded
    // base, instead of one flat white shelf.
    const maxDepth = Math.max(12, ...ridge);
    const bank = ctx.createLinearGradient(0, canvas.height - maxDepth, 0, canvas.height);
    bank.addColorStop(0, 'rgba(255,255,255,0.97)');
    bank.addColorStop(0.5, 'rgba(233,241,250,0.92)');
    bank.addColorStop(1, 'rgba(188,206,226,0.85)');
    ctx.fillStyle = bank;
    ctx.fill();

    // Crisp lit edge along the crest.
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height - ridge[0]);
    for (let i = 1; i < ridge.length; i++) {
      ctx.lineTo(i * 4, canvas.height - ridge[i]);
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
