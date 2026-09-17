// Decorative scene drawn onto the same canvas as the snow: a light garland
// along the top edge, decorated conifers in the bottom corners, and a stone
// fireplace at bottom-center.
//
// PERFORMANCE MODEL — this is what makes a 120fps budget (8.3ms/frame)
// reachable with this much detail:
//
//   * Everything that doesn't move is BAKED ONCE into an offscreen canvas
//     (tree branches, ornaments, stonework, mantel, logs, stockings,
//     mantel garland) and blitted with one drawImage per frame.
//   * Things that DO move are baked too, as sprite sheets or reusable
//     sprites: the flame is a pre-rendered loop of frames, glows are single
//     tinted sprites drawn with varying alpha/scale.
//   * Per frame we therefore issue plain drawImage calls and almost no
//     path building, and crucially create ZERO gradients. Building a
//     CanvasGradient per bulb/tongue/glow every frame — which the previous
//     version did, ~35 of them — is the kind of cost that quietly eats a
//     120Hz frame budget.
//
// Decorations are only drawn on the "primary" overlay window (see snow.js):
// with one overlay window per monitor, repeating full-size decorations on
// every screen would read as clutter, not as one decorated desktop.

// Re-exported so existing importers of this module keep working; the
// definition lives in shared/scene.js because BOTH renderers need it and
// neither owns it.
import { bulbLevel } from '../shared/scene.js';
export { bulbLevel };

