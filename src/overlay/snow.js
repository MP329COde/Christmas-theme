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

import {
  getSettings, listThemes, onSettingsChanged, publishStats, loadBackground, onBackgroundChanged,
  listScreens,
} from '../shared/bridge.js';
import { drawGarland, drawTree, drawFireplace } from './decor.js';
import { screenConfig, resolvePalette, resolveWeatherProfile, TREE_STYLES, defaultScene } from '../shared/scene.js';
import {
  drawSky, drawGlitter, drawIcicles, invalidateLights, invalidateAurora,
} from './lights.js';
import { QualityGovernor, debugEnabled } from '../shared/perf.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// TWO canvases, not one.
//
// The WebGL tree layer renders into its own canvas stacked between them,
// so the compositing order of the whole scene survives the split:
//
//   #snow        background image, sky, far snow      (behind the trees)
//   #snow-gl     the trees, on the GPU                (engine/renderer.js)
//   #snow-front  icicles, garland, fireplaces, near snow, bank, glitter
//
// When WebGL is unavailable the trees are drawn into #snow instead, in
// exactly the place they used to be, and nothing else changes — which is
// what makes the fallback a one-line switch rather than a second renderer.
const canvas = document.getElementById('snow');
const ctx = canvas.getContext('2d');
const frontCanvas = document.getElementById('snow-front');
const fctx = frontCanvas.getContext('2d');

/// 'gl' once the engine has taken the trees over; '2d' until then, and
/// for good if the engine cannot start.
let treeRenderer = '2d';
/// Same idea, for the aurora specifically: the engine adopts the trees
/// and the aurora TOGETHER (one Scene, one first-frame gate — see
/// gl-trees.js), so in practice this always tracks `treeRenderer`, but
/// it stays its own flag rather than being inferred from that one, so a
/// future independent aurora-only adoption path doesn't have to touch
/// every read site.
let auroraRenderer = '2d';
const sceneListeners = new Set();

let flakes = [];
let config = {
  density: 120,
  wind: 0.3,
  flakeSize: 3,
  flakeScale: 1,
  accumulate: true,
  maxSnowHeight: 60,
  glitterDensity: 1,
  color: '#ffffff',
};

// 0 = uncapped, i.e. run at whatever the display refreshes at (120Hz on a
// ProMotion panel). The cap is there to save battery, it is not a floor.
// Default changed from 0 (unlimited) to 30: this is a permanent background
// wallpaper, not a game — it has no need of a 120Hz redraw to look smooth,
// and forcing one on every frame this app ever draws is exactly the kind
// of unconditional cost the perf budget below exists to avoid.
let fpsLimit = 30;
let lastFrameAt = 0;

// ---------------------------------------------------------------------------
// automatic quality degrade (see src/shared/perf.js)
// ---------------------------------------------------------------------------
//
// Four tiers, each a concrete recipe for "draw less" rather than a vague
// quality slider: fewer aurora rays and stars, a smaller snow field, and
// (applied to the GL tree layer, if adopted) a lower internal render
// resolution. Degrading resolution before framerate is deliberate — a
// slightly softer scene is far less noticeable on a background wallpaper
// than the stutter a dropped frame would be.
const QUALITY_TIERS = [
  { label: 'full', auroraDetail: 1, starDetail: 1, snowScale: 1, glRenderScale: 1 },
  { label: 'reduced', auroraDetail: 0.7, starDetail: 0.75, snowScale: 0.75, glRenderScale: 0.85 },
  { label: 'low', auroraDetail: 0.45, starDetail: 0.5, snowScale: 0.55, glRenderScale: 0.65 },
  { label: 'minimum', auroraDetail: 0.25, starDetail: 0.3, snowScale: 0.35, glRenderScale: 0.5 },
];

/// The CPU-time proxy target (see perf.js for why this is milliseconds of
/// our own render() work, not an OS CPU percentage): a fraction of the
/// period implied by the current fps cap, leaving headroom for
/// compositing, other apps and the OS. Recomputed whenever the cap
/// changes; an unlimited cap (0) assumes a 60Hz budget so there's still a
/// target to measure against.
function targetFrameMsFor(limit) {
  const hz = limit > 0 ? limit : 60;
  return (1000 / hz) * 0.4;
}

function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function smoothNoise1D(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i + seed * 17.13);
  const b = hash01(i + 1 + seed * 17.13);
  return a + (b - a) * u;
}

const qualityTierListeners = new Set();

