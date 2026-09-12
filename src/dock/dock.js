// Dock / taskbar decoration, drawn into the thin transparent, click-through
// strip window that main.rs positions over the shell bar.
//
// The geometry arrives from Rust as a `dock-geometry` event (see
// src-tauri/src/decoration.rs for how the strip is derived from the
// monitor work area). Outside Tauri — the Playwright harness, or just
// opening the page in a browser — it falls back to query parameters, so
// the exact same renderer is testable:
//
//     /dock/index.html?edge=bottom&thickness=64&length=1200
//
// Everything is drawn in a rotated frame where the bar always runs left to
// right with its leading edge (the side facing the desktop) at the top, so
// one drawing routine covers a Dock on the left, right or bottom and a
// taskbar on any of the four edges.

import { GARLAND_PALETTES, bulbLevel, glowSprite } from '../overlay/decor.js';
import { getSettings, listThemes, onSettingsChanged } from '../shared/bridge.js';

const canvas = document.getElementById('dock');
const ctx = canvas.getContext('2d');

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const params = new URLSearchParams(location.search);

/// Physical geometry of the strip. `overhang` is the band outside the
/// shell bar: on macOS the Dock draws above every ordinary window, so that
/// band is the part guaranteed to stay visible and it carries the garland,
/// the snow ledge and the icicle roots.
let geom = {
  edge: params.get('edge') ?? 'bottom',
  length: Number(params.get('length')) || 0,
  depth: Number(params.get('depth')) || 0,
  barThickness: Number(params.get('thickness')) || 56,
  scale: Number(params.get('scale')) || 1,
};

let opts = {
  style: 'multicolor',
  animation: 'twinkle',
  lightIntensity: 1,
  enabled: true,
};
let bake = null; // baked static art: snow ledge, swag, icicles
let bakeKey = '';

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const vertical = geom.edge === 'left' || geom.edge === 'right';
  geom.length = vertical ? canvas.height : canvas.width;
  geom.depth = vertical ? canvas.width : canvas.height;
  bake = null;
}
window.addEventListener('resize', resize);

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Bakes the parts that never move — snow ledge, pine swag, icicles — into
/// one offscreen canvas in strip-local coordinates, and returns the bulb
/// positions so the lights can be animated live on top of it. Same reason
/// as the main overlay: this window redraws continuously and must not cost
/// anything meaningful.
function bakeStrip(length, depth, scale) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(length));
  cv.height = Math.max(1, Math.ceil(depth));
  const c = cv.getContext('2d');
  const rand = mulberry32(4242);
  const s = scale;
  // Where the snow ledge sits: near the strip's leading edge, leaving room
  // below for the swag and icicles to hang into the bar.
  const ledgeY = Math.min(depth * 0.34, 16 * s);
  const bulbs = [];

  // --- pine swag along the leading edge ------------------------------------
  // Each pin point gets a fan of needles rather than two strokes, so the
  // swag reads as foliage at this small size instead of scribble.
  const sprigs = Math.max(6, Math.round(length / (7 * s)));
  const pinEvery = 210 * s;
  for (let i = 0; i <= sprigs; i++) {
    const p = i / sprigs;
    const x = p * length;
    // Real garland is pinned every so often and sags between the pins; it
    // does not hang in one long curve across a whole screen.
    const sag = Math.abs(Math.sin((x / pinEvery) * Math.PI)) * 6 * s;
    const y = ledgeY + sag;
    const green = `hsl(${134 + rand() * 20}, ${34 + rand() * 24}%, ${13 + rand() * 15}%)`;
    c.strokeStyle = green;
    c.lineCap = 'round';
    for (let n = 0; n < 5; n++) {
      const len = (5 + rand() * 9) * s;
      const ang = Math.PI / 2 + (rand() - 0.5) * 2.1;
      c.lineWidth = (0.9 + rand() * 1.3) * s;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(ang) * len, y + Math.abs(Math.sin(ang)) * len * 0.9);
      c.stroke();
    }
    if (rand() > 0.85) {
      c.fillStyle = rand() > 0.5 ? '#c0182a' : '#9d1220';
      c.beginPath();
      c.arc(x + (rand() - 0.5) * 6 * s, y + (3 + rand() * 5) * s, 1.7 * s, 0, Math.PI * 2);
      c.fill();
    }
    if (i % 7 === 0) {
      bulbs.push({ x, y: y + (6 + rand() * 4) * s, phase: rand() * 6.28 });
    }
  }

  // --- icicles hanging off the ledge ---------------------------------------
  // Same treatment as the desktop fringe: clustered rather than evenly
  // spaced, and mostly transparent with the contrast in the rim.
  let ix = rand() * 30 * s;
  const tips = [];
  while (ix < length) {
    if (rand() < 0.45) {
      ix += (20 + rand() * 60) * s;
      continue;
    }
    const bw = (4 + rand() * 6) * s;
    const bh = (5 + rand() ** 2.3 * (depth - ledgeY) * 0.8);
    const tipX = ix + bw / 2;
    const body = c.createLinearGradient(0, ledgeY, 0, ledgeY + bh);
    body.addColorStop(0, 'rgba(216,238,255,0.34)');
    body.addColorStop(1, 'rgba(255,255,255,0.06)');
    c.fillStyle = body;
    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(ix, ledgeY);
    c.lineTo(ix + bw, ledgeY);
    c.quadraticCurveTo(ix + bw * 0.8, ledgeY + bh * 0.6, tipX, ledgeY + bh);
    c.quadraticCurveTo(ix + bw * 0.2, ledgeY + bh * 0.6, ix, ledgeY);
    c.closePath();
    c.fill();
    c.stroke();
    tips.push({ x: tipX, y: ledgeY + bh, phase: rand() * 6.28 });
    ix += bw + rand() * 18 * s;
  }

  // --- snow ledge resting on the bar's edge, drawn last so it caps the
  // --- swag and the icicle roots
  const grad = c.createLinearGradient(0, -4 * s, 0, ledgeY + 2 * s);
  grad.addColorStop(0, 'rgba(255,255,255,0.98)');
  grad.addColorStop(0.7, 'rgba(240,248,255,0.9)');
  grad.addColorStop(1, 'rgba(206,226,246,0.35)');
  c.fillStyle = grad;
  c.beginPath();
  c.moveTo(0, ledgeY + 1 * s);
  for (let x = 0; x <= length; x += 7 * s) {
    // Two beating sines give an uneven drift line instead of a scalloped
    // repeat, which is what a swept-up ridge of snow actually looks like.
    const bump = Math.sin(x * 0.017) * 1.2 * s + Math.sin(x * 0.0051 + 1.3) * 1.8 * s;
    c.lineTo(x, ledgeY - 4 * s - bump);
  }
  c.lineTo(length, ledgeY + 1 * s);
  c.closePath();
  c.fill();

  return { cv, bulbs, tips, ledgeY, scale: s };
}

