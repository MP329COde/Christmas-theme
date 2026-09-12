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
function glowSprite(color, size = 64) {
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
// garland (top of screen)
// ---------------------------------------------------------------------------

/// A hung cable with bulbs. The wire is one cheap stroked path; each bulb
/// is a baked glow sprite plus a tiny shaded body, so the whole string
/// costs a couple of dozen blits instead of a couple of dozen gradients.
export function drawGarland(ctx, width, time, colors) {
  const spacing = 54;
  const count = Math.max(2, Math.round(width / spacing));
  const wireY = (t) => 8 + Math.sin(t * Math.PI * 2) * 4 + Math.sin(t * Math.PI) * 26;

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
    const lit = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 1.7 + i * 1.37));

    ctx.fillStyle = '#22262d';
    ctx.fillRect(x - 2, capY, 4, 5);

    const glow = glowSprite(color);
    const gs = 40 * lit;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85 * lit;
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
function bakeTree(scale, colors, seed, wantLights) {
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
  const baseHalf = 96 * scale;

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
    const half = baseHalf * (1 - f) ** 0.82;
    // Rows lower in the tree are in shade, tips catch more light.
    const rowColor = shade(green, -26 + f * 30 + (rand() - 0.5) * 8);
    const perRow = Math.max(3, Math.round(half / (7 * scale)));

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
      if (rand() > 0.5) continue;
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

  // --- baubles -------------------------------------------------------------
  const ornamentColors = [
    colors.primary, colors.accent, '#f2f4f7',
    shade(colors.primary, 16), shade(colors.accent, -12), '#b9c4d0',
  ];
  const ornaments = Math.round(26 * scale);
  for (let i = 0; i < ornaments; i++) {
    const f = 0.05 + rand() * 0.9;
    const y = foliageBottom - (foliageBottom - topY) * f;
    const half = baseHalf * (1 - f) ** 0.82;
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
  }

  // --- star ---------------------------------------------------------------
  const starY = topY - 12 * scale;
  const sg = c.createLinearGradient(cx - 14 * scale, starY - 14 * scale, cx + 14 * scale, starY + 14 * scale);
  sg.addColorStop(0, '#fffdf0');
  sg.addColorStop(0.5, colors.accent);
  sg.addColorStop(1, shade(colors.accent, -28));
  c.fillStyle = sg;
  star(c, cx, starY, 5, 17 * scale, 7 * scale);

  return { sprite: cv, lights, star: { x: cx, y: starY }, groundY };
}

function getTree(scale, colors, seed, wantLights) {
  const key = `${scale.toFixed(2)}|${colors.secondary}|${colors.primary}|${colors.accent}|${seed}|${wantLights}`;
  let t = treeCache.get(key);
  if (!t) {
    t = bakeTree(scale, colors, seed, wantLights);
    if (treeCache.size > 6) treeCache.clear();
    treeCache.set(key, t);
  }
  return t;
}

/// Draws a conifer in each bottom corner (mirrored, different seeds) and
/// twinkles their string lights on top of the baked sprite.
export function drawTrees(ctx, width, height, colors, time, opts = {}) {
  const scale = Math.max(0.7, Math.min(2.2, (height / 900) * (opts.decorScale ?? 1)));
  const withLights = opts.treeLights !== false;
  const left = getTree(scale, colors, 1337, withLights);
  const right = getTree(scale, colors, 90210, withLights);
  const margin = 6 * scale;

  const bulb = glowSprite('#ffdba0', 48);
  const starGlow = glowSprite(colors.accent, 96);

  for (const [tree, mirrored] of [[left, false], [right, true]]) {
    const originX = mirrored ? width - margin - tree.sprite.width : margin;
    const originY = height - tree.sprite.height;

    ctx.save();
    if (mirrored) {
      ctx.translate(originX + tree.sprite.width, originY);
      ctx.scale(-1, 1);
      ctx.drawImage(tree.sprite, 0, 0);
    } else {
      ctx.translate(originX, originY);
      ctx.drawImage(tree.sprite, 0, 0);
    }

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < tree.lights.length; i++) {
      const l = tree.lights[i];
      // Slow shared breathing plus a per-bulb offset: real string lights
      // shimmer slightly out of step rather than pulsing in unison.
      const lit = 0.55 + 0.45 * Math.sin(time * 1.3 + l.phase);
      const s = 14 + 10 * lit;
      ctx.globalAlpha = 0.5 + 0.5 * lit;
      ctx.drawImage(bulb, l.x - s / 2, l.y - s / 2, s, s);
    }

    const twinkle = 0.7 + 0.3 * Math.sin(time * 2.1);
    const ss = 90 * twinkle;
    ctx.globalAlpha = 0.85 * twinkle;
    ctx.drawImage(starGlow, tree.star.x - ss / 2, tree.star.y - ss / 2, ss, ss);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// fireplace
// ---------------------------------------------------------------------------

let fireCache = null;

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

function bakeFireplace(scale, colors, opts) {
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

  // --- garland draped on the mantel ---------------------------------------
  const garlandLights = drawMantelGarland(
    c, -6 * scale, mantelY - 10 * scale, w + 12 * scale, scale, colors, rand,
    opts.mantelGarland !== false
  );

  return {
    sprite: cv,
    lights: garlandLights,
    geom: { w, h, ox, oy, openW, openH, fireX: ox + openW / 2, fireY: grateY + 6 * scale },
  };
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
export function drawFireplace(ctx, width, height, time, colors, opts = {}) {
  const scale = Math.max(0.8, Math.min(2.2, (height / 900) * (opts.decorScale ?? 1)));
  const key = `${scale.toFixed(2)}|${colors.primary}|${colors.secondary}|${opts.stockings}|${opts.mantelGarland}`;
  if (!fireCache || fireCache.key !== key) {
    const baked = bakeFireplace(scale, colors, opts);
    const fw = Math.ceil(baked.geom.openW);
    const fh = Math.ceil(baked.geom.openH * 0.85);
    fireCache = { key, ...baked, flame: bakeFlameSheet(fw, fh, scale) };
  }
  const { sprite, geom, lights, flame } = fireCache;
  const x = width / 2 - geom.w / 2;
  const y = height - geom.h;

  const fireX = x + geom.fireX;
  const fireY = y + geom.fireY;
  const breathe = 0.86 + 0.1 * Math.sin(time * 2.3) + 0.04 * Math.sin(time * 7.1);

  ctx.save();

  // Light thrown onto the floor and wall, drawn before the fireplace so it
  // reads as light landing on the room rather than a haze over the stone.
  const spill = glowSprite('#ff8c32', 128);
  ctx.globalCompositeOperation = 'lighter';
  const ss = 720 * scale * breathe;
  ctx.globalAlpha = 0.3 * breathe;
  ctx.drawImage(spill, fireX - ss / 2, fireY - ss * 0.52, ss, ss * 0.75);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(sprite, x, y);

  // Mantel garland lights.
  if (lights.length) {
    const bulb = glowSprite('#ffd79a', 48);
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      const lit = 0.55 + 0.45 * Math.sin(time * 1.5 + l.phase);
      const s = 13 + 9 * lit;
      ctx.globalAlpha = 0.5 + 0.5 * lit;
      ctx.drawImage(bulb, x + l.x - s / 2, y + l.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Fire, clipped to the firebox.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + geom.ox, y + geom.oy, geom.openW, geom.openH);
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