export const GARLAND_PALETTES = {
  multicolor: ['#ff5d5d', '#ffc93c', '#3ddc97', '#5b8def', '#c77dff'],
  warm: ['#ffcf8a', '#ffb347', '#ffe6b8', '#ff9d4d'],
  cool: ['#9fe8ff', '#5b8def', '#c9d9ff', '#7fe0e0'],
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Deterministic PRNG: a bake must produce identical output every time, or
/// a resize would visibly reshuffle every branch and ornament.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
function seededUnit(seed, salt = 0) {
  const x = Math.sin((seed + salt * 17.17) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function toRgb(color) {
  if (color.startsWith('rgb')) {
    const [r, g, b] = color.match(/\d+/g).map(Number);
    return { r, g, b };
  }
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function shade(color, amt) {
  const { r, g, b } = toRgb(color);
  const d = (amt / 100) * 255;
  return `rgb(${clamp255(r + d)},${clamp255(g + d)},${clamp255(b + d)})`;
}

function rgba(color, a) {
  const { r, g, b } = toRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w));
  cv.height = Math.max(1, Math.ceil(h));
  return cv;
}

/// A soft radial glow of a given color, baked once and reused. Drawing a
/// light means blitting this with an alpha — no per-frame gradient.
const glowCache = new Map();
export function glowSprite(color, size = 64) {
  const key = `${color}|${size}`;
  let sprite = glowCache.get(key);
  if (sprite) return sprite;
  const cv = makeCanvas(size, size);
  const c = cv.getContext('2d');
  const r = size / 2;
  const g = c.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, rgba(color, 1));
  g.addColorStop(0.22, rgba(color, 0.55));
  g.addColorStop(0.5, rgba(color, 0.16));
  g.addColorStop(1, rgba(color, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  glowCache.set(key, cv);
  return cv;
}

const TREE_SHADOW_SPRITE = glowSprite('#000000', 128);
const FIREPLACE_SHADOW_SPRITE = glowSprite('#000000', 160);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function star(ctx, cx, cy, points, outerR, innerR) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (Math.PI / points) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/// Draws one pine bough as a curved central stem with needle pairs along
/// it — the unit the whole conifer silhouette is built from.
function bough(c, x, y, len, angle, width, color, rand) {
  const tipX = x + Math.cos(angle) * len;
  const tipY = y + Math.sin(angle) * len;
  const sagX = x + Math.cos(angle) * len * 0.5;
  const sagY = y + Math.sin(angle) * len * 0.5 + len * 0.12;

  c.strokeStyle = color;
  c.lineCap = 'round';
  c.lineWidth = width;
  c.beginPath();
  c.moveTo(x, y);
  c.quadraticCurveTo(sagX, sagY, tipX, tipY);
  c.stroke();

  // Needles: short strokes fanning off both sides of the stem.
  const needles = Math.max(3, Math.round(len / 5));
  c.lineWidth = Math.max(0.7, width * 0.55);
  for (let i = 1; i <= needles; i++) {
    const t = i / (needles + 1);
    // Point on the quadratic.
    const px = (1 - t) * (1 - t) * x + 2 * (1 - t) * t * sagX + t * t * tipX;
    const py = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * sagY + t * t * tipY;
    const nl = len * (0.3 - t * 0.16) * (0.7 + rand() * 0.6);
    for (const side of [-1, 1]) {
      const na = angle + side * (0.75 + rand() * 0.45);
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl + nl * 0.25);
      c.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// light animation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// garland (top of screen)
// ---------------------------------------------------------------------------

const garlandCache = new Map();

function bakeGarland(width, colors, spacing, sag) {
  const key = `${Math.round(width)}|${colors.join(',')}|${spacing}|${sag}`;
  const cached = garlandCache.get(key);
  if (cached) return cached;

  const count = Math.max(2, Math.round(width / spacing));
  const cv = makeCanvas(width, 88);
  const c = cv.getContext('2d');
  const wireY = (t) => 8 + Math.sin(t * Math.PI * 2) * 4 * sag + Math.sin(t * Math.PI) * 26 * sag;
  const rand = mulberry32(Math.round(width * 17 + spacing * 31 + sag * 101));

  // Dense, overlapping fir sprigs make the string read as a real garland
  // rather than a row of isolated bulbs.
  c.lineCap = 'round';
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = t * width;
    const y = wireY(t);
    for (const side of [-1, 1]) {
      bough(c, x, y + 4, spacing * (0.72 + rand() * 0.28), side * (0.18 + rand() * 0.22) + Math.PI / 2, 2.2, '#173b27', rand);
      bough(c, x + side * spacing * 0.16, y + 6, spacing * (0.45 + rand() * 0.2), side * 0.4 + Math.PI / 2, 1.2, '#3d6d3c', rand);
    }
  }

  // A few heavier baubles break up the foliage and provide the large,
  // reflective shapes visible in a real mantel or doorway garland.
  for (let i = 1; i < count; i += 2) {
    const t = i / count;
    const x = t * width;
    const y = wireY(t) + 18 + (rand() - 0.5) * 5;
    const radius = 5 + rand() * 2.5;
    const color = colors[i % colors.length];
    const bulb = c.createRadialGradient(x - radius * 0.35, y - radius * 0.4, 0, x, y, radius);
    bulb.addColorStop(0, '#ffffff');
    bulb.addColorStop(0.16, color);
    bulb.addColorStop(0.78, shade(color, -18));
    bulb.addColorStop(1, shade(color, -42));
    c.fillStyle = bulb;
    c.beginPath();
    c.arc(x, y, radius, 0, TAU);
    c.fill();
    c.fillStyle = '#b08a42';
    c.fillRect(x - 1.5, y - radius - 3, 3, 4);
  }

  c.strokeStyle = 'rgba(13,18,18,0.9)';
  c.lineWidth = 1.5;
  c.beginPath();
  for (let i = 0; i <= count * 3; i++) {
    const t = i / (count * 3);
    const x = t * width;
    const y = wireY(t);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();
  garlandCache.set(key, cv);
  return cv;
}

/// A hung cable with bulbs. The wire is one cheap stroked path; each bulb
/// is a baked glow sprite plus a tiny shaded body, so the whole string
/// costs a couple of dozen blits instead of a couple of dozen gradients.
export function drawGarland(ctx, width, time, colors, opts = {}) {
  const spacing = 54 * (opts.spacing ?? 1);
  const count = Math.max(2, Math.round(width / spacing));
  const sag = opts.sag ?? 1;
  const wireY = (t) => 8 + Math.sin(t * Math.PI * 2) * 4 * sag + Math.sin(t * Math.PI) * 26 * sag;

  ctx.save();
  ctx.drawImage(bakeGarland(width, colors, spacing, sag), 0, 0);

  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = t * width;
    const capY = wireY(t);
    const y = capY + 11;
    const color = colors[i % colors.length];
    const lit = bulbLevel(opts.animation, time, i, i * 1.37, count + 1, opts.speed ?? 1);
    const gain = opts.lightIntensity ?? 1;

    ctx.fillStyle = '#22262d';
    ctx.fillRect(x - 2, capY, 4, 5);

    const glow = glowSprite(color);
    const gs = 40 * lit * (0.8 + 0.2 * gain) * (opts.size ?? 1);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, 0.85 * lit * gain);
    ctx.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.fillStyle = shade(color, -10 + 40 * lit);
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 3.4, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.55 * lit})`;
    ctx.beginPath();
    ctx.ellipse(x - 1.3, y - 0.9, 1, 1.5, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// conifers
// ---------------------------------------------------------------------------

const treeCache = new Map();

/// Bakes a decorated conifer: a dense mass of drawn boughs rather than
/// stacked triangles, dusted with snow, hung with baubles, and with the
/// positions of its warm string lights returned so they can be twinkled
/// live on top of the baked sprite.
function bakeTree(scale, colors, seed, spec = {}) {
  const wantLights = spec.lightsOn !== false;
  // Style controls the silhouette itself, not just a colour: a spruce is
  // visibly narrower and sparser than a pine, and swapping between them
  // has to change the geometry or it is only a label.
  const styleWidth = spec.styleWidth ?? 1;
  const styleDensity = spec.styleDensity ?? 1;
  const snowAmount = spec.snow ?? 1;
  const ornamentAmount = spec.ornaments ?? 1;
  const w = 240 * scale;
  const h = 420 * scale;
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(seed);

  const cx = w / 2;
  const groundY = h - 12 * scale;
  const trunkW = 16 * scale;
  const trunkH = 34 * scale;
  const topY = 38 * scale;
  const baseHalf = 108 * scale * styleWidth;

  // Contact shadow.
  const sh = c.createRadialGradient(cx, groundY, 0, cx, groundY, baseHalf);
  sh.addColorStop(0, 'rgba(0,0,0,0.5)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sh;
  c.beginPath();
  c.ellipse(cx, groundY, baseHalf, 16 * scale, 0, 0, Math.PI * 2);
  c.fill();

  // Trunk.
  const bark = c.createLinearGradient(cx - trunkW / 2, 0, cx + trunkW / 2, 0);
  bark.addColorStop(0, '#2b1a10');
  bark.addColorStop(0.4, '#5b3a24');
  bark.addColorStop(1, '#2f1c11');
  c.fillStyle = bark;
  c.beginPath();
  c.moveTo(cx - trunkW / 2, groundY);
  c.lineTo(cx - trunkW * 0.3, groundY - trunkH);
  c.lineTo(cx + trunkW * 0.3, groundY - trunkH);
  c.lineTo(cx + trunkW / 2, groundY);
  c.closePath();
  c.fill();

  // --- foliage: boughs from the bottom up ---------------------------------
  const green = colors.secondary;
  const foliageBottom = groundY - trunkH * 0.55;
  const rows = 26;
  const lights = [];

  for (let row = 0; row < rows; row++) {
    const f = row / (rows - 1); // 0 bottom .. 1 top
    const y = foliageBottom - (foliageBottom - topY) * f;
    const half = baseHalf * (1 - f) ** 0.72;
    // Tips catch light, lower rows sit in shade, and each bough wanders a
    // little in hue — uniform green is the main thing that reads as fake.
    const hueJitter = (rand() - 0.5) * 16;
    const rowColor = shade(green, -28 + f * 32 + hueJitter);
    const perRow = Math.max(3, Math.round((half / (7 * scale)) * styleDensity));

    for (let i = 0; i < perRow; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const spread = (0.25 + rand() * 0.75) * half;
      const bx = cx + side * spread * 0.25;
      const len = (half * (0.55 + rand() * 0.5)) * 0.85 + 6 * scale;
      // Boughs droop outward and down.
      const angle = side < 0
        ? Math.PI - (0.05 + rand() * 0.45)
        : 0.05 + rand() * 0.45;
      bough(c, bx, y + (rand() - 0.5) * 5 * scale, len, angle,
        Math.max(0.9, 2.2 * scale * (1 - f * 0.4)), rowColor, rand);
    }

    // Warm string lights woven through, following the same conical profile.
    if (wantLights && row % 2 === 0) {
      const n = Math.max(2, Math.round(half / (16 * scale)));
      for (let i = 0; i < n; i++) {
        const p = (i + rand() * 0.8) / n;
        lights.push({
          x: cx + (p * 2 - 1) * half * 0.92,
          y: y + (rand() - 0.5) * 6 * scale,
          phase: rand() * Math.PI * 2,
        });
      }
    }
  }

  // --- snow dusting on the upward-facing bough tips ------------------------
  for (let row = 1; row < rows; row += 2) {
    const f = row / (rows - 1);
    const y = foliageBottom - (foliageBottom - topY) * f;
    const half = baseHalf * (1 - f) ** 0.82;
    const caps = Math.max(2, Math.round(half / (13 * scale)));
    for (let i = 0; i <= caps; i++) {
      if (rand() > 0.5 * Math.min(2, snowAmount)) continue;
      const p = i / caps;
      const x = cx + (p * 2 - 1) * half * (0.55 + rand() * 0.45);
      const len = (4 + rand() * 5) * scale;
      c.fillStyle = `rgba(${235 + rand() * 20},${242 + rand() * 13},255,${0.62 + rand() * 0.3})`;
      c.beginPath();
      c.ellipse(x, y + (rand() - 0.5) * 4 * scale, len, len * 0.34,
        (rand() - 0.5) * 0.4, 0, Math.PI * 2);
      c.fill();
    }
  }

  // --- ribbon swagged around the tree --------------------------------------
  // Drawn as a series of dipping arcs at descending heights: front-facing
  // runs are lit, the returns behind the tree are darkened so the ribbon
  // reads as wrapping around the cone rather than lying flat on it.
  for (let turn = 0; spec.ribbon !== false && turn < 5; turn++) {
    const f0 = 0.86 - turn * 0.18;
    if (f0 < 0.02) break;
    const y0 = foliageBottom - (foliageBottom - topY) * f0;
    const half = baseHalf * (1 - f0) ** 0.72;
    const front = turn % 2 === 0;
    c.save();
    // Kept fairly transparent and thin: a heavy opaque band reads as a
    // bar painted across the tree instead of ribbon lying among branches.
    c.globalAlpha = front ? 0.72 : 0.34;
    c.strokeStyle = front ? shade(colors.accent, 6) : shade(colors.accent, -46);
    c.lineWidth = (2.6 + rand()) * scale;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - half * 0.9, y0 - 6 * scale);
    c.quadraticCurveTo(cx, y0 + 26 * scale, cx + half * 0.9, y0 - 8 * scale);
    c.stroke();
    if (front) {
      c.globalAlpha = 0.3;
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = 0.9 * scale;
      c.beginPath();
      c.moveTo(cx - half * 0.88, y0 - 7.2 * scale);
      c.quadraticCurveTo(cx, y0 + 24 * scale, cx + half * 0.88, y0 - 9.2 * scale);
      c.stroke();
    }
    c.restore();
  }

  // --- baubles -------------------------------------------------------------
  const ornamentColors = [
    colors.primary, colors.accent, '#f2f4f7',
    shade(colors.primary, 16), shade(colors.accent, -12), '#b9c4d0',
  ];
  const ornaments = Math.round(26 * scale * ornamentAmount);
  for (let i = 0; i < ornaments; i++) {
    const f = 0.05 + rand() * 0.9;
    const y = foliageBottom - (foliageBottom - topY) * f;
    const half = baseHalf * (1 - f) ** 0.72;
    const x = cx + (rand() * 2 - 1) * half * 0.82;
    const r = (4 + rand() * 3.4) * scale;
    const col = ornamentColors[Math.floor(rand() * ornamentColors.length)];

    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath();
    c.arc(x + 1 * scale, y + 1.4 * scale, r, 0, Math.PI * 2);
    c.fill();

    const ball = c.createRadialGradient(x - r * 0.36, y - r * 0.42, r * 0.08, x, y, r);
    ball.addColorStop(0, shade(col, 58));
    ball.addColorStop(0.42, col);
    ball.addColorStop(1, shade(col, -42));
    c.fillStyle = ball;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();

    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath();
    c.ellipse(x - r * 0.33, y - r * 0.4, r * 0.22, r * 0.14, -0.6, 0, Math.PI * 2);
    c.fill();

    // Cap and hook.
    c.fillStyle = '#c9a227';
    c.fillRect(x - r * 0.22, y - r * 1.22, r * 0.44, r * 0.34);

    // Every so often hang a star or a drop instead, so the tree isn't
    // covered in nothing but spheres.
    if (rand() > 0.76) {
      const sx2 = cx + (rand() * 2 - 1) * half * 0.7;
      const sy2 = y + (rand() - 0.5) * 26 * scale;
      c.fillStyle = rand() > 0.5 ? colors.accent : '#f2f4f7';
      if (rand() > 0.5) {
        star(c, sx2, sy2, 5, r * 1.15, r * 0.46);
      } else {
        c.beginPath();
        c.moveTo(sx2, sy2 - r * 1.3);
        c.quadraticCurveTo(sx2 + r * 0.75, sy2, sx2, sy2 + r * 1.1);
        c.quadraticCurveTo(sx2 - r * 0.75, sy2, sx2, sy2 - r * 1.3);
        c.fill();
      }
    }
  }

  // --- star ---------------------------------------------------------------
  const starY = topY - 12 * scale;
  if (spec.star === false) {
    return { sprite: cv, lights, star: null, groundY };
  }
  const sg = c.createLinearGradient(cx - 14 * scale, starY - 14 * scale, cx + 14 * scale, starY + 14 * scale);
  sg.addColorStop(0, '#fffdf0');
  sg.addColorStop(0.5, colors.accent);
  sg.addColorStop(1, shade(colors.accent, -28));
  c.fillStyle = sg;
  star(c, cx, starY, 5, 17 * scale, 7 * scale);

  return { sprite: cv, lights, star: { x: cx, y: starY }, groundY };
}

function getTree(scale, colors, seed, spec) {
  const key = [
    scale.toFixed(2), colors.secondary, colors.primary, colors.accent, seed,
    spec.lightsOn !== false, spec.styleWidth, spec.styleDensity,
    spec.snow, spec.ornaments, spec.ribbon, spec.star,
  ].join('|');
  let t = treeCache.get(key);
  if (!t) {
    t = bakeTree(scale, colors, seed, spec);
    // Several trees with different styles and scales can be on screen at
    // once now, so the cache has to hold more than one bake — but still
    // be bounded, or dragging a size slider would grow it without limit.
    if (treeCache.size > 14) treeCache.clear();
    treeCache.set(key, t);
  }
  return t;
}

/// Draws ONE conifer, wherever the scene says it goes.
///
/// This replaces the old `drawTrees`, which hard-coded exactly two trees
/// into the bottom corners. A scene now holds a list of tree specs, each
/// with its own horizontal position, scale, style, seed and light string,
/// so a screen can have one tree, five, or none — and two trees side by
/// side are genuinely different trees rather than one sprite mirrored.
export function drawTree(ctx, width, height, colors, time, spec, opts = {}) {
  const scale = Math.max(0.55, Math.min(2.6, (height / 900) * (spec.scale ?? 1)));
  const seed = spec.seed ?? 1337;
  const tree = getTree(scale, colors, seed, spec);
  const gain = (opts.lightIntensity ?? 1) * (spec.lights?.intensity ?? 1);
  const palette = spec.palette ?? ['#ffdba0'];
  const mode = spec.lights?.mode ?? opts.lightAnimation;
  const speed = spec.lights?.speed ?? 1;
  const bulbScale = spec.lights?.size ?? 1;
  const sway = Math.max(0, Number(spec.sway ?? 1) || 0);

  const originX = Math.round((spec.x ?? 0.5) * width - tree.sprite.width / 2);
  const originY = height - tree.sprite.height;
  const pivotX = tree.sprite.width / 2;
  const pivotY = tree.sprite.height;

  const swayPhase = seededUnit(seed, 2) * TAU;
  const swayRate = 0.45 + seededUnit(seed, 5) * 0.45;
  const leanAmp = (0.005 + 0.003 * Math.min(1.8, scale)) * sway;
  const driftAmp = (0.8 + 1.5 * Math.min(2, scale)) * sway;
  const lean =
    Math.sin(time * swayRate + swayPhase) * leanAmp
    + Math.sin(time * (swayRate * 0.43) + swayPhase * 1.7) * leanAmp * 0.45;
  const drift = Math.sin(time * (0.28 + seededUnit(seed, 8) * 0.3) + swayPhase * 0.61) * driftAmp;
  const localDrift = spec.flip ? -drift : drift;
  const localLean = spec.flip ? -lean : lean;
  const shadowStrength = Math.max(0, opts.shadowStrength ?? 1);
  const shadowSoftness = Math.max(0.4, opts.shadowSoftness ?? 1);

  if (shadowStrength > 0) {
    const sw = tree.sprite.width * (0.64 + 0.24 * shadowSoftness);
    const sh = 46 * scale * (0.72 + 0.45 * shadowSoftness);
    ctx.save();
    ctx.globalAlpha = Math.min(0.42, 0.18 + 0.16 * shadowStrength);
    ctx.drawImage(
      TREE_SHADOW_SPRITE,
      originX + pivotX + localDrift - sw / 2,
      originY + tree.groundY - sh * 0.55,
      sw,
      sh
    );
    ctx.restore();
  }

  ctx.save();
  ctx.translate(originX, originY);
  if (spec.flip) {
    ctx.translate(tree.sprite.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.translate(pivotX + localDrift, pivotY);
  ctx.rotate(localLean);
  ctx.translate(-pivotX, -pivotY);
  ctx.drawImage(tree.sprite, 0, 0);

  if (spec.lightsOn !== false && tree.lights.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < tree.lights.length; i++) {
      const l = tree.lights[i];
      // Each tree runs its own palette and mode, so one screen can carry a
      // warm-white tree next to a red-and-blue one.
      const color = palette[i % palette.length];
      const lit = bulbLevel(mode, time, i, l.phase, tree.lights.length, speed);
      const s = (14 + 10 * lit) * (0.85 + 0.15 * gain) * bulbScale;
      ctx.globalAlpha = Math.min(1, (0.5 + 0.5 * lit) * gain);
      ctx.drawImage(glowSprite(color, 48), l.x - s / 2, l.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  if (tree.star) {
    ctx.globalCompositeOperation = 'lighter';
    const starGlow = glowSprite(colors.accent, 96);
    const starPhase = seededUnit(seed, 11) * TAU;
    const twinkle =
      0.66
      + 0.28 * Math.sin(time * (1.8 + seededUnit(seed, 12) * 0.55) + starPhase)
      + 0.12 * Math.sin(time * 5.7 + starPhase * 0.4);
    const ss = 90 * twinkle * scale * 0.8;
    ctx.globalAlpha = Math.min(1, 0.85 * twinkle * gain);
    ctx.drawImage(starGlow, tree.star.x - ss / 2, tree.star.y - ss / 2, ss, ss);
    const halo = ss * 2.4;
    ctx.globalAlpha = Math.min(1, 0.16 * twinkle * gain);
    ctx.drawImage(starGlow, tree.star.x - halo / 2, tree.star.y - halo * 0.3, halo, halo);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// fireplace
// ---------------------------------------------------------------------------

// Several fireplaces can be on screen at once, each at its own scale, so
// the bake cache holds one entry per distinct configuration instead of a
// single slot that thrashed whenever two differed.
const fireCache = new Map();

/// Irregular stone courses, like the dry-stone surrounds in the reference
/// photos, rather than a uniform brick grid.
function drawStonework(c, w, h, scale, rand) {
  const rowH = 26 * scale;
  for (let y = 0; y < h; y += rowH) {
    let x = -10 * scale + rand() * 14 * scale;
    while (x < w + 10 * scale) {
      const sw = (30 + rand() * 58) * scale;
      const sh = rowH - 3 * scale;
      const tone = 0.6 + rand() * 0.72;
      // Warm limestone with a per-stone hue wobble, so no two courses read
      // as the same tile repeated.
      const warm = rand() * 16;
      const base = `rgb(${clamp255((146 + warm) * tone)},${clamp255((124 + warm * 0.6) * tone)},${clamp255((96 + warm * 0.2) * tone)})`;
      const g = c.createLinearGradient(x, y, x, y + sh);
      g.addColorStop(0, shade(base, 14));
      g.addColorStop(0.5, base);
      g.addColorStop(1, shade(base, -18));
      c.fillStyle = g;
      roundRect(c, x, y, sw, sh, 4 * scale);
      c.fill();

      // Mottling so each stone has some surface texture.
      for (let k = 0; k < 3; k++) {
        c.fillStyle = `rgba(0,0,0,${0.04 + rand() * 0.07})`;
        c.beginPath();
        c.ellipse(x + rand() * sw, y + rand() * sh, (2 + rand() * 6) * scale,
          (1.5 + rand() * 4) * scale, rand() * 3, 0, Math.PI * 2);
        c.fill();
      }

      c.strokeStyle = 'rgba(255,255,255,0.10)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x + 3, y + 1);
      c.lineTo(x + sw - 3, y + 1);
      c.stroke();

      x += sw + 3 * scale;
    }
  }
}

/// A pine swag: overlapping sprigs with berries and cones, as draped over
/// the mantel in the reference photos. Returns its light positions.
function drawMantelGarland(c, x0, y0, width, scale, colors, rand, wantLights) {
  const lights = [];
  const sprigs = Math.round(width / (9 * scale));
  for (let i = 0; i <= sprigs; i++) {
    const p = i / sprigs;
    const x = x0 + width * p;
    const droop = Math.sin(p * Math.PI) * 14 * scale;
    const y = y0 + droop;
    const len = (16 + rand() * 12) * scale;
    const angle = Math.PI * (0.15 + rand() * 0.7);
    bough(c, x, y, len, angle, 1.6 * scale, shade(colors.secondary, -18 + rand() * 34), rand);
    bough(c, x, y, len * 0.8, Math.PI - angle, 1.4 * scale, shade(colors.secondary, -26 + rand() * 30), rand);

    if (rand() > 0.72) {
      // Pine cone
      c.fillStyle = '#5a3b22';
      c.beginPath();
      c.ellipse(x + (rand() - 0.5) * 10 * scale, y + (6 + rand() * 6) * scale,
        3.2 * scale, 5 * scale, 0, 0, Math.PI * 2);
      c.fill();
    }
    if (rand() > 0.6) {
      // Berry cluster
      for (let b = 0; b < 3; b++) {
        c.fillStyle = b === 0 ? '#c0182a' : '#9d1220';
        c.beginPath();
        c.arc(x + (rand() - 0.5) * 12 * scale, y + (2 + rand() * 10) * scale, 2 * scale, 0, Math.PI * 2);
        c.fill();
      }
    }
    if (wantLights && i % 2 === 0) {
      lights.push({ x: x + (rand() - 0.5) * 8 * scale, y: y + (4 + rand() * 6) * scale, phase: rand() * 6.28 });
    }
  }
  return lights;
}

function drawStocking(c, x, y, scale, color, cuffColor) {
  const w = 26 * scale;
  const h = 46 * scale;
  c.save();
  c.translate(x, y);

  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.beginPath();
  c.ellipse(w * 0.3, h + 2 * scale, w * 0.5, 3 * scale, 0, 0, Math.PI * 2);
  c.fill();

  const body = c.createLinearGradient(0, 0, w, h);
  body.addColorStop(0, shade(color, 16));
  body.addColorStop(0.6, color);
  body.addColorStop(1, shade(color, -26));
  c.fillStyle = body;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(w, 0);
  c.lineTo(w * 0.92, h * 0.62);
  c.quadraticCurveTo(w * 0.92, h, w * 0.45, h);
  c.quadraticCurveTo(-w * 0.35, h, 0, h * 0.6);
  c.closePath();
  c.fill();

  c.fillStyle = cuffColor;
  roundRect(c, -1.5 * scale, -7 * scale, w + 3 * scale, 9 * scale, 2 * scale);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.15)';
  c.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    c.beginPath();
    c.moveTo(-1.5 * scale + (i + 0.5) * ((w + 3 * scale) / 5), -7 * scale);
    c.lineTo(-1.5 * scale + (i + 0.5) * ((w + 3 * scale) / 5), 2 * scale);
    c.stroke();
  }
  c.restore();
}

/// Dry-stone rustic surround: the original bake — tall arched firebox,
/// log grate, a heavy mantel beam. Unchanged; see bakeModernFireplace
/// just below for the alternative style, selected via
/// `spec.fireplaceStyle` ('rustic', the default, or 'modern').
function bakeRusticFireplace(scale, colors, opts) {
  const w = 300 * scale;
  const h = 250 * scale;
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(2024);

  const mantelY = 56 * scale;
  const mantelH = 30 * scale;

  drawStonework(c, w, h, scale, rand);

  // Firebox opening.
  const openW = w * 0.58;
  const openH = h * 0.56;
  const ox = (w - openW) / 2;
  const oy = h - openH - 12 * scale;
  const hearthY = h - 24 * scale;

  // Raised limestone hearth so the firebox feels grounded instead of ending
  // abruptly at the floor line.
  c.fillStyle = 'rgba(0,0,0,0.24)';
  c.beginPath();
  c.ellipse(w / 2, h - 4 * scale, w * 0.35, 9 * scale, 0, 0, Math.PI * 2);
  c.fill();
  const hearthTop = c.createLinearGradient(0, hearthY - 5 * scale, 0, hearthY + 10 * scale);
  hearthTop.addColorStop(0, '#d8c2a3');
  hearthTop.addColorStop(0.55, '#b99a75');
  hearthTop.addColorStop(1, '#8c6a46');
  c.fillStyle = hearthTop;
  roundRect(c, 18 * scale, hearthY - 5 * scale, w - 36 * scale, 15 * scale, 5 * scale);
  c.fill();
  const hearthFace = c.createLinearGradient(0, hearthY + 1 * scale, 0, h);
  hearthFace.addColorStop(0, '#97724c');
  hearthFace.addColorStop(1, '#5d4128');
  c.fillStyle = hearthFace;
  roundRect(c, 28 * scale, hearthY + 1 * scale, w - 56 * scale, 19 * scale, 4 * scale);
  c.fill();
  c.strokeStyle = 'rgba(255,245,224,0.22)';
  c.lineWidth = 1.2 * scale;
  c.beginPath();
  c.moveTo(24 * scale, hearthY - 2 * scale);
  c.lineTo(w - 24 * scale, hearthY - 2 * scale);
  c.stroke();

  // Framed stone arch around the opening to give the surround a clearer focal
  // structure than a flat wall of stone.
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = 16 * scale;
  c.strokeStyle = 'rgba(74,49,30,0.34)';
  c.beginPath();
  c.moveTo(ox - 6 * scale, oy + openH);
  c.lineTo(ox - 6 * scale, oy + openH * 0.28);
  c.quadraticCurveTo(w / 2, oy - 28 * scale, ox + openW + 6 * scale, oy + openH * 0.28);
  c.lineTo(ox + openW + 6 * scale, oy + openH);
  c.stroke();
  c.lineWidth = 7 * scale;
  c.strokeStyle = 'rgba(255,234,205,0.15)';
  c.beginPath();
  c.moveTo(ox - 2 * scale, oy + openH - 2 * scale);
  c.lineTo(ox - 2 * scale, oy + openH * 0.3);
  c.quadraticCurveTo(w / 2, oy - 18 * scale, ox + openW + 2 * scale, oy + openH * 0.3);
  c.lineTo(ox + openW + 2 * scale, oy + openH - 2 * scale);
  c.stroke();
  c.restore();
  c.fillStyle = '#b89267';
  roundRect(c, w / 2 - 12 * scale, oy - 12 * scale, 24 * scale, 18 * scale, 3 * scale);
  c.fill();
  c.fillStyle = 'rgba(255,243,221,0.2)';
  roundRect(c, w / 2 - 9 * scale, oy - 10 * scale, 18 * scale, 5 * scale, 2 * scale);
  c.fill();

  c.save();
  roundRect(c, ox, oy, openW, openH, 6 * scale);
  c.clip();
  // Red firebrick back wall, warmer at the bottom where the fire sits.
  const back = c.createLinearGradient(0, oy, 0, oy + openH);
  back.addColorStop(0, '#160c08');
  back.addColorStop(0.5, '#3a1d12');
  back.addColorStop(1, '#5c2c18');
  c.fillStyle = back;
  c.fillRect(ox, oy, openW, openH);

  // Firebrick courses.
  const bh = 11 * scale;
  for (let y = oy; y < oy + openH; y += bh) {
    const off = ((y - oy) / bh) % 2 === 0 ? 0 : 13 * scale;
    for (let x = ox - 13 * scale; x < ox + openW; x += 26 * scale) {
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 1;
      c.strokeRect(x + off, y, 26 * scale, bh);
    }
  }
  // Soot gradient up the back.
  const soot = c.createLinearGradient(0, oy, 0, oy + openH * 0.7);
  soot.addColorStop(0, 'rgba(0,0,0,0.85)');
  soot.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = soot;
  c.fillRect(ox, oy, openW, openH);

  // Grate + logs.
  const grateY = oy + openH - 16 * scale;
  c.strokeStyle = '#1b1b1d';
  c.lineWidth = 2.4 * scale;
  for (let i = 0; i <= 6; i++) {
    const gx = ox + 10 * scale + (i * (openW - 20 * scale)) / 6;
    c.beginPath();
    c.moveTo(gx, grateY);
    c.lineTo(gx, grateY + 13 * scale);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(ox + 8 * scale, grateY + 13 * scale);
  c.lineTo(ox + openW - 8 * scale, grateY + 13 * scale);
  c.stroke();

  const logs = [
    { x: ox + openW * 0.36, y: grateY - 3 * scale, rx: openW * 0.28, ry: 8 * scale, rot: -0.1 },
    { x: ox + openW * 0.64, y: grateY - 1 * scale, rx: openW * 0.26, ry: 7.5 * scale, rot: 0.09 },
    { x: ox + openW * 0.5, y: grateY - 14 * scale, rx: openW * 0.24, ry: 7 * scale, rot: 0.03 },
  ];
  for (const log of logs) {
    c.save();
    c.translate(log.x, log.y);
    c.rotate(log.rot);
    const lg = c.createLinearGradient(0, -log.ry, 0, log.ry);
    lg.addColorStop(0, '#4a2d1a');
    lg.addColorStop(0.45, '#2b180d');
    lg.addColorStop(1, '#120a05');
    c.fillStyle = lg;
    c.beginPath();
    c.ellipse(0, 0, log.rx, log.ry, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#54331d'; // cut end grain, lighter than the charred bark
    c.beginPath();
    c.ellipse(-log.rx * 0.86, 0, log.ry * 0.5, log.ry * 0.88, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  c.restore();

  // Recess shadow around the opening.
  c.save();
  roundRect(c, ox, oy, openW, openH, 6 * scale);
  c.strokeStyle = 'rgba(0,0,0,0.8)';
  c.lineWidth = 7 * scale;
  c.stroke();
  c.restore();

  // --- mantel beam ---------------------------------------------------------
  const beam = c.createLinearGradient(0, mantelY, 0, mantelY + mantelH);
  beam.addColorStop(0, '#8a5c33');
  beam.addColorStop(0.35, '#6b4325');
  beam.addColorStop(1, '#3d2414');
  c.fillStyle = beam;
  roundRect(c, -10 * scale, mantelY, w + 20 * scale, mantelH, 3 * scale);
  c.fill();
  c.strokeStyle = 'rgba(255,214,160,0.22)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(-8 * scale, mantelY + 1.5);
  c.lineTo(w + 8 * scale, mantelY + 1.5);
  c.stroke();
  for (let i = 0; i < 7; i++) {
    c.strokeStyle = `rgba(0,0,0,${0.12 + rand() * 0.16})`;
    c.lineWidth = 1;
    const gy = mantelY + 3 * scale + rand() * (mantelH - 6 * scale);
    c.beginPath();
    c.moveTo(-8 * scale, gy);
    c.bezierCurveTo(w * 0.3, gy + (rand() - 0.5) * 4, w * 0.7, gy - (rand() - 0.5) * 4, w + 8 * scale, gy);
    c.stroke();
  }

  // --- stockings hung from the beam ---------------------------------------
  if (opts.stockings !== false) {
    const sockColors = [colors.primary, '#e8e3d8', colors.primary, '#e8e3d8'];
    const cuffs = ['#f3efe6', '#c0182a', '#f3efe6', '#c0182a'];
    for (let i = 0; i < 4; i++) {
      const sx = w * (0.14 + i * 0.235);
      drawStocking(c, sx, mantelY + mantelH + 2 * scale, scale, sockColors[i], cuffs[i]);
    }
  }

  // --- candles standing on the mantel -------------------------------------
  // Bodies are baked; the flames are animated per frame (see drawFireplace).
  const candles = [];
  for (const [px, ch] of [[0.2, 30], [0.31, 20], [0.78, 26]]) {
    const cxp = w * px;
    const hgt = ch * scale;
    const cw = 9 * scale;
    const base = mantelY + 1;
    const wax = c.createLinearGradient(cxp - cw / 2, 0, cxp + cw / 2, 0);
    wax.addColorStop(0, '#b9ac93');
    wax.addColorStop(0.4, '#f2e9d4');
    wax.addColorStop(1, '#a99c85');
    c.fillStyle = wax;
    c.fillRect(cxp - cw / 2, base - hgt, cw, hgt);
    // Melted lip and wick.
    c.fillStyle = '#fbf5e6';
    c.beginPath();
    c.ellipse(cxp, base - hgt, cw / 2, 2.2 * scale, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#2b2118';
    c.lineWidth = 1.2 * scale;
    c.beginPath();
    c.moveTo(cxp, base - hgt - 1 * scale);
    c.lineTo(cxp, base - hgt - 4 * scale);
    c.stroke();
    candles.push({ x: cxp, y: base - hgt - 4 * scale, phase: rand() * 6.28 });
  }

  // --- garland draped on the mantel ---------------------------------------
  const garlandLights = drawMantelGarland(
    c, -6 * scale, mantelY - 10 * scale, w + 12 * scale, scale, colors, rand,
    opts.mantelGarland !== false
  );

  return {
    sprite: cv,
    candles,
    lights: garlandLights,
    geom: { w, h, ox, oy, openW, openH, fireX: ox + openW / 2, fireY: grateY + 6 * scale },
  };
}

/// Modern surround: a flat matte panel, a wide linear flame slot instead
/// of a tall arched firebox with logs, and a THIN SUSPENDED shelf — drawn
/// with a visible gap and a soft drop-shadow beneath it, rather than
/// resting on the wall the way the rustic beam does, which is what reads
/// as "floating" rather than "built in".
///
/// Returns the exact same shape as bakeRusticFireplace (sprite, candles,
/// lights, geom) so drawFireplace()'s per-frame animation — flame sheet,
/// embers, sparks, spill light, candles, garland, stockings — needs no
/// changes at all to support either style.
function bakeModernFireplace(scale, colors, opts) {
  const w = 300 * scale;
  const h = 250 * scale;
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(2024);

  // A floating shelf sits higher than the rustic beam, leaving more flat
  // panel visible above the firebox — the proportions a suspended,
  // minimalist mantel actually has.
  const mantelY = 46 * scale;
  const mantelH = 8 * scale;
  const plinthY = h - 30 * scale;

  // --- flat panel wall, brushed rather than textured -----------------------
  const panel = c.createLinearGradient(0, 0, 0, h);
  panel.addColorStop(0, '#383b42');
  panel.addColorStop(0.42, '#2a2d33');
  panel.addColorStop(1, '#181a1e');
  c.fillStyle = panel;
  c.fillRect(0, 0, w, h);
  const wash = c.createRadialGradient(w / 2, h * 0.48, 0, w / 2, h * 0.48, w * 0.54);
  wash.addColorStop(0, 'rgba(255,184,92,0.1)');
  wash.addColorStop(0.38, 'rgba(255,184,92,0.03)');
  wash.addColorStop(1, 'rgba(255,184,92,0)');
  c.fillStyle = wash;
  c.fillRect(0, 0, w, h);
  // Faint brushed-metal streaks: barely-there horizontal lines, not the
  // stone's rough mottling.
  for (let i = 0; i < 40; i++) {
    c.strokeStyle = `rgba(255,255,255,${0.015 + rand() * 0.02})`;
    c.lineWidth = 1;
    const y = rand() * h;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y + (rand() - 0.5) * 2);
    c.stroke();
  }
  // Slim fluted side bands stop the panel reading as a flat rectangle while
  // keeping the minimalist language of the insert.
  for (const bandX of [34 * scale, w - 46 * scale]) {
    const band = c.createLinearGradient(bandX, 0, bandX + 12 * scale, 0);
    band.addColorStop(0, 'rgba(255,255,255,0.02)');
    band.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    band.addColorStop(1, 'rgba(0,0,0,0.18)');
    c.fillStyle = band;
    roundRect(c, bandX, 22 * scale, 12 * scale, h - 56 * scale, 5 * scale);
    c.fill();
  }

  // --- wide, short linear firebox, flush with a slim dark bezel ------------
  const openW = w * 0.82;
  const openH = h * 0.17;
  const ox = (w - openW) / 2;
  const oy = h - openH - 14 * scale;

  // Floating plinth below the slot gives the modern insert some weight.
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.beginPath();
  c.ellipse(w / 2, h - 5 * scale, w * 0.28, 7 * scale, 0, 0, Math.PI * 2);
  c.fill();
  const plinth = c.createLinearGradient(0, plinthY, 0, h);
  plinth.addColorStop(0, '#e4ded2');
  plinth.addColorStop(0.45, '#c4beb2');
  plinth.addColorStop(1, '#8f877b');
  c.fillStyle = plinth;
  roundRect(c, 42 * scale, plinthY, w - 84 * scale, 20 * scale, 3 * scale);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(46 * scale, plinthY + 1.2 * scale);
  c.lineTo(w - 46 * scale, plinthY + 1.2 * scale);
  c.stroke();

  c.save();
  roundRect(c, ox - 5 * scale, oy - 5 * scale, openW + 10 * scale, openH + 10 * scale, 3 * scale);
  c.fillStyle = '#101113';
  c.fill();
  c.restore();

  c.save();
  roundRect(c, ox, oy, openW, openH, 2 * scale);
  c.clip();
  const back = c.createLinearGradient(0, oy, 0, oy + openH);
  back.addColorStop(0, '#0c0d0f');
  back.addColorStop(1, '#1c1512');
  c.fillStyle = back;
  c.fillRect(ox, oy, openW, openH);

  // A bed of glowing glass pebbles instead of logs — the fuel bed a
  // linear/bio-ethanol insert actually shows, and much cheaper to bake
  // than the rustic grate + three logs.
  const grateY = oy + openH - 6 * scale;
  const pebbleCount = Math.round(openW / (9 * scale));
  for (let i = 0; i < pebbleCount; i++) {
    const px = ox + ((i + 0.5) / pebbleCount) * openW + (rand() - 0.5) * 4 * scale;
    const py = grateY - rand() * 3 * scale;
    const pr = (2 + rand() * 2.4) * scale;
    const g = c.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0, 'rgba(255,214,168,0.9)');
    g.addColorStop(1, 'rgba(60,30,18,0.9)');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(px, py, pr, pr * 0.6, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();

  // Slim metal trim around the slot, with the strongest catchlight along the
  // upper edge like brushed black nickel.
  c.strokeStyle = 'rgba(255,255,255,0.1)';
  c.lineWidth = 1.2 * scale;
  roundRect(c, ox - 1 * scale, oy - 1 * scale, openW + 2 * scale, openH + 2 * scale, 2.5 * scale);
  c.stroke();
  c.strokeStyle = 'rgba(255,244,220,0.22)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(ox, oy - 1);
  c.lineTo(ox + openW, oy - 1);
  c.stroke();

  // --- suspended shelf, inset from the panel's own edges -------------------
  const shelfInset = 22 * scale;
  const shelfX = shelfInset;
  const shelfW = w - shelfInset * 2;

  // The gap under the shelf reads as "floating" only if something is
  // visibly different there — a soft shadow cast onto the panel below it.
  const gapShadow = c.createLinearGradient(0, mantelY + mantelH, 0, mantelY + mantelH + 14 * scale);
  gapShadow.addColorStop(0, 'rgba(0,0,0,0.35)');
  gapShadow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gapShadow;
  c.fillRect(shelfX, mantelY + mantelH, shelfW, 14 * scale);

  const shelf = c.createLinearGradient(0, mantelY, 0, mantelY + mantelH);
  shelf.addColorStop(0, '#f3eee5');
  shelf.addColorStop(0.5, '#d3cdc2');
  shelf.addColorStop(1, '#9d968a');
  c.fillStyle = shelf;
  roundRect(c, shelfX, mantelY, shelfW, mantelH, 1.5 * scale);
  c.fill();
  // A crisp highlight along the top front edge sells it as a hard,
  // machined slab rather than the beam's soft-worn wood.
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(shelfX + 2 * scale, mantelY + 1);
  c.lineTo(shelfX + shelfW - 2 * scale, mantelY + 1);
  c.stroke();

  // --- stockings hung from the shelf ---------------------------------------
  // A modern room is less likely to want the traditional four in a row by
  // default; the option itself is unchanged, only the default flips.
  if (opts.stockings === true) {
    const sockColors = [colors.primary, '#e8e3d8', colors.primary, '#e8e3d8'];
    const cuffs = ['#f3efe6', '#c0182a', '#f3efe6', '#c0182a'];
    for (let i = 0; i < 4; i++) {
      const sx = w * (0.14 + i * 0.235);
      drawStocking(c, sx, mantelY + mantelH + 2 * scale, scale, sockColors[i], cuffs[i]);
    }
  }

  // --- candles on the shelf -------------------------------------------------
  const candles = [];
  if (opts.candles !== false) {
    for (const [px, ch] of [[0.24, 22], [0.5, 15], [0.76, 26]]) {
      const cxp = w * px;
      const hgt = ch * scale;
      const cw = 7 * scale;
      const base = mantelY + 1;
      const wax = c.createLinearGradient(cxp - cw / 2, 0, cxp + cw / 2, 0);
      wax.addColorStop(0, '#d8d4cc');
      wax.addColorStop(0.5, '#f5f2ec');
      wax.addColorStop(1, '#c9c4ba');
      c.fillStyle = wax;
      c.fillRect(cxp - cw / 2, base - hgt, cw, hgt);
      c.strokeStyle = '#2b2118';
      c.lineWidth = 1.1 * scale;
      c.beginPath();
      c.moveTo(cxp, base - hgt - 1 * scale);
      c.lineTo(cxp, base - hgt - 4 * scale);
      c.stroke();
      candles.push({ x: cxp, y: base - hgt - 4 * scale, phase: rand() * 6.28 });
    }
  }

  // --- garland, understated: a single thin strand rather than the full
  // pine swag, if requested at all (default off — a bare shelf is the
  // point of the style) -----------------------------------------------------
  let garlandLights = [];
  if (opts.mantelGarland === true) {
    garlandLights = drawMantelGarland(
      c, -6 * scale, mantelY - 6 * scale, w + 12 * scale, scale, colors, rand, true
    );
  }

  return {
    sprite: cv,
    candles,
    lights: garlandLights,
    geom: { w, h, ox, oy, openW, openH, fireX: ox + openW / 2, fireY: grateY + 6 * scale },
  };
}

/// Picks the bake for the requested style. Any unrecognised value falls
/// back to 'rustic' rather than erroring — a bad/old theme value must
/// never leave the overlay without a fireplace at all.
function bakeFireplace(scale, colors, opts) {
  return opts.fireplaceStyle === 'modern'
    ? bakeModernFireplace(scale, colors, opts)
    : bakeRusticFireplace(scale, colors, opts);
}

// --- flame sprite sheet ------------------------------------------------------

let flameSheet = null;

/// Bakes a looping flame animation once. Per frame the fire then costs a
/// single drawImage instead of rebuilding seven bezier tongues and their
/// gradients — the difference between comfortably hitting a 120Hz budget
/// and not.
function bakeFlameSheet(fw, fh, scale) {
  const FRAMES = 36;
  const cv = makeCanvas(fw * FRAMES, fh);
  const c = cv.getContext('2d');
  c.globalCompositeOperation = 'lighter';

  const tongues = [
    { dx: -26, w: 20, hgt: 40, hue: [255, 78, 18], f: 2, ph: 0.0 },
    { dx: 25, w: 19, hgt: 36, hue: [255, 84, 20], f: 3, ph: 1.1 },
    { dx: -14, w: 22, hgt: 62, hue: [255, 102, 28], f: 2, ph: 2.4 },
    { dx: 14, w: 21, hgt: 58, hue: [255, 118, 34], f: 3, ph: 1.7 },
    { dx: -4, w: 24, hgt: 84, hue: [255, 152, 48], f: 2, ph: 3.4 },
    { dx: 5, w: 17, hgt: 96, hue: [255, 192, 84], f: 4, ph: 5.1 },
    { dx: -1, w: 10, hgt: 70, hue: [255, 238, 190], f: 5, ph: 2.2 },
  ];

  for (let frame = 0; frame < FRAMES; frame++) {
    // Frequencies are whole numbers so every tongue closes its cycle at the
    // end of the sheet and the loop is seamless.
    const t = (frame / FRAMES) * Math.PI * 2;
    const ox = frame * fw;
    const baseX = ox + fw / 2;
    const baseY = fh - 6 * scale;

    for (const tg of tongues) {
      const flick = 0.8 + 0.2 * Math.sin(t * tg.f + tg.ph);
      const sway = Math.sin(t * tg.f * 0.5 + tg.ph) * 5 * scale;
      const rootX = baseX + tg.dx * scale * 0.55;
      const tipX = baseX + tg.dx * scale + sway;
      const tipY = baseY - tg.hgt * scale * flick;
      const halfW = tg.w * scale * flick;
      const [r, g, b] = tg.hue;

      const grad = c.createLinearGradient(rootX, baseY, tipX, tipY);
      grad.addColorStop(0, `rgba(${r},${Math.round(g * 0.5)},8,0.5)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},0.42)`);
      grad.addColorStop(1, `rgba(${r},${Math.min(255, g + 60)},${Math.min(255, b + 80)},0)`);
      c.fillStyle = grad;
      c.beginPath();
      c.moveTo(rootX - halfW, baseY);
      c.bezierCurveTo(
        rootX - halfW * 1.15, baseY - (baseY - tipY) * 0.45,
        tipX - halfW * 0.5, baseY - (baseY - tipY) * 0.78,
        tipX, tipY
      );
      c.bezierCurveTo(
        tipX + halfW * 0.5, baseY - (baseY - tipY) * 0.78,
        rootX + halfW * 1.15, baseY - (baseY - tipY) * 0.45,
        rootX + halfW, baseY
      );
      c.closePath();
      c.fill();
    }
  }
  return { sheet: cv, frames: FRAMES, fw, fh };
}

/// Draws the fireplace: baked stonework, the flame sprite-sheet frame for
/// this moment, ember bed, sparks, and warm light spilling into the room.
export function drawFireplace(ctx, width, height, time, colors, spec = {}, opts = {}) {
  const scale = Math.max(0.6, Math.min(2.6, (height / 900) * (spec.scale ?? 1)));
  const key = `${scale.toFixed(2)}|${colors.primary}|${colors.secondary}|${spec.stockings}|${spec.mantelGarland}|${spec.candles}|${spec.fireplaceStyle}`;
  let cached = fireCache.get(key);
  if (!cached) {
    const baked = bakeFireplace(scale, colors, spec);
    const fw = Math.ceil(baked.geom.openW);
    const fh = Math.ceil(baked.geom.openH * 0.85);
    cached = { ...baked, flame: bakeFlameSheet(fw, fh, scale) };
    if (fireCache.size > 6) fireCache.clear();
    fireCache.set(key, cached);
  }
  const fireCacheEntry = cached;
  const { sprite, geom, lights, flame } = cached;
  const gain = (opts.lightIntensity ?? 1) * (opts.fireplaceContribution ?? 1) * (spec.lights?.intensity ?? 1);
  const palette = spec.palette ?? ['#ffd79a'];
  const mode = spec.lights?.mode ?? opts.lightAnimation;
  const speed = spec.lights?.speed ?? 1;
  const x = Math.round((spec.x ?? 0.5) * width - geom.w / 2);
  const y = height - geom.h;

  const fireX = x + geom.fireX;
  const fireY = y + geom.fireY;
  const breathe = 0.86 + 0.1 * Math.sin(time * 2.3) + 0.04 * Math.sin(time * 7.1);
  const shadowStrength = Math.max(0, opts.shadowStrength ?? 1);
  const shadowSoftness = Math.max(0.4, opts.shadowSoftness ?? 1);

  ctx.save();

  if (shadowStrength > 0) {
    const sw = geom.w * (0.86 + 0.28 * shadowSoftness);
    const sh = geom.h * (0.34 + 0.15 * shadowSoftness);
    ctx.globalAlpha = Math.min(0.34, 0.12 + 0.14 * shadowStrength);
    ctx.drawImage(FIREPLACE_SHADOW_SPRITE, x + geom.w / 2 - sw / 2, y + geom.h * 0.56 - sh * 0.2, sw, sh);
    ctx.globalAlpha = 1;
  }

  // Light thrown onto the floor and wall, drawn before the fireplace so it
  // reads as light landing on the room rather than a haze over the stone.
  const spill = glowSprite('#ff8c32', 128);
  ctx.globalCompositeOperation = 'lighter';
  const ss = 720 * scale * breathe;
  ctx.globalAlpha = Math.min(1, 0.3 * breathe * gain);
  ctx.drawImage(spill, fireX - ss / 2, fireY - ss * 0.52, ss, ss * 0.75);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(sprite, x, y);

  // Mantel garland lights.
  if (lights.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      const bulb = glowSprite(palette[i % palette.length], 48);
      const lit = bulbLevel(mode, time, i, l.phase, lights.length, speed);
      const s = (13 + 9 * lit) * (spec.lights?.size ?? 1);
      ctx.globalAlpha = Math.min(1, (0.5 + 0.5 * lit) * gain);
      ctx.drawImage(bulb, x + l.x - s / 2, y + l.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Candle flames: a warm bloom plus a small teardrop that leans as it
  // flickers, each on its own phase so they don't gutter in unison.
  if (spec.candles !== false && fireCacheEntry.candles?.length) {
    const halo = glowSprite('#ffc36b', 48);
    ctx.globalCompositeOperation = 'lighter';
    for (const cd of fireCacheEntry.candles) {
      const flick = 0.75 + 0.25 * Math.sin(time * 7.3 + cd.phase) + 0.1 * Math.sin(time * 17 + cd.phase);
      const fx = x + cd.x + Math.sin(time * 3.1 + cd.phase) * 0.7 * scale;
      const fy = y + cd.y;
      const hs = 30 * scale * flick;
      ctx.globalAlpha = 0.75 * flick;
      ctx.drawImage(halo, fx - hs / 2, fy - hs * 0.62, hs, hs);

      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffdf9a';
      ctx.beginPath();
      ctx.moveTo(fx, fy - 9 * scale * flick);
      ctx.quadraticCurveTo(fx + 2.6 * scale, fy - 2 * scale, fx, fy + 1.5 * scale);
      ctx.quadraticCurveTo(fx - 2.6 * scale, fy - 2 * scale, fx, fy - 9 * scale * flick);
      ctx.fill();
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath();
      ctx.ellipse(fx, fy - 3 * scale, 1.1 * scale, 2.6 * scale * flick, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Fire, clipped to the firebox. Rounded to whole pixels: a fractional
  // clip boundary leaves a 1px semi-transparent fringe around the
  // additive glow that reads as a dotted/dashed outline once the flame's
  // breathing animation makes it flicker frame to frame.
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    Math.round(x + geom.ox), Math.round(y + geom.oy),
    Math.round(geom.openW), Math.round(geom.openH)
  );
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';

  const emberGlow = glowSprite('#ff6a14', 96);
  const es = 190 * scale * breathe;
  ctx.globalAlpha = 0.55 * breathe;
  ctx.drawImage(emberGlow, fireX - es / 2, fireY - es * 0.42, es, es * 0.5);

  const frame = Math.floor((time * 26) % flame.frames);
  ctx.globalAlpha = breathe;
  ctx.drawImage(
    flame.sheet, frame * flame.fw, 0, flame.fw, flame.fh,
    fireX - flame.fw / 2, fireY - flame.fh + 8 * scale, flame.fw, flame.fh
  );

  ctx.globalAlpha = 1;
  for (let i = 0; i < 12; i++) {
    const seed = i * 1.618;
    const life = (time * (0.32 + (i % 5) * 0.05) + seed) % 1;
    const sx = fireX + Math.sin(seed * 9.7 + life * 6.2) * (14 + (i % 4) * 8) * scale;
    const sy = fireY - life * geom.openH * 0.85;
    ctx.fillStyle = `rgba(255,${clamp255(150 + 80 * (1 - life))},${clamp255(60 * (1 - life))},${(1 - life) * 0.8 * breathe})`;
    ctx.beginPath();
    ctx.arc(sx, sy, (0.8 + (i % 3) * 0.5) * scale * (1 - life * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}