function applyQualityTier(tierCfg) {
  applyDensity();
  for (const cb of qualityTierListeners) cb(tierCfg);
}

/// Subscribes to automatic quality tier changes — used by overlay.js to
/// forward `glRenderScale` to the WebGL tree renderer, which lives outside
/// this module. Immediately invoked with the CURRENT tier so a listener
/// added after boot doesn't have to wait for the next transition.
export function onQualityTierChanged(cb) {
  qualityTierListeners.add(cb);
  cb(quality.tier);
  return () => qualityTierListeners.delete(cb);
}

export function getQualityTier() {
  return quality.tier;
}

const quality = new QualityGovernor({
  tiers: QUALITY_TIERS,
  targetFrameMs: targetFrameMsFor(fpsLimit),
  // Every overlay window (one per monitor) shares this channel: a window
  // struggling on its own pulls every other window's quality down with
  // it, rather than each window deciding in isolation while the machine
  // as a whole is still under load. See perf.js for the reasoning.
  channel: 'christmas-overlay-quality',
  debug: debugEnabled(),
  onChange: applyQualityTier,
});

// Rolling render statistics, published to the settings window so the frame
// budget is verifiable rather than merely asserted.
const stats = { fps: 0, frameMs: 0, frames: 0, accum: 0, since: 0 };

// Global light master controls. What appears on THIS screen is decided by
// the per-screen composition (sceneCfg) instead — that is what lets one
// monitor carry the fireplace and another carry three trees, rather than
// every window drawing the same thing or only "overlay-0" being decorated.
let decorConfig = {
  lightAnimation: 'twinkle',
  lightIntensity: 1,
  shadowStrength: 1,
  shadowSoftness: 1,
  decorScale: 1,
};
let themeColors = { primary: '#c0392b', secondary: '#1e7d32', accent: '#f1c40f' };

