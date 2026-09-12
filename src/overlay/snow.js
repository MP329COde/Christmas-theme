// Snow + desktop decorations renderer. No Tauri-only APIs are used in the
// render path itself, so this file is directly testable via Playwright by
// loading index.html from a plain static server (see docs/ARCHITECTURE.md,
// section 5). Loading the initial theme/settings, reacting to live changes
// and publishing render stats do use the shared bridge, which itself
// no-ops outside Tauri.
//
// FRAME BUDGET: the target is 120fps, i.e. 8.3ms per frame, so the hot
// loop issues drawImage calls against pre-baked sprites, creates no
// gradients and builds essentially no paths. See decor.js for the same
// approach applied to the scene.

import { getSettings, listThemes, onSettingsChanged, publishStats } from '../shared/bridge.js';
import { drawGarland, drawTrees, drawFireplace, GARLAND_PALETTES } from './decor.js';

const canvas = document.getElementById('snow');
const ctx = canvas.getContext('2d');

let flakes = [];
let config = {
  density: 120,
  wind: 0.3,
  flakeSize: 3,
  flakeScale: 1,
  accumulate: true,
  maxSnowHeight: 60,
  color: '#ffffff',
};

// 0 = uncapped, i.e. run at whatever the display refreshes at (120Hz on a
// ProMotion panel). The cap is there to save battery, it is not a floor.
let fpsLimit = 0;
let lastFrameAt = 0;

// Rolling render statistics, published to the settings window so the frame
// budget is verifiable rather than merely asserted.
const stats = { fps: 0, frameMs: 0, frames: 0, accum: 0, since: 0 };

// Decorations are independent of the snow theme config: they come from
// AppSettings (user toggles), not the theme file, and only render on one
// overlay window — see isPrimaryOverlay() below — so a multi-monitor setup
// gets one decorated "scene", not the same trees repeated on every screen.
let decorConfig = {
  trees: true,
  garlands: true,
  fireplace: true,
  garlandStyle: 'multicolor',
  treeLights: true,
  stockings: true,
  mantelGarland: true,
  decorScale: 1,
};
let themeColors = { primary: '#c0392b', secondary: '#1e7d32', accent: '#f1c40f' };

let accumulation = []; // per-column snow height, only used when accumulate=true
let running = true;
let rafId = null;
const clock = { start: performance.now() };

// The settled snow bank is comparatively expensive to build (a smoothed
// path across hundreds of columns, plus a gradient) and only changes when
// a flake actually lands. It gets its own canvas, rebuilt a few times a
// second at most, then blitted — rebuilding it every frame was pure waste.
let bankCanvas = null;
let bankDirty = true;
let bankLastBuilt = -1;

// Flake sprites, pre-rendered once into offscreen canvases and reused via
// drawImage(). Doing the falloff once here instead of a live
// ctx.shadowBlur on every flake, every frame, is what keeps a few hundred
// glowing flakes cheap — shadowBlur per-shape at that scale is a
// well-known canvas performance trap.
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