// Small flakes drifting inside the strip, so the decoration is alive even
// when the lights are set to steady.
const flakes = [];
function seedFlakes(length, depth) {
  flakes.length = 0;
  const n = Math.max(6, Math.round(length / 90));
  for (let i = 0; i < n; i++) {
    flakes.push({
      x: Math.random() * length,
      y: Math.random() * depth,
      r: 0.7 + Math.random() * 1.6,
      vy: 0.12 + Math.random() * 0.35,
      drift: Math.random() * 6.28,
      alpha: 0.3 + Math.random() * 0.5,
    });
  }
}

/// Sets up the transform so drawing can assume "bar runs left to right,
/// with its leading edge — the side facing the desktop — at the top",
/// whatever edge the shell bar is actually docked to.
///
/// Each case is written as an explicit matrix rather than a stack of
/// translate/rotate/scale calls: the mapping it has to satisfy is exactly
/// "local (X along the bar, Y into the bar) lands here on screen", and
/// spelling that out is what makes it checkable. ctx.transform(a,b,c,d,e,f)
/// maps (X,Y) to (aX + cY + e, bX + dY + f).
function applyEdgeTransform(edge, w, h) {
  switch (edge) {
    case 'top':
      // Bar along the top: the desktop is below, so Y grows upward.
      ctx.transform(1, 0, 0, -1, 0, h);
      return { length: w, depth: h };
    case 'left':
      // Bar down the left: the desktop is to the right, so Y grows leftward.
      ctx.transform(0, 1, -1, 0, w, 0);
      return { length: h, depth: w };
    case 'right':
      // Bar down the right: the desktop is to the left, so Y grows rightward.
      ctx.transform(0, 1, 1, 0, 0, 0);
      return { length: h, depth: w };
    case 'bottom':
    default:
      // Bar along the bottom: the desktop is above, Y already grows downward.
      return { length: w, depth: h };
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const time = now / 1000;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!opts.enabled || canvas.width < 4 || canvas.height < 4) return;

  ctx.save();
  const { length, depth } = applyEdgeTransform(geom.edge, canvas.width, canvas.height);

  // Drawing scale follows how deep the strip is in CSS pixels — the
  // canvas is already in CSS pixels, so the monitor's DPR must NOT be
  // folded in here or every element would come out double size on a
  // Retina display.
  const drawScale = Math.max(0.7, Math.min(1.8, depth / 78));
  const key = `${Math.round(length)}x${Math.round(depth)}`;
  if (!bake || bakeKey !== key) {
    bake = bakeStrip(length, depth, drawScale);
    bakeKey = key;
    bake.scale = drawScale;
    seedFlakes(length, depth);
  }

  // Drifting flakes go behind the garland.
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (const f of flakes) {
    f.y += f.vy;
    f.drift += 0.02;
    f.x += Math.sin(f.drift) * 0.25;
    if (f.y > depth) {
      f.y = -2;
      f.x = Math.random() * length;
    }
    ctx.globalAlpha = f.alpha;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.drawImage(bake.cv, 0, 0);

  // Lights, driven by the same controller as the desktop scene.
  const palette = GARLAND_PALETTES[opts.style] ?? GARLAND_PALETTES.multicolor;
  const gain = opts.lightIntensity ?? 1;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < bake.bulbs.length; i++) {
    const b = bake.bulbs[i];
    const color = palette[i % palette.length];
    const lit = bulbLevel(opts.animation, time, i, b.phase, bake.bulbs.length);
    const size = (16 + 13 * lit) * bake.scale;
    ctx.globalAlpha = Math.min(1, 0.8 * lit * gain);
    ctx.drawImage(glowSprite(color), b.x - size / 2, b.y - size / 2, size, size);
  }
  // Icicle tips pick up that light.
  for (const t of bake.tips) {
    const shine = 0.3 + 0.35 * Math.sin(time * 1.4 + t.phase);
    ctx.globalAlpha = Math.min(1, shine * 0.5 * gain);
    const size = 10 * bake.scale;
    ctx.drawImage(glowSprite('#cfe8ff', 48), t.x - size / 2, t.y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // Bulb bodies on top of their own glow.
  for (let i = 0; i < bake.bulbs.length; i++) {
    const b = bake.bulbs[i];
    const color = palette[i % palette.length];
    const lit = bulbLevel(opts.animation, time, i, b.phase, bake.bulbs.length);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55 + 0.45 * lit;
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, 2.4 * bake.scale, 3.2 * bake.scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function applySettings(_theme, settings) {
  opts = {
    style: settings?.garlandStyle ?? 'multicolor',
    animation: settings?.lightAnimation ?? 'twinkle',
    lightIntensity: settings?.lightIntensity ?? 1,
    enabled: (settings?.dockDecoration ?? true) || (settings?.taskbarDecoration ?? true),
  };
}

if (isTauri) {
  window.__TAURI__.event.listen('dock-geometry', ({ payload }) => {
    geom = {
      edge: payload.edge,
      length: 0,
      depth: 0,
      barThickness: payload.barThickness,
      scale: payload.scaleFactor || 1,
    };
    // The window has just been resized to the new strip; re-read the
    // viewport rather than trusting a stale one.
    resize();
  });
}

onSettingsChanged(({ theme, settings }) => applySettings(theme, settings));

// Exposed for Playwright, mirroring window.snowOverlay.
window.dockDecoration = {
  setGeometry(next) {
    geom = { ...geom, ...next };
    resize();
  },
  setOptions(next) {
    opts = { ...opts, ...next };
  },
  getBulbCount: () => (bake ? bake.bulbs.length : 0),
  getGeometry: () => ({ ...geom }),
};

window.dockDecorationReady = (async () => {
  try {
    const [themes, settings] = await Promise.all([listThemes(), getSettings()]);
    applySettings(themes.find((t) => t.id === settings.themeId) ?? themes[0], settings);
  } catch (err) {
    console.error('Dock decoration failed to load settings:', err);
  }
})();

resize();
requestAnimationFrame(frame);