/// Which monitor this overlay window is on. Rust names the windows
/// `overlay-0`, `overlay-1`, ... so the window knows its own index without
/// an extra round trip, and that index is the key into the per-screen
/// composition. Outside Tauri (the Playwright harness) it is screen 0.
function screenIndex() {
  if (typeof window.__TAURI__ === 'undefined') return 0;
  try {
    const label = window.__TAURI__.window.getCurrentWindow().label;
    const n = Number(label.split('-')[1]);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// The resolved composition for THIS screen: which trees, where, at what
// size, with which light strings, plus the sky layers and background.
let sceneCfg = screenConfig(defaultScene(), 0);
let backgroundImage = null;

// This window's position in the OS's virtual desktop space (physical
// px), relative to the virtual desktop's own top-left corner. Used to
// place sky elements (stars) in a coordinate space shared across every
// overlay window, so they read as one continuous sky instead of each
// monitor generating its own disconnected field. Resolved async from
// Tauri's Monitor API below; 0,0 until then (and permanently outside
// Tauri, where there is exactly one window and it doesn't matter).
let originX = 0;
let originY = 0;

/// Matches this window to its own entry in `listScreens()` by index (Rust
/// names overlay windows `overlay-<index>`, same as `screenIndex()`
/// above) and records its real desktop position. A resize is forced
/// afterwards to re-key the star field bake, which otherwise stays keyed
/// to the origin-less first pass.
async function resolveScreenOrigin() {
  try {
    const screens = await listScreens();
    const mine = screens.find((s) => s.index === screenIndex());
    if (!mine) return;
    originX = (mine.x ?? 0) - (mine.virtualOriginX ?? 0);
    originY = (mine.y ?? 0) - (mine.virtualOriginY ?? 0);
    invalidateLights();
  } catch {
    // No Tauri, or the call failed: stay at 0,0 — the single-window
    // behaviour this always had.
  }
}
resolveScreenOrigin();

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
let ridgeBuffer = null;

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
// far -> near: core radius fraction, and the flake's own tint. Distant
// snow is cooled by the air between it and the viewer (atmospheric
// perspective); only the closest flakes are actually white.
const FLAKE_LAYERS = [
  { coreStop: 0.72, tint: '203,219,238' },
  { coreStop: 0.5, tint: '230,239,250' },
  { coreStop: 0.24, tint: '255,255,255' },
];
const flakeSprites = FLAKE_LAYERS.map(({ coreStop, tint }) => {
  const cv = document.createElement('canvas');
  cv.width = FLAKE_SPRITE_SIZE;
  cv.height = FLAKE_SPRITE_SIZE;
  const sctx = cv.getContext('2d');
  const c = FLAKE_SPRITE_SIZE / 2;
  const gradient = sctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, `rgba(${tint},1)`);
  gradient.addColorStop(coreStop, `rgba(${tint},0.85)`);
  gradient.addColorStop(1, `rgba(${tint},0)`);
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

/// Loads this screen's background image, if it has one. Stored by Rust in
/// its own file rather than inside settings.json — see save_background —
/// and fetched once here, not on every settings save.
async function refreshBackground() {
  if (sceneCfg.background === 'image') {
    try {
      const dataUrl = await loadBackground(`screen-${screenIndex()}`);
      if (!dataUrl) {
        backgroundImage = null;
        return;
      }
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      backgroundImage = img;
    } catch {
      // A background that fails to decode must never take the overlay down
      // with it; the scene simply renders without one.
      backgroundImage = null;
    }
    return;
  }
  backgroundImage = null;
}

// Procedurally-generated animated winter forest background, drawn behind
// the aurora and snow. It reacts to the scene's light intensity so the
// wallpaper never feels disconnected from the decorations.
function drawAnimatedForest(c, w, h, time) {
  const motion = Math.max(0, Number(sceneCfg.backgroundMotion ?? 1) || 0);
  const moving = sceneCfg.backgroundAnimation !== 'none' && motion > 0;
  const drift = moving ? Math.sin(time * 0.06) * w * 0.03 * motion : 0;
  const opacity = sceneCfg.backgroundOpacity ?? 1;

  c.save();
  c.globalAlpha = opacity;
  // Night sky gradient, tinted by aurora intensity.
  const sky = c.createLinearGradient(0, 0, 0, h * 0.72);
  sky.addColorStop(0, '#050912');
  sky.addColorStop(0.55, '#0b1424');
  sky.addColorStop(1, '#132236');
  c.fillStyle = sky;
  c.fillRect(0, 0, w, h);

  // Distant moon glow, drifting very slowly with parallax.
  const moonX = w * 0.78 + drift * 0.15;
  const moonY = h * 0.16;
  const moon = c.createRadialGradient(moonX, moonY, 0, moonX, moonY, h * 0.18);
  moon.addColorStop(0, 'rgba(255,250,232,0.18)');
  moon.addColorStop(0.25, 'rgba(255,246,214,0.06)');
  moon.addColorStop(1, 'rgba(255,250,232,0)');
  c.fillStyle = moon;
  c.fillRect(0, 0, w, h);

  // Far hills.
  const farHill = (x) => h * 0.62
    + Math.sin((x + drift * 0.3) * 0.0047) * h * 0.04
    + Math.sin((x + drift * 0.3) * 0.011) * h * 0.02;
  const hillGrad = c.createLinearGradient(0, h * 0.55, 0, h);
  hillGrad.addColorStop(0, '#1a2b3f');
  hillGrad.addColorStop(1, '#0d1722');
  c.fillStyle = hillGrad;
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) c.lineTo(x, farHill(x));
  c.lineTo(w, h);
  c.closePath();
  c.fill();

  // Mid-distance pine silhouettes.
  const drawPine = (x, y, s) => {
    c.fillStyle = `rgba(12,24,20,${0.75 + s * 0.2})`;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + s * 30, y + s * 110);
    c.lineTo(x - s * 30, y + s * 110);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(x, y - s * 45);
    c.lineTo(x + s * 24, y + s * 60);
    c.lineTo(x - s * 24, y + s * 60);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(x, y - s * 80);
    c.lineTo(x + s * 16, y + s * 15);
    c.lineTo(x - s * 16, y + s * 15);
    c.closePath();
    c.fill();
  };

  const rand = mulberry32(2026);
  const baseTreeX = (i) => ((i * 137.5 + rand() * 60) % (w + 160)) - 80 + drift * 0.55;
  for (let i = 0; i < 18; i++) {
    const x = baseTreeX(i);
    const scale = 0.55 + rand() * 0.55;
    drawPine(x, h * 0.74 + rand() * h * 0.05, scale);
  }

  // Snow-covered foreground hill.
  const nearHill = (x) => h * 0.82
    + Math.sin((x - drift) * 0.0033) * h * 0.035
    + Math.sin((x - drift) * 0.009) * h * 0.015;
  const snowGrad = c.createLinearGradient(0, h * 0.78, 0, h);
  snowGrad.addColorStop(0, '#d8e6f0');
  snowGrad.addColorStop(0.45, '#b6c9d9');
  snowGrad.addColorStop(1, '#8ca4b8');
  c.fillStyle = snowGrad;
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x <= w; x += 6) c.lineTo(x, nearHill(x));
  c.lineTo(w, h);
  c.closePath();
  c.fill();

  // Subtle warm light wash from the fireplace/trees, driven by decorConfig.
  const warm = (decorConfig.lightIntensity ?? 1) * 0.5;
  if (warm > 0.05) {
    const glow = c.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, w * 0.65);
    glow.addColorStop(0, `rgba(255,160,72,${0.12 * warm})`);
    glow.addColorStop(0.5, `rgba(255,140,58,${0.04 * warm})`);
    glow.addColorStop(1, 'rgba(255,120,40,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, w, h);
  }

  // Soft falling snow in the background layer, linked to the real snow
  // intensity but kept faint so it doesn't compete with the overlay flakes.
  const bgFlakes = Math.round(w / 45);
  c.fillStyle = 'rgba(235,244,255,0.55)';
  for (let i = 0; i < bgFlakes; i++) {
    const fx = ((i * 97.3 + time * (8 + (i % 5)) * 0.4 + drift * (0.5 + (i % 3) * 0.2)) % (w + 20)) - 10;
    const fy = ((i * 53.7 + time * (12 + (i % 7)) * 0.55) % (h * 0.72));
    const fr = 0.6 + (i % 4) * 0.35;
    c.globalAlpha = opacity * (0.2 + (i % 5) * 0.08);
    c.beginPath();
    c.arc(fx, fy, fr, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
  c.restore();
}

/// Draws the background under everything else: either an image or the
/// procedural animated winter forest.
function drawBackground(w, h, time) {
  if (sceneCfg.background === 'animated-forest') {
    drawAnimatedForest(ctx, w, h, time);
    return;
  }
  if (!backgroundImage) return;
  const iw = backgroundImage.naturalWidth;
  const ih = backgroundImage.naturalHeight;
  if (!iw || !ih) return;
  const animation = sceneCfg.backgroundAnimation ?? 'drift';
  const motion = Math.max(0, Number(sceneCfg.backgroundMotion ?? 1) || 0);
  const moving = animation !== 'none' && motion > 0;
  const driftX = moving ? Math.sin(time * 0.11) * w * 0.028 * motion : 0;
  const driftY = moving ? Math.cos(time * 0.08 + 0.9) * h * 0.022 * motion : 0;
  const extraScale = !moving ? 1 : animation === 'kenburns'
    ? 1 + 0.08 * motion + 0.04 * motion * (0.5 + 0.5 * Math.sin(time * 0.15 + 0.5))
    : 1 + 0.03 * motion;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.globalAlpha = sceneCfg.backgroundOpacity ?? 1;
  const fit = sceneCfg.backgroundFit ?? 'cover';
  if (fit === 'stretch') {
    const dw = w * extraScale;
    const dh = h * extraScale;
    ctx.drawImage(backgroundImage, (w - dw) / 2 + driftX, (h - dh) / 2 + driftY, dw, dh);
  } else if (fit === 'tile') {
    const offsetX = ((driftX % iw) + iw) % iw;
    const offsetY = ((driftY % ih) + ih) % ih;
    for (let y = -ih + offsetY; y < h; y += ih) {
      for (let x = -iw + offsetX; x < w; x += iw) ctx.drawImage(backgroundImage, x, y);
    }
  } else {
    const scale = fit === 'contain'
      ? Math.min(w / iw, h / ih)
      : Math.max(w / iw, h / ih);
    const dw = iw * scale * extraScale;
    const dh = ih * scale * extraScale;
    ctx.drawImage(backgroundImage, (w - dw) / 2 + driftX, (h - dh) / 2 + driftY, dw, dh);
  }
  ctx.restore();
}

// The canvas BACKING STORE (canvas.width/height) is sized in DEVICE
// pixels so sprite/text edges stay crisp on a HiDPI display, but every
// draw call in this file works in LOGICAL (CSS) pixels — viewW/viewH —
// exactly as it did when this ran unscaled. `ctx.setTransform` bridges
// the two once per resize; nothing downstream has to know DPR exists.
// Previously canvas.width was set to window.innerWidth with no DPR
// factor at all, which left the whole overlay rendering at 1x and being
// upscaled by the browser (blurry) on any HiDPI/Retina screen.
let viewW = window.innerWidth;
let viewH = window.innerHeight;
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  frontCanvas.width = canvas.width;
  frontCanvas.height = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  accumulation = new Float32Array(Math.ceil(viewW / 4));
  bankDirty = true;
  // Every light layer bakes sprites cut to the current size; a resize has
  // to throw those away or the fringe and star field stay sized for the
  // old window.
  invalidateLights();
}
window.addEventListener('resize', resize);

/// Gives a flake a fresh set of properties IN PLACE.
///
/// This used to be `Object.assign(f, makeFlake(), { y: -10 })` at the
/// moment a flake landed, which allocated a new object plus an object
/// literal every single time. At a few hundred flakes falling
/// continuously that is thousands of short-lived objects per second, and
/// the resulting garbage-collection sawtooth is exactly the periodic
/// hitch you feel as the snow stuttering — on a fast machine especially,
/// because a fast machine lands more flakes per second, not fewer.
///
/// Recycling in place allocates nothing, so the steady state produces no
/// garbage at all.
function resetFlake(f, atTop) {
  // depth: 0 = far away, 1 = close to the viewer. Everything else about a
  // flake follows from it, which is what sells the sense of volume: near
  // flakes are big, fast, bright and out of focus; distant ones are small,
  // slow and dim.
  const depth = Math.random() ** 1.6; // biased distant: fewer big foreground flakes
  f.depth = depth;
  f.layer = depth > 0.72 ? 2 : depth > 0.38 ? 1 : 0;
  // Only mid/near flakes are ever detailed crystals — a distant flake is
  // too small for the shape to read, so drawing one is wasted work.
  f.isCrystal = depth > 0.45 && Math.random() < 0.4;
  f.x = Math.random() * viewW;
  f.y = atTop ? -10 : Math.random() * -viewH;
  f.r = config.flakeSize * config.flakeScale * (0.35 + depth * 1.5) * (0.75 + Math.random() * 0.5);
  f.speed = (0.35 + depth * 1.5) * (0.8 + Math.random() * 0.5);
  f.drift = Math.random() * Math.PI * 2;
  f.driftRate = 0.006 + Math.random() * 0.012;
  f.opacity = 0.35 + depth * 0.6;
  f.rotation = Math.random() * Math.PI;
  f.spin = (Math.random() - 0.5) * 0.02;
  return f;
}

/// The one place a flake object is created. Called only when the density
/// setting grows the field.
function makeFlake() {
  const flake = resetFlake({}, false);
  flake.y = Math.random() * viewH;
  return flake;
}

/// Resizes the actual particle array to `n`. Separate from `setDensity`
/// below because two different things now decide how many flakes exist:
/// the user's chosen density (`config.density`) and the automatic
/// degrade's `snowScale` — this is the one place that turns "how many do
/// we actually want right now" into the array itself.
function resizeFlakes(n) {
  const target = Math.max(0, Math.round(n));
  if (flakes.length < target) {
    while (flakes.length < target) flakes.push(makeFlake());
  } else {
    flakes.length = target;
  }
}

/// Re-applies the user's density setting scaled by the current quality
/// tier. Called on every setDensity()/setConfig() and every automatic
/// tier change, so the two never fight — whichever changed last wins,
/// which is exactly "the smaller of what the user asked for and what the
/// machine can currently afford".
function applyDensity() {
  resizeFlakes(config.density * (quality.tier.snowScale ?? 1));
}

export function setDensity(density) {
  config.density = density;
  applyDensity();
}

export function setConfig(partial) {
  config = { ...config, ...partial };
  applyDensity();
}

export function setFpsLimit(limit) {
  fpsLimit = Number(limit) || 0;
  quality.setTargetFrameMs(targetFrameMsFor(fpsLimit));
}

export function getParticleCount() {
  return flakes.length;
}

export function getStats() {
  return {
    fps: stats.fps,
    frameMs: stats.frameMs,
    // Oldest-first per-frame costs behind the rolling average the
    // governor itself acts on — what a diagnostic panel needs to draw a
    // history instead of just the current instant.
    frameHistory: quality.monitor.history(),
    qualityTarget: Math.round(quality.targetFrameMs * 10) / 10,
    particles: flakes.length,
    renderer: treeRenderer === 'gl' ? 'webgl' : 'canvas2d',
    // Why the tree renderer ended up on Canvas 2D, if it did — set by
    // overlay.js's adoption gate (software rasteriser, no GPU, a failed
    // first frame, ...). Null once WebGL was adopted, since there is
    // nothing to explain then.
    rendererReason: treeRenderer === 'gl' ? null : (window.overlayRenderer?.reason ?? null),
    qualityTier: quality.tierIndex,
    qualityLabel: quality.tier.label,
  };
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
function drawFlake(target, f) {
  target.globalAlpha = f.opacity;

  // Below this size the dendrite's thin arms downscale past legibility —
  // the six branch tips sit at a near-constant radius, so anti-aliasing
  // blurs them into a faint ring instead of a visible star. The soft
  // gradient sprite reads correctly at any size, so small crystals fall
  // back to it rather than draw an illegible hollow circle.
  if (!f.isCrystal || f.r < 4) {
    const size = f.r * 4;
    target.drawImage(flakeSprites[f.layer], f.x - size / 2, f.y - size / 2, size, size);
    return;
  }

  const sixth = Math.PI / 3;
  let step = Math.floor(((f.rotation % sixth) / sixth) * CRYSTAL_STEPS);
  if (step < 0) step += CRYSTAL_STEPS;
  const size = f.r * 4.4;
  target.drawImage(
    crystalStrip, step * CRYSTAL_SIZE, 0, CRYSTAL_SIZE, CRYSTAL_SIZE,
    f.x - size / 2, f.y - size / 2, size, size
  );
}

/// Advances one flake and recycles it once it lands. Kept separate from
/// drawing so the scene can be composited in depth order (far snow, then
/// the decorations, then near snow) while each flake is still stepped
/// exactly once per frame.
function stepFlake(f, gust) {
  f.y += f.speed;
  f.drift += f.driftRate;
  // Nearer flakes are pushed further by the same wind, which is what makes
  // the layers visibly separate instead of moving as one sheet.
  f.x += Math.sin(f.drift) * config.wind * gust * (0.35 + f.depth * 1.3);
  // A gust also drives the whole field sideways, not just the flutter.
  f.x += config.wind * (gust - 1) * 0.9 * (0.3 + f.depth);
  f.rotation += f.spin;

  if (f.x < -40) f.x = viewW + 40;
  else if (f.x > viewW + 40) f.x = -40;

  const col = Math.max(0, Math.min(accumulation.length - 1, Math.floor(f.x / 4)));
  const groundY = config.accumulate ? viewH - accumulation[col] : viewH;

  if (f.y > groundY) {
    if (config.accumulate && accumulation[col] < config.maxSnowHeight) {
      accumulation[col] += 0.15;
      bankDirty = true;
    }
    resetFlake(f, true);
  }
}

function clampHeight(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(config.maxSnowHeight, v)) : 0;
}

function rebuildBank() {
  if (!bankCanvas || bankCanvas.width !== viewW || bankCanvas.height !== viewH) {
    bankCanvas = document.createElement('canvas');
    bankCanvas.width = viewW;
    bankCanvas.height = viewH;
  }
  const b = bankCanvas.getContext('2d');
  b.clearRect(0, 0, bankCanvas.width, bankCanvas.height);
  if (!accumulation.length) return;

  // Smooth the drift profile: raw per-column heights give a noisy
  // sawtooth, whereas settled snow forms soft rolling banks.
  //
  // The buffer is reused across rebuilds. This runs several times a
  // second for the life of the app, and allocating a fresh array each
  // time is the same garbage-collection problem as recycling flakes.
  if (!ridgeBuffer || ridgeBuffer.length !== accumulation.length) {
    ridgeBuffer = new Float32Array(accumulation.length);
  }
  const ridge = ridgeBuffer;
  for (let i = 0; i < accumulation.length; i++) {
    // Guard against NaN/negative/out-of-range columns — a resize can land
    // between two accumulate() calls, and a single corrupt column here
    // used to stretch the smoothed curve into a jagged spike across the
    // whole width instead of a soft bank.
    const a = clampHeight(accumulation[Math.max(0, i - 1)]);
    const m = clampHeight(accumulation[i]);
    const c = clampHeight(accumulation[Math.min(accumulation.length - 1, i + 1)]);
    ridge[i] = (a + m * 2 + c) / 4;
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
  ctx.clearRect(0, 0, viewW, viewH);
  fctx.clearRect(0, 0, viewW, viewH);

  // --- behind the trees --------------------------------------------------
  drawBackground(viewW, viewH, time);

  if (sceneCfg.aurora || sceneCfg.stars) {
    drawSky(ctx, viewW, viewH, time, {
      // The GL engine draws the aurora once adopted (see gl-trees.js /
      // NorthernLights) — this only draws it here when that hasn't
      // happened, so it's never painted twice.
      aurora: sceneCfg.aurora && auroraRenderer === '2d',
      stars: sceneCfg.stars,
      originX,
      originY,
      auroraDetail: quality.tier.auroraDetail,
      auroraPalette: sceneCfg.auroraPalette,
      auroraCustomColors: sceneCfg.auroraCustomColors,
      starDetail: quality.tier.starDetail,
      starDensity: sceneCfg.starDensity,
      shootingStarFrequency: sceneCfg.shootingStarFrequency,
      lightIntensity: (decorConfig.lightIntensity ?? 1) * (sceneCfg.auroraIntensity ?? 1),
    });
  }

  // Step every flake first, then draw in depth order: distant snow sits
  // behind the trees and fireplace, close snow passes in front of them.
  // Keep the broad "weather front" rhythm but layer in smooth noise so
  // gusts don't loop on an obvious fixed beat.
  const rhythmicGust = 1 + 0.42 * Math.sin(time * 0.23) + 0.28 * Math.sin(time * 0.61 + 1.7);
  const wanderingGust =
    (smoothNoise1D(time * 0.17, 4.2) - 0.5) * 0.6
    + (smoothNoise1D(time * 0.49, 9.7) - 0.5) * 0.24;
  const gust = Math.max(0.18, rhythmicGust + wanderingGust);
  for (const f of flakes) stepFlake(f, gust);

  for (const f of flakes) {
    if (f.layer === 0) drawFlake(ctx, f);
  }
  ctx.globalAlpha = 1;

  // Elements are drawn in the order they appear in the composition, so
  // "behind" and "in front of" is something the user controls by ordering
  // the list rather than something baked into the renderer.
  if (treeRenderer === '2d') {
    for (const tree of sceneCfg.trees ?? []) {
      const style = TREE_STYLES[tree.style] ?? TREE_STYLES.nordmann;
      drawTree(ctx, viewW, viewH, themeColors, time, {
        ...tree,
        palette: resolvePalette(tree.lights),
        styleWidth: style.width,
        styleDensity: style.density,
        snow: (tree.snow ?? 1) * (style.snow ?? 1),
      }, decorConfig);
    }
  }

  // --- in front of the trees ---------------------------------------------
  if (sceneCfg.icicles) {
    drawIcicles(fctx, viewW, viewH, time, decorConfig);
  }

  const garland = sceneCfg.garland;
  if (garland?.enabled) {
    drawGarland(fctx, viewW, time, resolvePalette(garland.lights), {
      animation: garland.lights?.mode,
      speed: garland.lights?.speed,
      size: garland.lights?.size,
      sag: garland.sag,
      spacing: garland.spacing,
      lightIntensity: (decorConfig.lightIntensity ?? 1) * (garland.lights?.intensity ?? 1),
    });
  }

  for (const fire of sceneCfg.fireplaces ?? []) {
    drawFireplace(fctx, viewW, viewH, time, themeColors, {
      ...fire,
      palette: resolvePalette(fire.lights),
    }, decorConfig);
  }

  for (const f of flakes) {
    if (f.layer !== 0) drawFlake(fctx, f);
  }
  fctx.globalAlpha = 1;

  if (config.accumulate) {
    if (bankDirty && time - bankLastBuilt > 0.25) {
      rebuildBank();
      bankDirty = false;
      bankLastBuilt = time;
    }
    if (bankCanvas) fctx.drawImage(bankCanvas, 0, 0);
    // Glitter goes on top of the bank, since it is light bouncing off the
    // surface we just drew.
    if (sceneCfg.snowGlitter) {
      drawGlitter(fctx, viewW, viewH, time, accumulation, {
        ...decorConfig,
        density: config.glitterDensity,
      });
    }
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
  // Fed straight from the same measurement the stats readout already
  // takes — one timing, two uses, no extra performance.now() calls.
  quality.sample(cost, ts);

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
  getSnowConfig: () => ({ ...config }),
  getDecorConfig: () => ({ ...decorConfig }),
  onQualityTierChanged, getQualityTier,
  /// Test-only hook: feeds a synthetic frame cost straight into the
  /// quality governor, bypassing the real render loop entirely, so a
  /// Playwright test can simulate a slow machine deterministically
  /// instead of needing to actually make the page slow.
  __simulateFrameCost: (ms, now) => quality.sample(ms, now ?? performance.now()),
  /// Hands the trees to the WebGL engine (or takes them back). Called by
  /// the bootstrap once the engine has actually produced a frame — never
  /// merely because a context could be created.
  setTreeRenderer(which) {
    treeRenderer = which === 'gl' ? 'gl' : '2d';
    return treeRenderer;
  },
  getTreeRenderer: () => treeRenderer,
  setAuroraRenderer(which) {
    auroraRenderer = which === 'gl' ? 'gl' : '2d';
    return auroraRenderer;
  },
  getAuroraRenderer: () => auroraRenderer,
  /// Subscribe to composition changes, so a second renderer can stay in
  /// step with this one without polling.
  onSceneChanged(listener) {
    sceneListeners.add(listener);
    listener(sceneCfg, null);
    return () => sceneListeners.delete(listener);
  },
};

async function applyThemeAndSettings(theme, settings) {
  if (!theme) return;
  const index = screenIndex();
  const previousBackground = `${sceneCfg.background}|${sceneCfg.backgroundFit}`;
  sceneCfg = screenConfig(settings?.scene ?? defaultScene(), index);

  // A screen can override the global snow density, so one monitor can be
  // a blizzard while another stays calm.
  const density = sceneCfg.snowDensity === 'inherit' || sceneCfg.snowDensity == null
    ? (settings?.snowDensity ?? theme.snow.density)
    : Number(sceneCfg.snowDensity);
  const weather = resolveWeatherProfile(sceneCfg.weatherProfile);

  setConfig({
    density: sceneCfg.enabled === false ? 0 : density,
    wind: (settings?.snowWind ?? theme.snow.wind) * weather.wind,
    flakeSize: theme.snow.flakeSize,
    flakeScale: (settings?.flakeScale ?? 1) * weather.flakeScale,
    accumulate: settings?.snowAccumulate ?? theme.snow.accumulate,
    maxSnowHeight: (settings?.maxSnowHeight ?? 60) * weather.accumulate,
    glitterDensity: weather.glitterDensity,
  });
  setFpsLimit(settings?.fpsLimit ?? 0);
  themeColors = theme.colors;
  bankDirty = true;

  // Global light settings still exist as the master controls; per-element
  // styles multiply into them rather than replacing them.
  decorConfig = {
    lightAnimation: settings?.lightAnimation ?? 'twinkle',
    lightIntensity: settings?.lightIntensity ?? 1,
    fireplaceContribution: sceneCfg.look?.fireplaceContribution ?? 1,
    shadowStrength: sceneCfg.look?.shadowStrength ?? 1,
    shadowSoftness: sceneCfg.look?.shadowSoftness ?? 1,
    decorScale: settings?.decorScale ?? 1,
  };

  if (`${sceneCfg.background}|${sceneCfg.backgroundFit}` !== previousBackground
      || sceneCfg.background === 'image'
      || sceneCfg.background === 'animated-forest') {
    await refreshBackground();
  }

  // The GL tree renderer, if it started, rebuilds from the same
  // composition — there is one source of truth, not two.
  for (const listener of sceneListeners) {
    listener(sceneCfg, {
      themeColors,
      fpsLimit: settings?.fpsLimit ?? 0,
      lightIntensity: decorConfig.lightIntensity,
    });
  }
}

async function initFromBackend() {
  try {
    const [themes, settings] = await Promise.all([listThemes(), getSettings()]);
    const theme = themes.find((t) => t.id === settings.themeId) ?? themes[0];
    await applyThemeAndSettings(theme, settings);
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
  void applyThemeAndSettings(theme, settings);
});

// The image itself travels outside the settings payload (it is megabytes),
// so its own event tells this window to re-read it.
onBackgroundChanged((key) => {
  if (key === `screen-${screenIndex()}`) refreshBackground();
});

// Exposed so the settings window's per-screen editor can be driven from a
// test, and so the scene can be inspected without a debugger.
window.snowOverlayScene = {
  getScreenIndex: screenIndex,
  getConfig: () => sceneCfg,
  setConfig: (next) => {
    const prevPalette = sceneCfg.auroraPalette;
    const prevCustom = sceneCfg.auroraCustomColors;
    sceneCfg = screenConfig({ screens: { [String(screenIndex())]: next } }, screenIndex());
    bankDirty = true;
    if (sceneCfg.auroraPalette !== prevPalette
        || JSON.stringify(sceneCfg.auroraCustomColors) !== JSON.stringify(prevCustom)) {
      invalidateAurora();
    }
  },
};
