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

/// A hung cable with bulbs. The wire is one cheap stroked path; each bulb
/// is a baked glow sprite plus a tiny shaded body, so the whole string
/// costs a couple of dozen blits instead of a couple of dozen gradients.
export function drawGarland(ctx, width, time, colors, opts = {}) {
  const spacing = 54 * (opts.spacing ?? 1);
  const count = Math.max(2, Math.round(width / spacing));
  const sag = opts.sag ?? 1;
  const wireY = (t) => 8 + Math.sin(t * Math.PI * 2) * 4 * sag + Math.sin(t * Math.PI) * 26 * sag;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(16,20,26,0.8)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i <= count * 3; i++) {
    const t = i / (count * 3);
    const x = t * width;
    const y = wireY(t);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

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
  // Rich deep mortar base with gritty texture
  const mortarGrad = c.createLinearGradient(0, 0, 0, h);
  mortarGrad.addColorStop(0, '#1c1712');
  mortarGrad.addColorStop(0.5, '#16120e');
  mortarGrad.addColorStop(1, '#110d0a');
  c.fillStyle = mortarGrad;
  c.fillRect(0, 0, w, h);

  const rowH = 23 * scale;
  for (let y = 0; y < h; y += rowH) {
    let x = -10 * scale + rand() * 12 * scale;
    while (x < w + 10 * scale) {
      const sw = (26 + rand() * 52) * scale;
      const sh = rowH - 2.8 * scale;
      const tone = 0.70 + rand() * 0.55;
      // Warm limestone, fieldstone and river rock earthy color variations
      const stoneType = rand();
      let rVal, gVal, bVal;
      if (stoneType < 0.45) {
        // Warm sandstone / limestone
        const warm = rand() * 18;
        rVal = clamp255((145 + warm) * tone);
        gVal = clamp255((120 + warm * 0.5) * tone);
        bVal = clamp255((96 + warm * 0.2) * tone);
      } else if (stoneType < 0.75) {
        // Cool river stone / slate accent
        const cool = rand() * 12;
        rVal = clamp255((120 + cool * 0.4) * tone);
        gVal = clamp255((115 + cool * 0.4) * tone);
        bVal = clamp255((108 + cool * 0.5) * tone);
      } else {
        // Deep iron-rich brown stone
        const iron = rand() * 20;
        rVal = clamp255((155 + iron) * tone);
        gVal = clamp255((105 + iron * 0.4) * tone);
        bVal = clamp255((78 + iron * 0.2) * tone);
      }
      const base = `rgb(${rVal},${gVal},${bVal})`;

      // Directional 3D lighting gradient: top-left ambient light + bottom-right shadow
      const g = c.createLinearGradient(x, y, x + sw * 0.15, y + sh);
      g.addColorStop(0, shade(base, 22));
      g.addColorStop(0.25, shade(base, 10));
      g.addColorStop(0.65, base);
      g.addColorStop(0.9, shade(base, -18));
      g.addColorStop(1, shade(base, -28));
      c.fillStyle = g;
      roundRect(c, x, y, sw, sh, 3.8 * scale);
      c.fill();

      // Realistic mineral grain and porous chiseled stone texture
      for (let k = 0; k < 6; k++) {
        c.fillStyle = `rgba(18,12,8,${0.05 + rand() * 0.08})`;
        c.beginPath();
        c.ellipse(x + rand() * sw, y + rand() * sh, (2 + rand() * 6) * scale,
          (1.2 + rand() * 3.5) * scale, rand() * 3, 0, Math.PI * 2);
        c.fill();
        if (rand() > 0.35) {
          c.fillStyle = `rgba(255,250,240,${0.04 + rand() * 0.06})`;
          c.beginPath();
          c.ellipse(x + rand() * sw, y + rand() * sh, (1.8 + rand() * 4) * scale,
            (0.9 + rand() * 2.5) * scale, rand() * 3, 0, Math.PI * 2);
          c.fill();
        }
      }

      // Natural weathered chisel facets across the stone face
      c.strokeStyle = `rgba(255,248,230,${0.12 + rand() * 0.12})`;
      c.lineWidth = 1;
      c.beginPath();
      const facetY = y + (0.2 + rand() * 0.5) * sh;
      c.moveTo(x + 4 * scale, facetY);
      c.lineTo(x + sw * (0.4 + rand() * 0.4), facetY + (rand() - 0.5) * 3 * scale);
      c.stroke();

      // Crisp top edge chiseled highlight
      c.strokeStyle = 'rgba(255,248,232,0.26)';
      c.lineWidth = 1.2 * scale;
      c.beginPath();
      c.moveTo(x + 2.5 * scale, y + 1 * scale);
      c.lineTo(x + sw - 2.5 * scale, y + 1 * scale);
      c.stroke();

      // Left edge slight light catch
      c.strokeStyle = 'rgba(255,248,232,0.15)';
      c.lineWidth = 0.8 * scale;
      c.beginPath();
      c.moveTo(x + 1 * scale, y + 3 * scale);
      c.lineTo(x + 1 * scale, y + sh - 2 * scale);
      c.stroke();

      // Deep bottom joint recessed cast shadow
      c.strokeStyle = 'rgba(12,8,5,0.45)';
      c.lineWidth = 1.2 * scale;
      c.beginPath();
      c.moveTo(x + 1 * scale, y + sh);
      c.lineTo(x + sw - 1 * scale, y + sh);
      c.stroke();

      // Right edge drop shadow
      c.strokeStyle = 'rgba(12,8,5,0.30)';
      c.lineWidth = 0.8 * scale;
      c.beginPath();
      c.moveTo(x + sw, y + 2 * scale);
      c.lineTo(x + sw, y + sh);
      c.stroke();

      x += sw + 3.2 * scale;
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

  // Soft wall shadow of the stocking body and cuff cast onto the wall behind,
  // offset to the bottom-right rather than a floating floor shadow in mid-air.
  c.fillStyle = 'rgba(0,0,0,0.18)';
  c.beginPath();
  c.moveTo(2 * scale, 2 * scale);
  c.lineTo(w + 2 * scale, 2 * scale);
  c.lineTo(w * 0.92 + 2 * scale, h * 0.62 + 2 * scale);
  c.quadraticCurveTo(w * 0.92 + 2 * scale, h + 2 * scale, w * 0.45 + 2 * scale, h + 2 * scale);
  c.quadraticCurveTo(-w * 0.35 + 2 * scale, h + 2 * scale, 2 * scale, h * 0.6 + 2 * scale);
  c.closePath();
  c.fill();

  c.fillStyle = 'rgba(0,0,0,0.18)';
  roundRect(c, -1.5 * scale + 2 * scale, -7 * scale + 2 * scale, w + 3 * scale, 9 * scale, 2 * scale);
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
  c.strokeStyle = shade(cuffColor, -24);
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
  c.fillStyle = 'rgba(0,0,0,0.30)';
  c.beginPath();
  c.ellipse(w / 2, h - 3 * scale, w * 0.42, 10 * scale, 0, 0, Math.PI * 2);
  c.fill();

  // Multi-tier stone slab hearth with beveled edges and chiseled highlights
  const hearthTop = c.createLinearGradient(0, hearthY - 7 * scale, 0, hearthY + 10 * scale);
  hearthTop.addColorStop(0, '#e5d3ba');
  hearthTop.addColorStop(0.35, '#c8ab86');
  hearthTop.addColorStop(0.7, '#a5855e');
  hearthTop.addColorStop(1, '#7a5b3a');
  c.fillStyle = hearthTop;
  roundRect(c, 14 * scale, hearthY - 7 * scale, w - 28 * scale, 17 * scale, 5 * scale);
  c.fill();

  // Hearth top stone grain & texture
  for (let k = 0; k < 12; k++) {
    c.fillStyle = `rgba(0,0,0,${0.03 + rand() * 0.05})`;
    c.beginPath();
    c.ellipse(20 * scale + rand() * (w - 40 * scale), hearthY - 3 * scale + rand() * 10 * scale,
      (4 + rand() * 10) * scale, (1 + rand() * 2) * scale, 0, 0, Math.PI * 2);
    c.fill();
  }

  const hearthFace = c.createLinearGradient(0, hearthY + 3 * scale, 0, h);
  hearthFace.addColorStop(0, '#8e6840');
  hearthFace.addColorStop(0.5, '#6a4a2b');
  hearthFace.addColorStop(1, '#442e18');
  c.fillStyle = hearthFace;
  roundRect(c, 22 * scale, hearthY + 3 * scale, w - 44 * scale, 19 * scale, 4 * scale);
  c.fill();

  // Bevel highlight line
  c.strokeStyle = 'rgba(255,250,235,0.35)';
  c.lineWidth = 1.4 * scale;
  c.beginPath();
  c.moveTo(18 * scale, hearthY - 4 * scale);
  c.lineTo(w - 18 * scale, hearthY - 4 * scale);
  c.stroke();

  // Chamfer transition shadow
  c.strokeStyle = 'rgba(25,15,8,0.45)';
  c.lineWidth = 1.2 * scale;
  c.beginPath();
  c.moveTo(24 * scale, hearthY + 2 * scale);
  c.lineTo(w - 24 * scale, hearthY + 2 * scale);
  c.stroke();

  // Framed chiseled stone voussoir arch around the opening
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = 20 * scale;
  c.strokeStyle = 'rgba(38, 24, 14, 0.55)';
  c.beginPath();
  c.moveTo(ox - 8 * scale, oy + openH);
  c.lineTo(ox - 8 * scale, oy + openH * 0.28);
  c.quadraticCurveTo(w / 2, oy - 32 * scale, ox + openW + 8 * scale, oy + openH * 0.28);
  c.lineTo(ox + openW + 8 * scale, oy + openH);
  c.stroke();

  // Arch stones (voussoirs) with chiseled facets
  const archStoneGrad = c.createLinearGradient(0, oy - 30 * scale, 0, oy + openH);
  archStoneGrad.addColorStop(0, '#caa77d');
  archStoneGrad.addColorStop(0.5, '#a48158');
  archStoneGrad.addColorStop(1, '#785736');
  c.lineWidth = 13 * scale;
  c.strokeStyle = archStoneGrad;
  c.beginPath();
  c.moveTo(ox - 5 * scale, oy + openH);
  c.lineTo(ox - 5 * scale, oy + openH * 0.28);
  c.quadraticCurveTo(w / 2, oy - 26 * scale, ox + openW + 5 * scale, oy + openH * 0.28);
  c.lineTo(ox + openW + 5 * scale, oy + openH);
  c.stroke();

  // Voussoir joint cuts across the arch
  const numJoints = 14;
  for (let j = 0; j <= numJoints; j++) {
    const t = j / numJoints;
    // Parametric point along arch
    let jx, jy;
    if (t < 0.35) {
      const seg = t / 0.35;
      jx = ox - 5 * scale;
      jy = oy + openH * (1 - seg * 0.72);
    } else if (t > 0.65) {
      const seg = (t - 0.65) / 0.35;
      jx = ox + openW + 5 * scale;
      jy = oy + openH * (0.28 + seg * 0.72);
    } else {
      const seg = (t - 0.35) / 0.3;
      const angle = Math.PI * (1 - seg);
      jx = w / 2 - Math.cos(angle) * (openW * 0.5 + 5 * scale);
      jy = oy + openH * 0.28 - Math.sin(angle) * (openH * 0.45);
    }
    c.strokeStyle = 'rgba(25, 15, 8, 0.55)';
    c.lineWidth = 1.2 * scale;
    c.beginPath();
    c.arc(jx, jy, 4 * scale, 0, Math.PI * 2);
    c.stroke();
  }

  // Inner rim light along the inside of the arch
  c.lineWidth = 2.2 * scale;
  c.strokeStyle = 'rgba(255,240,215,0.30)';
  c.beginPath();
  c.moveTo(ox - 1 * scale, oy + openH - 2 * scale);
  c.lineTo(ox - 1 * scale, oy + openH * 0.3);
  c.quadraticCurveTo(w / 2, oy - 16 * scale, ox + openW + 1 * scale, oy + openH * 0.3);
  c.lineTo(ox + openW + 1 * scale, oy + openH - 2 * scale);
  c.stroke();
  c.restore();

  // Prominent carved decorative keystone at top of arch
  const keyW = 28 * scale;
  const keyH = 24 * scale;
  const keyX = w / 2 - keyW / 2;
  const keyY = oy - 16 * scale;
  const keyGrad = c.createLinearGradient(0, keyY, 0, keyY + keyH);
  keyGrad.addColorStop(0, '#deb88c');
  keyGrad.addColorStop(0.5, '#b99266');
  keyGrad.addColorStop(1, '#86613c');
  c.fillStyle = keyGrad;
  c.beginPath();
  c.moveTo(keyX - 2 * scale, keyY);
  c.lineTo(keyX + keyW + 2 * scale, keyY);
  c.lineTo(keyX + keyW - 3 * scale, keyY + keyH);
  c.lineTo(keyX + 3 * scale, keyY + keyH);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,248,230,0.35)';
  c.lineWidth = 1.2 * scale;
  c.stroke();
  c.strokeStyle = 'rgba(20,10,5,0.45)';
  c.lineWidth = 1.2 * scale;
  c.beginPath();
  c.moveTo(keyX + 3 * scale, keyY + keyH);
  c.lineTo(keyX + keyW - 3 * scale, keyY + keyH);
  c.stroke();

  c.save();
  roundRect(c, ox, oy, openW, openH, 6 * scale);
  c.clip();
  // Deep refractory firebrick back wall with realistic depth and soot
  const back = c.createLinearGradient(0, oy, 0, oy + openH);
  back.addColorStop(0, '#100806');
  back.addColorStop(0.35, '#26120b');
  back.addColorStop(0.7, '#3d1d12');
  back.addColorStop(1, '#5a2a16');
  c.fillStyle = back;
  c.fillRect(ox, oy, openW, openH);

  // Herringbone / running-bond refractory bricks with mortar relief
  const bh = 10 * scale;
  const bw = 24 * scale;
  for (let y = oy; y < oy + openH; y += bh) {
    const rowIdx = Math.floor((y - oy) / bh);
    const off = (rowIdx % 2 === 0) ? 0 : bw * 0.5;
    for (let x = ox - bw; x < ox + openW + bw; x += bw) {
      // Individual brick subtle tone variation
      const brickTone = 0.85 + (((rowIdx * 7 + Math.floor(x / bw) * 13) % 17) / 17) * 0.3;
      c.fillStyle = `rgba(${Math.round(110 * brickTone)},${Math.round(52 * brickTone)},${Math.round(32 * brickTone)},0.12)`;
      c.fillRect(x + off + 1, y + 1, bw - 2, bh - 2);

      // Mortar joint groove
      c.strokeStyle = 'rgba(38, 26, 20, 0.48)';
      c.lineWidth = 1.2 * scale;
      c.strokeRect(x + off, y, bw, bh);

      // Upper bevel catchlight on brick edge
      c.strokeStyle = 'rgba(255, 175, 110, 0.08)';
      c.lineWidth = 0.8;
      c.beginPath();
      c.moveTo(x + off + 1, y + 1);
      c.lineTo(x + off + bw - 1, y + 1);
      c.stroke();
    }
  }

  // Heavy soot accumulation at top and sides of chamber
  const soot = c.createLinearGradient(0, oy, 0, oy + openH * 0.75);
  soot.addColorStop(0, 'rgba(8,5,4,0.92)');
  soot.addColorStop(0.5, 'rgba(14,9,7,0.6)');
  soot.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = soot;
  c.fillRect(ox, oy, openW, openH);

  // Side corner shadows inside the box
  const sideShadowL = c.createLinearGradient(ox, 0, ox + 22 * scale, 0);
  sideShadowL.addColorStop(0, 'rgba(0,0,0,0.75)');
  sideShadowL.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sideShadowL;
  c.fillRect(ox, oy, 22 * scale, openH);

  const sideShadowR = c.createLinearGradient(ox + openW - 22 * scale, 0, ox + openW, 0);
  sideShadowR.addColorStop(0, 'rgba(0,0,0,0)');
  sideShadowR.addColorStop(1, 'rgba(0,0,0,0.75)');
  c.fillStyle = sideShadowR;
  c.fillRect(ox + openW - 22 * scale, oy, 22 * scale, openH);

  // Grate + logs.
  const grateY = oy + openH - 16 * scale;

  // Glowing ember bed under and behind the logs
  const emberW = openW * 0.78;
  const emberH = 20 * scale;
  const emberGrad = c.createRadialGradient(
    ox + openW / 2, grateY + 5 * scale, 3 * scale,
    ox + openW / 2, grateY + 5 * scale, emberW * 0.55
  );
  emberGrad.addColorStop(0, 'rgba(255, 140, 25, 0.95)');
  emberGrad.addColorStop(0.25, 'rgba(255, 80, 10, 0.85)');
  emberGrad.addColorStop(0.65, 'rgba(160, 25, 5, 0.55)');
  emberGrad.addColorStop(1, 'rgba(40, 10, 5, 0)');
  c.fillStyle = emberGrad;
  c.fillRect(ox + (openW - emberW) / 2, grateY - 6 * scale, emberW, emberH);

  // Ash and glowing charcoal chunks in the hearth
  for (let i = 0; i < 38; i++) {
    const coalX = ox + openW * 0.14 + rand() * openW * 0.72;
    const coalY = grateY + 1 * scale + rand() * 14 * scale;
    const coalR = (2.2 + rand() * 5.2) * scale;
    const isGlowing = rand() > 0.38;
    if (isGlowing) {
      const gHeat = rand();
      const r = 255;
      const g = clamp255(90 + gHeat * 140);
      const b = clamp255(15 + gHeat * 50);
      c.fillStyle = `rgba(${r},${g},${b},${0.85 + rand() * 0.15})`;
    } else {
      c.fillStyle = `rgba(${clamp255(24 + rand() * 28)},${clamp255(18 + rand() * 14)},${clamp255(16 + rand() * 12)},0.92)`;
    }
    c.beginPath();
    c.ellipse(coalX, coalY, coalR, coalR * (0.4 + rand() * 0.35), rand() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }

  // Cast-iron grate with realistic 3D tapered bars and andirons
  c.strokeStyle = '#2d2f34';
  c.lineWidth = 3.6 * scale;
  for (let i = 0; i <= 6; i++) {
    const gx = ox + 10 * scale + (i * (openW - 20 * scale)) / 6;
    c.beginPath();
    c.moveTo(gx, grateY - 3 * scale);
    c.lineTo(gx, grateY + 14 * scale);
    c.stroke();

    // Bar metallic highlight
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 1 * scale;
    c.beginPath();
    c.moveTo(gx - 0.8 * scale, grateY - 2 * scale);
    c.lineTo(gx - 0.8 * scale, grateY + 12 * scale);
    c.stroke();
    c.strokeStyle = '#2d2f34';
    c.lineWidth = 3.6 * scale;
  }
  // Front andiron crossbar with metallic highlight
  c.strokeStyle = '#1e2023';
  c.lineWidth = 4 * scale;
  c.beginPath();
  c.moveTo(ox + 6 * scale, grateY + 13 * scale);
  c.lineTo(ox + openW - 6 * scale, grateY + 13 * scale);
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.22)';
  c.lineWidth = 1 * scale;
  c.beginPath();
  c.moveTo(ox + 8 * scale, grateY + 12 * scale);
  c.lineTo(ox + openW - 8 * scale, grateY + 12 * scale);
  c.stroke();

  // Wrought iron finials and andiron legs
  for (const fx of [ox + 10 * scale, ox + openW - 10 * scale]) {
    c.fillStyle = '#18191c';
    c.beginPath();
    c.arc(fx, grateY - 5 * scale, 3.8 * scale, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.28)';
    c.beginPath();
    c.arc(fx - 1 * scale, grateY - 6 * scale, 1.2 * scale, 0, Math.PI * 2);
    c.fill();

    // Andiron foot
    c.fillStyle = '#141517';
    roundRect(c, fx - 3.5 * scale, grateY + 13 * scale, 7 * scale, 4 * scale, 1.5 * scale);
    c.fill();
  }

  const logs = [
    { x: ox + openW * 0.35, y: grateY - 3 * scale, rx: openW * 0.29, ry: 9 * scale, rot: -0.11 },
    { x: ox + openW * 0.65, y: grateY - 1 * scale, rx: openW * 0.27, ry: 8.5 * scale, rot: 0.10 },
    { x: ox + openW * 0.5, y: grateY - 14 * scale, rx: openW * 0.25, ry: 8 * scale, rot: 0.02 },
  ];
  for (const log of logs) {
    c.save();
    c.translate(log.x, log.y);
    c.rotate(log.rot);

    // Deep rough bark texture with natural wood curvature
    const lg = c.createLinearGradient(0, -log.ry, 0, log.ry);
    lg.addColorStop(0, '#583620');
    lg.addColorStop(0.25, '#402414');
    lg.addColorStop(0.65, '#26140b');
    lg.addColorStop(1, '#0e0704');
    c.fillStyle = lg;
    c.beginPath();
    c.ellipse(0, 0, log.rx, log.ry, 0, 0, Math.PI * 2);
    c.fill();

    // Natural wood bark ridges, fissures & peeling bark texture
    for (let r = 0; r < 7; r++) {
      const ridgeY = -log.ry * 0.7 + r * log.ry * 0.23;
      c.strokeStyle = r % 2 === 0 ? 'rgba(15,8,4,0.75)' : 'rgba(125,75,45,0.45)';
      c.lineWidth = (1.0 + (r % 3) * 0.4) * scale;
      c.beginPath();
      c.moveTo(-log.rx * 0.8, ridgeY);
      c.quadraticCurveTo(0, ridgeY + (r % 2 ? 2.2 : -2.2) * scale, log.rx * 0.8, ridgeY);
      c.stroke();
    }

    // Glowing fissures and incandescent charcoal embers running through the log center
    const fissGrad = c.createLinearGradient(0, -log.ry * 0.2, 0, log.ry * 0.6);
    fissGrad.addColorStop(0, 'rgba(255, 140, 25, 0.7)');
    fissGrad.addColorStop(0.5, 'rgba(255, 55, 10, 0.5)');
    fissGrad.addColorStop(1, 'rgba(180, 20, 5, 0)');
    c.fillStyle = fissGrad;
    c.beginPath();
    c.ellipse(0, log.ry * 0.35, log.rx * 0.65, log.ry * 0.45, 0, 0, Math.PI * 2);
    c.fill();

    // Micro incandescent hot cracks along the charred core
    for (let ck = 0; ck < 3; ck++) {
      c.strokeStyle = 'rgba(255, 200, 80, 0.65)';
      c.lineWidth = 1 * scale;
      c.beginPath();
      const ckX = (ck - 1) * log.rx * 0.35;
      c.moveTo(ckX - 8 * scale, log.ry * 0.3);
      c.lineTo(ckX + 8 * scale, log.ry * 0.35 + (ck % 2 ? 2 : -2) * scale);
      c.stroke();
    }

    // End grain cut with realistic tree growth rings and heartwood
    const endX = -log.rx * 0.86;
    const endRx = log.ry * 0.55;
    const endRy = log.ry * 0.92;
    const endGrad = c.createRadialGradient(endX, 0, 1 * scale, endX, 0, endRy);
    endGrad.addColorStop(0, '#8c5934');
    endGrad.addColorStop(0.6, '#6e4528');
    endGrad.addColorStop(1, '#3b2112');
    c.fillStyle = endGrad;
    c.beginPath();
    c.ellipse(endX, 0, endRx, endRy, 0, 0, Math.PI * 2);
    c.fill();

    // Concentric growth rings
    for (let ring = 1; ring <= 4; ring++) {
      c.strokeStyle = 'rgba(38, 20, 10, 0.55)';
      c.lineWidth = 0.8 * scale;
      c.beginPath();
      c.ellipse(endX, 0, endRx * (ring / 4.5), endRy * (ring / 4.5), 0, 0, Math.PI * 2);
      c.stroke();
    }

    // Radial drying cracks in the end grain
    c.strokeStyle = 'rgba(20, 10, 5, 0.75)';
    c.lineWidth = 1.1 * scale;
    c.beginPath();
    c.moveTo(endX, 0);
    c.lineTo(endX + endRx * 0.75, -endRy * 0.55);
    c.moveTo(endX, 0);
    c.lineTo(endX - endRx * 0.65, endRy * 0.45);
    c.moveTo(endX, 0);
    c.lineTo(endX + endRx * 0.4, endRy * 0.7);
    c.stroke();

    c.restore();
  }
  c.restore();

  // Recess shadow around the opening: feathered multi-pass shadow to avoid a harsh black outline.
  c.save();
  roundRect(c, ox, oy, openW, openH, 6 * scale);
  for (let i = 1; i <= 8; i++) {
    c.strokeStyle = 'rgba(0,0,0,0.08)';
    c.lineWidth = i * 2 * scale;
    c.stroke();
  }
  c.restore();

  // --- mantel beam ---------------------------------------------------------
  // Solid hand-hewn oak beam with rich warm undertones and end-grain overhang
  const beam = c.createLinearGradient(0, mantelY, 0, mantelY + mantelH);
  beam.addColorStop(0, '#a56f3e');
  beam.addColorStop(0.2, '#82522a');
  beam.addColorStop(0.6, '#5a361b');
  beam.addColorStop(0.85, '#3b200f');
  beam.addColorStop(1, '#221208');
  c.fillStyle = beam;
  roundRect(c, -12 * scale, mantelY, w + 24 * scale, mantelH, 3.5 * scale);
  c.fill();

  // Top chamfer edge highlight with warm wood sheen
  c.strokeStyle = 'rgba(255,230,190,0.38)';
  c.lineWidth = 1.8 * scale;
  c.beginPath();
  c.moveTo(-11 * scale, mantelY + 1.2 * scale);
  c.lineTo(w + 11 * scale, mantelY + 1.2 * scale);
  c.stroke();

  // Beam lower bevel highlight
  c.strokeStyle = 'rgba(255,210,160,0.18)';
  c.lineWidth = 1 * scale;
  c.beginPath();
  c.moveTo(-10 * scale, mantelY + mantelH - 2 * scale);
  c.lineTo(w + 10 * scale, mantelY + mantelH - 2 * scale);
  c.stroke();

  // Deep bottom edge cast shadow on stone underneath
  const mantelShadow = c.createLinearGradient(0, mantelY + mantelH, 0, mantelY + mantelH + 8 * scale);
  mantelShadow.addColorStop(0, 'rgba(10,5,2,0.65)');
  mantelShadow.addColorStop(1, 'rgba(10,5,2,0)');
  c.fillStyle = mantelShadow;
  c.fillRect(-12 * scale, mantelY + mantelH, w + 24 * scale, 8 * scale);

  // Wood grain, knot, and ax-hewn grooves
  for (let i = 0; i < 11; i++) {
    c.strokeStyle = `rgba(32, 15, 6, ${0.28 + rand() * 0.35})`;
    c.lineWidth = (0.7 + rand() * 0.9) * scale;
    const gy = mantelY + 3 * scale + rand() * (mantelH - 6 * scale);
    c.beginPath();
    c.moveTo(-11 * scale, gy);
    c.bezierCurveTo(w * 0.30, gy + (rand() - 0.5) * 6 * scale, w * 0.70, gy - (rand() - 0.5) * 6 * scale, w + 11 * scale, gy);
    c.stroke();
  }

  // A natural wood knot on the mantel beam
  const knotX = w * 0.72;
  const knotY = mantelY + mantelH * 0.52;
  c.fillStyle = 'rgba(35, 15, 5, 0.65)';
  c.beginPath();
  c.ellipse(knotX, knotY, 6.5 * scale, 4.2 * scale, 0.1, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(20, 8, 2, 0.8)';
  c.lineWidth = 1.2 * scale;
  c.beginPath();
  c.ellipse(knotX, knotY, 9.5 * scale, 6.5 * scale, 0.1, 0, Math.PI * 2);
  c.stroke();

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
  // Taller proportions: a real contemporary insert is often portrait-oriented.
  const w = 300 * scale;
  const h = 320 * scale;
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(2024);

  const mantelY = 52 * scale;
  const mantelH = 10 * scale;
  const plinthY = h - 42 * scale;

  // --- textured stone/concrete panel, not a flat rectangle -----------------
  const panel = c.createLinearGradient(0, 0, 0, h);
  panel.addColorStop(0, '#3a3d45');
  panel.addColorStop(0.45, '#2c2f36');
  panel.addColorStop(1, '#1a1c21');
  c.fillStyle = panel;
  c.fillRect(0, 0, w, h);

  // Soft fire-wash on the panel, stronger than before so the flame feels
  // like it is lighting the room rather than floating in a void.
  const wash = c.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, w * 0.62);
  wash.addColorStop(0, 'rgba(255,150,72,0.18)');
  wash.addColorStop(0.32, 'rgba(255,130,58,0.07)');
  wash.addColorStop(1, 'rgba(255,110,40,0)');
  c.fillStyle = wash;
  c.fillRect(0, 0, w, h);

  // Subtle stone grain, not just streaks.
  for (let i = 0; i < 90; i++) {
    const gx = rand() * w;
    const gy = rand() * h;
    const gw = (20 + rand() * 70) * scale;
    const gh = (2 + rand() * 5) * scale;
    c.fillStyle = `rgba(255,255,255,${0.012 + rand() * 0.018})`;
    c.beginPath();
    c.ellipse(gx, gy, gw, gh, rand() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }

  // Vertical brushed flutes for architectural rhythm.
  for (const bandX of [28 * scale, w - 40 * scale]) {
    const band = c.createLinearGradient(bandX, 0, bandX + 12 * scale, 0);
    band.addColorStop(0, 'rgba(255,255,255,0.03)');
    band.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    band.addColorStop(1, 'rgba(0,0,0,0.22)');
    c.fillStyle = band;
    roundRect(c, bandX, 18 * scale, 12 * scale, h - 68 * scale, 5 * scale);
    c.fill();
  }

  // --- tall portrait firebox with a glass front ----------------------------
  const openW = w * 0.62;
  const openH = h * 0.42;
  const ox = (w - openW) / 2;
  const oy = h - openH - 22 * scale;

  // Plinth: heavier, with realistic marble/quartz veins and floor shadow.
  c.fillStyle = 'rgba(0,0,0,0.38)';
  c.beginPath();
  c.ellipse(w / 2, h - 5 * scale, w * 0.36, 11 * scale, 0, 0, Math.PI * 2);
  c.fill();

  const plinth = c.createLinearGradient(0, plinthY, 0, h);
  plinth.addColorStop(0, '#f2ece4');
  plinth.addColorStop(0.25, '#dfd8cc');
  plinth.addColorStop(0.65, '#b8b1a3');
  plinth.addColorStop(1, '#868074');
  c.fillStyle = plinth;
  roundRect(c, 42 * scale, plinthY, w - 84 * scale, 30 * scale, 3 * scale);
  c.fill();

  // Subtle marble vein across plinth
  c.strokeStyle = 'rgba(140,130,120,0.25)';
  c.lineWidth = 1 * scale;
  c.beginPath();
  c.moveTo(55 * scale, plinthY + 8 * scale);
  c.bezierCurveTo(w * 0.4, plinthY + 12 * scale, w * 0.6, plinthY + 5 * scale, w - 60 * scale, plinthY + 15 * scale);
  c.stroke();

  c.strokeStyle = 'rgba(255,255,255,0.65)';
  c.lineWidth = 1.2 * scale;
  c.beginPath();
  c.moveTo(44 * scale, plinthY + 1.2 * scale);
  c.lineTo(w - 44 * scale, plinthY + 1.2 * scale);
  c.stroke();

  // Deep recess behind the glass with subtle chamfer
  c.save();
  roundRect(c, ox - 9 * scale, oy - 9 * scale, openW + 18 * scale, openH + 18 * scale, 4 * scale);
  const recess = c.createLinearGradient(ox, oy, ox + openW, oy + openH);
  recess.addColorStop(0, '#07080a');
  recess.addColorStop(0.5, '#121417');
  recess.addColorStop(1, '#050607');
  c.fillStyle = recess;
  c.fill();
  c.restore();

  c.save();
  roundRect(c, ox, oy, openW, openH, 2 * scale);
  c.clip();
  const back = c.createLinearGradient(ox, oy, ox, oy + openH);
  back.addColorStop(0, '#0b0c0e');
  back.addColorStop(0.6, '#181412');
  back.addColorStop(1, '#2c1a10');
  c.fillStyle = back;
  c.fillRect(ox, oy, openW, openH);

  // Modern rear fluted glass or ribbed black ceramic refractory back panel
  const fluteW = 8 * scale;
  for (let fx = ox; fx < ox + openW; fx += fluteW) {
    const fg = c.createLinearGradient(fx, 0, fx + fluteW, 0);
    fg.addColorStop(0, 'rgba(255,255,255,0.03)');
    fg.addColorStop(0.5, 'rgba(0,0,0,0)');
    fg.addColorStop(1, 'rgba(0,0,0,0.3)');
    c.fillStyle = fg;
    c.fillRect(fx, oy, fluteW, openH);
  }

  // Linear stainless steel burner trough along bottom of firebox
  const burnerY = oy + openH - 10 * scale;
  const burnerGrad = c.createLinearGradient(ox, burnerY, ox, burnerY + 4 * scale);
  burnerGrad.addColorStop(0, '#383b42');
  burnerGrad.addColorStop(0.4, '#5a5e69');
  burnerGrad.addColorStop(1, '#1e2024');
  c.fillStyle = burnerGrad;
  c.fillRect(ox + 8 * scale, burnerY, openW - 16 * scale, 3 * scale);
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = 0.8 * scale;
  c.beginPath();
  c.moveTo(ox + 8 * scale, burnerY);
  c.lineTo(ox + openW - 8 * scale, burnerY);
  c.stroke();

  // Glowing ember bed behind the glass with ceramic log accents and river stones / glass crystals
  const grateY = oy + openH - 8 * scale;
  const emberCount = Math.round(openW / (4.8 * scale));
  for (let i = 0; i < emberCount; i++) {
    const px = ox + ((i + 0.5) / emberCount) * openW + (rand() - 0.5) * 5 * scale;
    const py = grateY - rand() * 5 * scale;
    const pr = (2.4 + rand() * 3.2) * scale;
    const heat = 0.55 + rand() * 0.45;
    const g = c.createRadialGradient(px, py, 0, px, py, pr * 1.8);
    g.addColorStop(0, `rgba(255,${Math.round(140 + heat * 90)},${Math.round(heat * 80)},${0.9 + rand() * 0.1})`);
    g.addColorStop(0.45, `rgba(255,${Math.round(85 + heat * 65)},25,${0.5 + rand() * 0.3})`);
    g.addColorStop(1, 'rgba(60,22,12,0)');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(px, py, pr, pr * 0.55, 0, 0, Math.PI * 2);
    c.fill();
  }

  // Modern fire glass / basalt crystals on the bed
  for (let i = 0; i < 22; i++) {
    const cx = ox + 14 * scale + rand() * (openW - 28 * scale);
    const cy = grateY - 1 * scale + (rand() - 0.5) * 6 * scale;
    const cw = (3 + rand() * 4) * scale;
    const ch = (2 + rand() * 2.5) * scale;
    c.fillStyle = rand() > 0.4
      ? `rgba(255,${Math.round(180 + rand() * 70)},${Math.round(100 + rand() * 50)},0.75)`
      : `rgba(${Math.round(40 + rand() * 30)},${Math.round(42 + rand() * 25)},${Math.round(48 + rand() * 25)},0.85)`;
    c.beginPath();
    c.moveTo(cx - cw / 2, cy);
    c.lineTo(cx, cy - ch / 2);
    c.lineTo(cx + cw / 2, cy);
    c.lineTo(cx, cy + ch / 2);
    c.closePath();
    c.fill();
    // Crystal specular sparkle
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.fillRect(cx - 0.5 * scale, cy - 0.5 * scale, 1 * scale, 1 * scale);
  }

  // Linear ceramic driftwood pieces across the modern ribbon burner
  const ceramicLogs = [
    { x: ox + openW * 0.26, y: grateY - 4 * scale, w: openW * 0.28, h: 5 * scale, rot: -0.06 },
    { x: ox + openW * 0.72, y: grateY - 3.5 * scale, w: openW * 0.30, h: 4.5 * scale, rot: 0.05 },
    { x: ox + openW * 0.48, y: grateY - 6.5 * scale, w: openW * 0.34, h: 4 * scale, rot: -0.02 },
  ];
  for (const cl of ceramicLogs) {
    c.save();
    c.translate(cl.x, cl.y);
    c.rotate(cl.rot);
    const clogGrad = c.createLinearGradient(0, -cl.h, 0, cl.h);
    clogGrad.addColorStop(0, '#66615b');
    clogGrad.addColorStop(0.35, '#423d38');
    clogGrad.addColorStop(0.75, '#252320');
    clogGrad.addColorStop(1, '#131210');
    c.fillStyle = clogGrad;
    roundRect(c, -cl.w / 2, -cl.h / 2, cl.w, cl.h, 2.2 * scale);
    c.fill();

    // Subtle bleached driftwood grain lines
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.lineWidth = 0.8 * scale;
    c.beginPath();
    c.moveTo(-cl.w * 0.42, -cl.h * 0.2);
    c.lineTo(cl.w * 0.42, -cl.h * 0.2);
    c.stroke();

    // Glowing underside reflection
    c.fillStyle = 'rgba(255, 120, 25, 0.55)';
    c.fillRect(-cl.w * 0.4, 0, cl.w * 0.8, cl.h / 2);
    c.restore();
  }
  c.restore();

  // Glass reflection: realistic multi-layer subtle reflections across the glass panel
  c.save();
  roundRect(c, ox, oy, openW, openH, 2 * scale);
  c.clip();
  const glass = c.createLinearGradient(ox, oy, ox + openW * 0.7, oy + openH * 0.8);
  glass.addColorStop(0, 'rgba(255,255,255,0.09)');
  glass.addColorStop(0.25, 'rgba(255,255,255,0.02)');
  glass.addColorStop(0.5, 'rgba(255,255,255,0)');
  glass.addColorStop(0.75, 'rgba(255,255,255,0.05)');
  glass.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = glass;
  c.fillRect(ox, oy, openW, openH);

  // Soft specular edge reflection on the glass bevel
  c.strokeStyle = 'rgba(255,255,255,0.15)';
  c.lineWidth = 1 * scale;
  c.strokeRect(ox + 1, oy + 1, openW - 2, openH - 2);
  c.restore();

  // Bevelled black metal frame with catchlights.
  c.save();
  roundRect(c, ox - 6 * scale, oy - 6 * scale, openW + 12 * scale, openH + 12 * scale, 4 * scale);
  const frameGrad = c.createLinearGradient(ox - 6 * scale, oy - 6 * scale, ox - 6 * scale, oy + openH + 12 * scale);
  frameGrad.addColorStop(0, '#4a4d54');
  frameGrad.addColorStop(0.15, '#2b2d32');
  frameGrad.addColorStop(1, '#111214');
  c.fillStyle = frameGrad;
  c.fill();
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,0.12)';
  c.lineWidth = 1.2 * scale;
  roundRect(c, ox - 1 * scale, oy - 1 * scale, openW + 2 * scale, openH + 2 * scale, 2.5 * scale);
  c.stroke();
  c.strokeStyle = 'rgba(255,244,220,0.28)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(ox, oy - 1);
  c.lineTo(ox + openW, oy - 1);
  c.stroke();

  // --- floating shelf with stronger shadow and rim light -------------------
  const shelfInset = 26 * scale;
  const shelfX = shelfInset;
  const shelfW = w - shelfInset * 2;

  const gapShadow = c.createLinearGradient(0, mantelY + mantelH, 0, mantelY + mantelH + 18 * scale);
  gapShadow.addColorStop(0, 'rgba(0,0,0,0.45)');
  gapShadow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gapShadow;
  c.fillRect(shelfX, mantelY + mantelH, shelfW, 18 * scale);

  const shelf = c.createLinearGradient(0, mantelY, 0, mantelY + mantelH);
  shelf.addColorStop(0, '#f6f1e8');
  shelf.addColorStop(0.5, '#d8d2c6');
  shelf.addColorStop(1, '#a9a294');
  c.fillStyle = shelf;
  roundRect(c, shelfX, mantelY, shelfW, mantelH, 1.5 * scale);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.60)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(shelfX + 2 * scale, mantelY + 1);
  c.lineTo(shelfX + shelfW - 2 * scale, mantelY + 1);
  c.stroke();

  // --- stockings -----------------------------------------------------------
  if (opts.stockings === true) {
    const sockColors = [colors.primary, '#e8e3d8', colors.primary, '#e8e3d8'];
    const cuffs = ['#f3efe6', '#c0182a', '#f3efe6', '#c0182a'];
    for (let i = 0; i < 4; i++) {
      const sx = w * (0.14 + i * 0.235);
      drawStocking(c, sx, mantelY + mantelH + 2 * scale, scale, sockColors[i], cuffs[i]);
    }
  }

  // --- candles -------------------------------------------------------------
  const candles = [];
  if (opts.candles !== false) {
    for (const [px, ch] of [[0.24, 24], [0.5, 18], [0.76, 28]]) {
      const cxp = w * px;
      const hgt = ch * scale;
      const cw = 7.5 * scale;
      const base = mantelY + 1;
      const wax = c.createLinearGradient(cxp - cw / 2, 0, cxp + cw / 2, 0);
      wax.addColorStop(0, '#e2ddd2');
      wax.addColorStop(0.5, '#faf6ed');
      wax.addColorStop(1, '#cdc7bc');
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

  // --- garland -------------------------------------------------------------
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

/// Bakes a realistic multi-layered, multi-frequency looping flame animation once.
/// Real wood flames have distinct combustion physics:
///   1. A blue/violet-white high-energy root envelope at the base of the fuel
///   2. A broad turbulent golden/deep-orange mantle that licks upward
///   3. Dancing luminous yellow tongues that whip and curl
///   4. Intense incandescence (white-hot core) at the heart of the fuel bed
///   5. Smoked dark amber flame tips that fade naturally
/// Bakes seamlessly so frame cost remains a single drawImage.
function bakeFlameSheet(fw, fh, scale) {
  const FRAMES = 40;
  const cv = makeCanvas(fw * FRAMES, fh);
  const c = cv.getContext('2d');
  c.globalCompositeOperation = 'lighter';

  // Base flame envelope (deep ambient fire volume)
  const baseFlames = [
    { dx: -28, w: 26, hgt: 48, hue: [230, 50, 8], alpha: 0.50, f: 2, ph: 0.3 },
    { dx: 26, w: 25, hgt: 46, hue: [230, 55, 10], alpha: 0.50, f: 3, ph: 1.5 },
    { dx: -12, w: 36, hgt: 72, hue: [240, 75, 15], alpha: 0.55, f: 2, ph: 2.8 },
    { dx: 14, w: 34, hgt: 68, hue: [240, 80, 16], alpha: 0.55, f: 3, ph: 3.9 },
    { dx: 0, w: 42, hgt: 92, hue: [248, 95, 20], alpha: 0.60, f: 2, ph: 0.9 },
  ];

  // Primary dancing tongues: natural curling flame geometry
  const mainTongues = [
    { dx: -24, w: 18, hgt: 58, hue: [255, 115, 24], f1: 2, f2: 4, ph1: 0.5, ph2: 1.2, curl: -0.32 },
    { dx: 22, w: 17, hgt: 56, hue: [255, 120, 26], f1: 3, f2: 5, ph1: 1.8, ph2: 2.4, curl: 0.32 },
    { dx: -13, w: 22, hgt: 84, hue: [255, 150, 36], f1: 2, f2: 4, ph1: 2.9, ph2: 0.8, curl: -0.28 },
    { dx: 14, w: 21, hgt: 82, hue: [255, 155, 38], f1: 3, f2: 6, ph1: 4.1, ph2: 3.1, curl: 0.28 },
    { dx: -4, w: 24, hgt: 110, hue: [255, 180, 55], f1: 2, f2: 5, ph1: 1.1, ph2: 4.2, curl: -0.18 },
    { dx: 6, w: 20, hgt: 104, hue: [255, 190, 62], f1: 4, f2: 7, ph1: 5.3, ph2: 1.7, curl: 0.22 },
    { dx: -1, w: 18, hgt: 118, hue: [255, 210, 88], f1: 3, f2: 6, ph1: 3.4, ph2: 5.0, curl: 0.06 },
  ];

  // High-temperature white-hot inner cores
  const coreTongues = [
    { dx: -7, w: 14, hgt: 54, hue: [255, 240, 170], f: 3, ph: 0.7 },
    { dx: 6, w: 13, hgt: 50, hue: [255, 242, 175], f: 4, ph: 2.2 },
    { dx: 0, w: 15, hgt: 66, hue: [255, 252, 210], f: 2, ph: 4.0 },
    { dx: -2, w: 8, hgt: 38, hue: [255, 255, 245], f: 5, ph: 1.4 },
  ];

  // Realistic blue/violet flame base (combustion zone directly on wood fuel)
  const blueBase = [
    { dx: -18, w: 16, hgt: 16, hue: [60, 95, 255], ph: 0.0 },
    { dx: -6, w: 20, hgt: 20, hue: [80, 130, 255], ph: 1.2 },
    { dx: 8, w: 20, hgt: 19, hue: [80, 125, 255], ph: 2.4 },
    { dx: 18, w: 16, hgt: 15, hue: [60, 90, 250], ph: 3.6 },
  ];

  // Fine flicking wisps and licking tendrils detaching from the flame tops
  const flameWisps = [
    { dx: -10, w: 9, hgt: 26, hue: [255, 160, 40], f: 4, ph: 0.8, yOff: 80 },
    { dx: 8, w: 8, hgt: 24, hue: [255, 150, 35], f: 5, ph: 2.1, yOff: 75 },
    { dx: -1, w: 10, hgt: 30, hue: [255, 175, 50], f: 3, ph: 4.3, yOff: 94 },
    { dx: 4, w: 7, hgt: 22, hue: [255, 140, 30], f: 6, ph: 1.5, yOff: 86 },
  ];

  for (let frame = 0; frame < FRAMES; frame++) {
    // Seamless cyclical time parameter
    const t = (frame / FRAMES) * Math.PI * 2;
    const ox = frame * fw;
    const baseX = ox + fw / 2;
    const baseY = fh - 4 * scale;

    // 1. Blue combustion base layer at the bottom of the fuel bed
    for (const b of blueBase) {
      const flick = 0.85 + 0.15 * Math.sin(t * 3 + b.ph);
      const rootX = baseX + b.dx * scale;
      const rootY = baseY + 2 * scale;
      const tipY = baseY - b.hgt * scale * flick;
      const hw = b.w * scale * flick * 0.5;
      const [r, g, bl] = b.hue;

      const grad = c.createLinearGradient(rootX, rootY, rootX, tipY);
      grad.addColorStop(0, `rgba(${r},${g},${bl},0.65)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${bl},0.3)`);
      grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
      c.fillStyle = grad;
      c.beginPath();
      c.moveTo(rootX - hw, rootY);
      c.quadraticCurveTo(rootX - hw * 0.35, (rootY + tipY) * 0.5, rootX, tipY);
      c.quadraticCurveTo(rootX + hw * 0.35, (rootY + tipY) * 0.5, rootX + hw, rootY);
      c.closePath();
      c.fill();
    }

    // 2. Wide base orange/red thermal mantle
    for (const bg of baseFlames) {
      const flick = 0.82 + 0.18 * Math.sin(t * bg.f + bg.ph);
      const sway = Math.sin(t * bg.f * 0.5 + bg.ph) * 5 * scale;
      const rootX = baseX + bg.dx * scale * 0.6;
      const tipX = baseX + bg.dx * scale + sway;
      const tipY = baseY - bg.hgt * scale * flick;
      const halfW = bg.w * scale * flick;
      const [r, g, b] = bg.hue;

      const grad = c.createLinearGradient(rootX, baseY, tipX, tipY);
      grad.addColorStop(0, `rgba(${r},${Math.round(g * 0.4)},4,${bg.alpha * 0.95})`);
      grad.addColorStop(0.35, `rgba(${r},${g},${b},${bg.alpha})`);
      grad.addColorStop(0.75, `rgba(${r},${Math.min(255, g + 45)},${Math.min(255, b + 35)},${bg.alpha * 0.35})`);
      grad.addColorStop(1, `rgba(${r},${g},0,0)`);
      c.fillStyle = grad;
      c.beginPath();
      c.moveTo(rootX - halfW, baseY);
      c.bezierCurveTo(
        rootX - halfW * 1.15, baseY - (baseY - tipY) * 0.4,
        tipX - halfW * 0.45, baseY - (baseY - tipY) * 0.75,
        tipX, tipY
      );
      c.bezierCurveTo(
        tipX + halfW * 0.45, baseY - (baseY - tipY) * 0.75,
        rootX + halfW * 1.15, baseY - (baseY - tipY) * 0.4,
        rootX + halfW, baseY
      );
      c.closePath();
      c.fill();
    }

    // 3. Primary energetic dancing flame tongues with natural turbulence & curling
    for (const tg of mainTongues) {
      const flick = 0.78 + 0.16 * Math.sin(t * tg.f1 + tg.ph1) + 0.06 * Math.sin(t * tg.f2 + tg.ph2);
      const sway = (Math.sin(t * tg.f1 * 0.5 + tg.ph1) * 6 + Math.sin(t * tg.f2 + tg.ph2) * 3.5) * scale;
      const rootX = baseX + tg.dx * scale * 0.5;
      const tipX = baseX + tg.dx * scale + sway + tg.curl * 12 * scale * flick;
      const tipY = baseY - tg.hgt * scale * flick;
      const halfW = tg.w * scale * flick;
      const [r, g, b] = tg.hue;

      // Realistic flame gradient: warm ember red at base -> rich golden yellow -> incandescent tip -> soft fade
      const grad = c.createLinearGradient(rootX, baseY, tipX, tipY);
      grad.addColorStop(0, `rgba(${r},${Math.round(g * 0.45)},6,0.78)`);
      grad.addColorStop(0.32, `rgba(${r},${g},${b},0.68)`);
      grad.addColorStop(0.72, `rgba(${r},${Math.min(255, g + 45)},${Math.min(255, b + 60)},0.48)`);
      grad.addColorStop(1, `rgba(255,${Math.min(255, g + 75)},${Math.min(255, b + 90)},0)`);
      c.fillStyle = grad;

      // Asymmetric flame tongues with dynamic waist constriction and organic flame flick
      const waistShift = Math.sin(t * tg.f2 + tg.ph1) * 3.8 * scale;
      c.beginPath();
      c.moveTo(rootX - halfW, baseY);
      c.bezierCurveTo(
        rootX - halfW * 1.08 + waistShift, baseY - (baseY - tipY) * 0.38,
        tipX - halfW * 0.32 + waistShift * 0.6, baseY - (baseY - tipY) * 0.74,
        tipX, tipY
      );
      c.bezierCurveTo(
        tipX + halfW * 0.32 + waistShift * 0.6, baseY - (baseY - tipY) * 0.74,
        rootX + halfW * 1.08 + waistShift, baseY - (baseY - tipY) * 0.38,
        rootX + halfW, baseY
      );
      c.closePath();
      c.fill();
    }

    // 4. Detaching flame wisps / licking tongues near top
    for (const w of flameWisps) {
      const wFlick = 0.7 + 0.3 * Math.sin(t * w.f + w.ph);
      const wLift = (1 - ((t * w.f * 0.2 + w.ph) % 1)) * 14 * scale;
      const wY = baseY - w.yOff * scale - wLift;
      const wX = baseX + w.dx * scale + Math.sin(t * w.f * 0.5 + w.ph) * 8 * scale;
      const [r, g, b] = w.hue;

      const wGrad = c.createRadialGradient(wX, wY, 0, wX, wY, w.w * scale * wFlick);
      wGrad.addColorStop(0, `rgba(${r},${g},${b},${0.5 * wFlick})`);
      wGrad.addColorStop(0.6, `rgba(${r},${Math.round(g * 0.6)},${b},${0.25 * wFlick})`);
      wGrad.addColorStop(1, `rgba(${r},${g},0,0)`);
      c.fillStyle = wGrad;
      c.beginPath();
      c.ellipse(wX, wY, w.w * scale * wFlick * 0.6, (w.hgt * scale * wFlick) * 0.5, 0.1, 0, Math.PI * 2);
      c.fill();
    }

    // 5. White-hot incandescent core (maximum luminance at flame center)
    for (const core of coreTongues) {
      const flick = 0.82 + 0.18 * Math.sin(t * core.f + core.ph);
      const sway = Math.sin(t * core.f * 0.5 + core.ph) * 3.5 * scale;
      const rootX = baseX + core.dx * scale * 0.4;
      const tipX = baseX + core.dx * scale + sway;
      const tipY = baseY - core.hgt * scale * flick;
      const halfW = core.w * scale * flick;
      const [r, g, b] = core.hue;

      const grad = c.createLinearGradient(rootX, baseY, tipX, tipY);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.92)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},0.72)`);
      grad.addColorStop(0.85, `rgba(${r},${Math.round(g * 0.85)},${Math.round(b * 0.5)},0.35)`);
      grad.addColorStop(1, `rgba(255,180,40,0)`);
      c.fillStyle = grad;

      c.beginPath();
      c.moveTo(rootX - halfW, baseY);
      c.bezierCurveTo(
        rootX - halfW * 0.8, baseY - (baseY - tipY) * 0.42,
        tipX - halfW * 0.3, baseY - (baseY - tipY) * 0.75,
        tipX, tipY
      );
      c.bezierCurveTo(
        tipX + halfW * 0.3, baseY - (baseY - tipY) * 0.75,
        rootX + halfW * 0.8, baseY - (baseY - tipY) * 0.42,
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

  // Multi-tier ember bed illumination: deep red-orange base + golden hot center + hot combustion core
  const emberGlow = glowSprite('#ff5410', 128);
  const coreGlow = glowSprite('#ffb530', 80);
  const whiteCoreGlow = glowSprite('#fff0a0', 48);

  const es = 230 * scale * breathe;
  ctx.globalAlpha = 0.62 * breathe;
  ctx.drawImage(emberGlow, fireX - es / 2, fireY - es * 0.44, es, es * 0.52);

  const cs = 130 * scale * breathe;
  ctx.globalAlpha = 0.52 * breathe;
  ctx.drawImage(coreGlow, fireX - cs / 2, fireY - cs * 0.38, cs, cs * 0.45);

  const ws = 70 * scale * breathe;
  ctx.globalAlpha = 0.40 * breathe;
  ctx.drawImage(whiteCoreGlow, fireX - ws / 2, fireY - ws * 0.35, ws, ws * 0.40);

  const frame = Math.floor((time * 26) % flame.frames);
  ctx.globalAlpha = breathe;
  ctx.drawImage(
    flame.sheet, frame * flame.fw, 0, flame.fw, flame.fh,
    fireX - flame.fw / 2, fireY - flame.fh + 8 * scale, flame.fw, flame.fh
  );

  // Dynamic rising embers with natural swirling trajectories and cooling color gradient
  ctx.globalAlpha = 1;
  for (let i = 0; i < 28; i++) {
    const seed = i * 1.618;
    const speedRate = 0.25 + (i % 8) * 0.04;
    const life = (time * speedRate + seed) % 1;
    // Upward draft with thermal convective vortex curls
    const swirlFreq = 5.4 + (i % 3) * 2.2;
    const swirlPhase = seed * 8.3;
    const draftSpread = (18 + (i % 6) * 8) * scale;
    const sx = fireX + Math.sin(swirlPhase + life * swirlFreq) * draftSpread * (0.35 + life * 0.85)
      + Math.cos(life * 9.1 + seed) * (4 * scale);
    const sy = fireY - life * geom.openH * 0.94;
    const sz = (0.6 + (i % 4) * 0.42) * scale * (1 - life * 0.35);

    // Glowing ember cools from golden white -> hot yellow -> deep vermillion orange
    const rCol = 255;
    const gCol = clamp255(210 * (1 - life * 0.8));
    const bCol = clamp255(75 * Math.max(0, 1 - life * 2.2));
    const alpha = (1 - life) * (0.85 + 0.15 * Math.sin(time * 12 + seed)) * breathe;

    ctx.fillStyle = `rgba(${rCol},${gCol},${bCol},${alpha})`;
    ctx.beginPath();
    ctx.arc(sx, sy, sz, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}