// Crystal flakes are baked as a strip of pre-rotated frames. A six-armed
// dendrite is ~30 stroke segments; drawing that live for every crystal on
// screen, every frame, is exactly the kind of cost that misses a 120Hz
// budget. The arms repeat every 60°, so the strip only covers that range.
const CRYSTAL_STEPS = 16;
const CRYSTAL_SIZE = 48;
const crystalStrip = (() => {
  const cv = document.createElement('canvas');
  cv.width = CRYSTAL_SIZE * CRYSTAL_STEPS;
  cv.height = CRYSTAL_SIZE;
  const c = cv.getContext('2d');
  const half = CRYSTAL_SIZE / 2;
  const arm = half * 0.86;
  c.strokeStyle = '#ffffff';
  c.fillStyle = '#ffffff';
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = CRYSTAL_SIZE * 0.05;
  for (let s = 0; s < CRYSTAL_STEPS; s++) {
    c.save();
    c.translate(s * CRYSTAL_SIZE + half, half);
    c.rotate((s / CRYSTAL_STEPS) * (Math.PI / 3));
    for (let b = 0; b < 6; b++) {
      c.save();
      c.rotate((Math.PI / 3) * b);
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(0, -arm);
      // Two pairs of side branches plus a tip fork — that asymmetry along
      // the arm is what reads as a dendrite rather than an asterisk.
      c.moveTo(0, -arm * 0.42);
      c.lineTo(arm * 0.3, -arm * 0.62);
      c.moveTo(0, -arm * 0.42);
      c.lineTo(-arm * 0.3, -arm * 0.62);
      c.moveTo(0, -arm * 0.68);
      c.lineTo(arm * 0.2, -arm * 0.83);
      c.moveTo(0, -arm * 0.68);
      c.lineTo(-arm * 0.2, -arm * 0.83);
      c.stroke();
      c.restore();
    }
    c.beginPath();
    c.arc(0, 0, CRYSTAL_SIZE * 0.07, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  return cv;
})();

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  accumulation = new Array(Math.ceil(canvas.width / 4)).fill(0);
  bankDirty = true;
}
window.addEventListener('resize', resize);

function makeFlake() {
  // depth: 0 = far away, 1 = close to the viewer. Everything else about a
  // flake follows from it, which is what sells the sense of volume: near
  // flakes are big, fast, bright and out of focus; distant ones are small,
  // slow and dim.
  const depth = Math.random() ** 1.6; // biased distant: fewer big foreground flakes
  const layer = depth > 0.72 ? 2 : depth > 0.38 ? 1 : 0;
  // Only mid/near flakes are ever detailed crystals — a distant flake is
  // too small for the shape to read, so drawing one is wasted work.
  const isCrystal = depth > 0.45 && Math.random() < 0.4;
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    depth,
    layer,
    r: config.flakeSize * config.flakeScale * (0.35 + depth * 1.5) * (0.75 + Math.random() * 0.5),
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

export function setFpsLimit(limit) {
  fpsLimit = Number(limit) || 0;
}

export function getParticleCount() {
  return flakes.length;
}

export function getStats() {
  return { fps: stats.fps, frameMs: stats.frameMs, particles: flakes.length };
}

export function stop() {
  running = false;
}

export function start() {
  running = true;
}

/// Draws one snowflake, scaled and softened by its depth. Distant flakes
/// are soft dots; nearer ones are faceted crystals picked from the
/// pre-rotated strip. Either way it's a single blit.
function drawFlake(f) {
  ctx.globalAlpha = f.opacity;

  if (!f.isCrystal || f.r < 2.2) {
    const size = f.r * 4;
    ctx.drawImage(flakeSprites[f.layer], f.x - size / 2, f.y - size / 2, size, size);
    return;
  }

  const sixth = Math.PI / 3;
  let step = Math.floor(((f.rotation % sixth) / sixth) * CRYSTAL_STEPS);
  if (step < 0) step += CRYSTAL_STEPS;
  const size = f.r * 4.4;
  ctx.drawImage(
    crystalStrip, step * CRYSTAL_SIZE, 0, CRYSTAL_SIZE, CRYSTAL_SIZE,
    f.x - size / 2, f.y - size / 2, size, size
  );
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
    if (config.accumulate && accumulation[col] < config.maxSnowHeight) {
      accumulation[col] += 0.15;
      bankDirty = true;
    }
    Object.assign(f, makeFlake(), { y: -10 });
  }
}

function rebuildBank() {
  if (!bankCanvas || bankCanvas.width !== canvas.width || bankCanvas.height !== canvas.height) {
    bankCanvas = document.createElement('canvas');
    bankCanvas.width = canvas.width;
    bankCanvas.height = canvas.height;
  }
  const b = bankCanvas.getContext('2d');
  b.clearRect(0, 0, bankCanvas.width, bankCanvas.height);
  if (!accumulation.length) return;

  // Smooth the drift profile: raw per-column heights give a noisy
  // sawtooth, whereas settled snow forms soft rolling banks.
  const ridge = [];
  for (let i = 0; i < accumulation.length; i++) {
    const a = accumulation[Math.max(0, i - 1)];
    const m = accumulation[i];
    const c = accumulation[Math.min(accumulation.length - 1, i + 1)];
    ridge.push((a + m * 2 + c) / 4);
  }

  const h = bankCanvas.height;
  b.beginPath();
  b.moveTo(0, h);
  b.lineTo(0, h - ridge[0]);
  for (let i = 1; i < ridge.length; i++) {
    const x = i * 4;
    const prevX = (i - 1) * 4;
    b.quadraticCurveTo(
      prevX, h - ridge[i - 1],
      (prevX + x) / 2, h - (ridge[i - 1] + ridge[i]) / 2
    );
  }
  b.lineTo(bankCanvas.width, h);
  b.closePath();

  let maxDepth = 12;
  for (const v of ridge) if (v > maxDepth) maxDepth = v;
  const grad = b.createLinearGradient(0, h - maxDepth, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0.97)');
  grad.addColorStop(0.5, 'rgba(233,241,250,0.92)');
  grad.addColorStop(1, 'rgba(188,206,226,0.85)');
  b.fillStyle = grad;
  b.fill();

  b.strokeStyle = 'rgba(255,255,255,0.9)';
  b.lineWidth = 1.5;
  b.beginPath();
  b.moveTo(0, h - ridge[0]);
  for (let i = 1; i < ridge.length; i++) b.lineTo(i * 4, h - ridge[i]);
  b.stroke();
}

function render(time) {
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
    drawTrees(ctx, canvas.width, canvas.height, themeColors, time, decorConfig);
  }
  if (decorConfig.fireplace) {
    drawFireplace(ctx, canvas.width, canvas.height, time, themeColors, decorConfig);
  }

  for (const f of flakes) {
    if (f.layer !== 0) drawFlake(f);
  }
  ctx.globalAlpha = 1;

  if (config.accumulate) {
    if (bankDirty && time - bankLastBuilt > 0.25) {
      rebuildBank();
      bankDirty = false;
      bankLastBuilt = time;
    }
    if (bankCanvas) ctx.drawImage(bankCanvas, 0, 0);
  }
}

function tick(now) {
  rafId = requestAnimationFrame(tick);

  const ts = now ?? performance.now();
  if (!running) return;

  if (fpsLimit > 0) {
    // Half a millisecond of slack: without it a 120Hz display running a
    // 120 cap drops every other frame to 60 through rounding.
    if (ts - lastFrameAt < 1000 / fpsLimit - 0.5) return;
  }
  lastFrameAt = ts;

  const t0 = performance.now();
  render((ts - clock.start) / 1000);
  const cost = performance.now() - t0;

  stats.frames++;
  stats.accum += cost;
  if (stats.since === 0) {
    stats.since = ts;
  } else if (ts - stats.since >= 500) {
    stats.fps = Math.round((stats.frames * 1000) / (ts - stats.since));
    stats.frameMs = Math.round((stats.accum / stats.frames) * 100) / 100;
    stats.frames = 0;
    stats.accum = 0;
    stats.since = ts;
    publishStats(getStats());
  }
}

resize();
setDensity(config.density);
tick();

// Expose for Playwright / manual debugging without a module bundler step.
window.snowOverlay = {
  setDensity, setConfig, setFpsLimit, getParticleCount, getStats, start, stop,
};

/// Only one overlay window (whichever monitor got "overlay-0") draws the
/// trees/garland/fireplace scene. With one overlay window per monitor,
/// repeating the same full-size decorations on every screen would read as
/// duplicated clutter rather than one decorated desktop. Falls back to
/// true outside Tauri (standalone page / Playwright) so the decorations
/// stay visible and testable there.
function isPrimaryOverlay() {
  if (typeof window.__TAURI__ === 'undefined') return true;
  try {
    return window.__TAURI__.window.getCurrentWindow().label === 'overlay-0';
  } catch {
    return true;
  }
}

// Apply the theme's snow settings and the user's overrides. User-chosen
// values win over the theme's own defaults so the settings window stays
// authoritative.
function applyThemeAndSettings(theme, settings) {
  if (!theme) return;
  setConfig({
    density: settings?.snowDensity ?? theme.snow.density,
    wind: settings?.snowWind ?? theme.snow.wind,
    flakeSize: theme.snow.flakeSize,
    flakeScale: settings?.flakeScale ?? 1,
    accumulate: settings?.snowAccumulate ?? theme.snow.accumulate,
    maxSnowHeight: settings?.maxSnowHeight ?? 60,
  });
  setFpsLimit(settings?.fpsLimit ?? 0);
  themeColors = theme.colors;
  bankDirty = true;

  const primary = isPrimaryOverlay();
  decorConfig = {
    trees: primary && (settings?.treesDecoration ?? true),
    garlands: primary && (settings?.garlandsDecoration ?? true),
    fireplace: primary && (settings?.fireplaceDecoration ?? true),
    garlandStyle: settings?.garlandStyle ?? 'multicolor',
    treeLights: settings?.treeLights ?? true,
    stockings: settings?.stockings ?? true,
    mantelGarland: settings?.mantelGarland ?? true,
    decorScale: settings?.decorScale ?? 1,
  };
}

async function initFromBackend() {
  try {
    const [themes, settings] = await Promise.all([listThemes(), getSettings()]);
    const theme = themes.find((t) => t.id === settings.themeId) ?? themes[0];
    applyThemeAndSettings(theme, settings);
  } catch (err) {
    // The overlay still renders with the built-in defaults above even if
    // the initial fetch fails, rather than showing a blank screen.
    console.error('Failed to load initial theme/settings for overlay:', err);
  }
}

// Exposed so tests (and anything else driving this page from the outside)
// can await the initial theme/settings load before asserting on state or
// calling setDensity() themselves — otherwise the async fetch above could
// resolve afterwards and silently overwrite a value the caller just set.
window.snowOverlayReady = initFromBackend();

// Live updates: react immediately when the settings window saves, instead
// of requiring an app restart.
onSettingsChanged(({ theme, settings }) => {
  applyThemeAndSettings(theme, settings);
});
