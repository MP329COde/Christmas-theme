// Decorative elements drawn onto the same canvas as the snow: a light
// garland along the top edge, pine trees in the bottom corners, and a
// fireplace at bottom-center.
//
// Rendering approach: everything static (tree silhouettes, stonework,
// logs, mantel) is rendered ONCE into an offscreen canvas and then blitted
// with a single drawImage() per frame. Only genuinely animated parts —
// flame tongues, embers, light spill, bulb twinkle — are redrawn each
// frame. That's what lets the scene carry real texture detail (per-stone
// shading, needle silhouettes, wood grain) without paying for it 60 times
// a second.
//
// These are only drawn on the "primary" overlay window (see snow.js) —
// with one overlay window per monitor, drawing full-size decorations on
// every single screen would look cluttered and repetitive rather than
// like a single decorated desktop.

export const GARLAND_PALETTES = {
  multicolor: ['#ff5d5d', '#ffc93c', '#3ddc97', '#5b8def', '#c77dff'],
  warm: ['#ffb347', '#ffd48a', '#ff8c42', '#ffe6b8'],
  cool: ['#7fe0e0', '#5b8def', '#a7d8ff', '#c9b8ff'],
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/// Deterministic PRNG. Textures (stone shading, needle jitter, ornament
/// placement) must be identical every time they're generated, otherwise a
/// re-render on resize would visibly reshuffle the whole scene.
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
  const num = parseInt(hex, 16);
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/// Lightens (positive amt) or darkens (negative amt), -100..100.
function shade(color, amt) {
  const { r, g, b } = toRgb(color);
  const d = (amt / 100) * 255;
  return `rgb(${clamp255(r + d)},${clamp255(g + d)},${clamp255(b + d)})`;
}

function alpha(color, a) {
  const { r, g, b } = toRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w));
  cv.height = Math.max(1, Math.ceil(h));
  return cv;
}

// ---------------------------------------------------------------------------
// garland
// ---------------------------------------------------------------------------

/// A catenary wire with bulbs hanging off it, each twinkling on its own
/// phase. Bulbs are drawn as shaded glass teardrops with a bloom behind
/// them (additive) so lit bulbs actually look like they emit light.
export function drawGarland(ctx, width, time, colors) {
  const spacing = 54;
  const count = Math.max(2, Math.round(width / spacing));
  const anchorY = 8;
  const sag = 26;

  // Wire: two catenary arcs so it reads as a hung cable, not a straight line.
  const wireY = (t) => anchorY + Math.sin(t * Math.PI * 2) * 4 + Math.sin(t * Math.PI) * sag;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = 'rgba(18,22,28,0.75)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i <= count * 4; i++) {
    const t = i / (count * 4);
    const x = t * width;
    const y = wireY(t);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Highlight along the top of the wire.
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();

  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = t * width;
    const capY = wireY(t);
    const color = colors[i % colors.length];
    // Each bulb breathes on its own phase; a couple of them run a faster
    // shimmer so the string doesn't pulse in visible lockstep.
    const twinkle = 0.5 + 0.5 * Math.sin(time * 1.7 + i * 1.37) * (i % 5 === 0 ? Math.sin(time * 6 + i) * 0.5 + 0.5 : 1);
    const lit = 0.35 + twinkle * 0.65;

    const y = capY + 11;

    // Socket
    ctx.fillStyle = '#23272e';
    ctx.fillRect(x - 2, capY, 4, 5);

    // Bloom (additive so overlapping glows build up like real light).
    ctx.globalCompositeOperation = 'lighter';
    const bloomR = 16 * lit;
    const bloom = ctx.createRadialGradient(x, y, 0, x, y, bloomR);
    bloom.addColorStop(0, alpha(color, 0.55 * lit));
    bloom.addColorStop(0.4, alpha(color, 0.18 * lit));
    bloom.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(x, y, bloomR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Glass bulb: teardrop with a bright filament core and a specular dot.
    ctx.beginPath();
    ctx.moveTo(x, capY + 3);
    ctx.bezierCurveTo(x - 4.6, capY + 6, x - 4.6, y + 5, x, y + 6);
    ctx.bezierCurveTo(x + 4.6, y + 5, x + 4.6, capY + 6, x, capY + 3);
    ctx.closePath();
    const glass = ctx.createRadialGradient(x - 1.4, y - 1.6, 0.4, x, y, 6);
    glass.addColorStop(0, shade(color, 45 * lit));
    glass.addColorStop(0.5, color);
    glass.addColorStop(1, shade(color, -28 + 18 * lit));
    ctx.fillStyle = glass;
    ctx.fill();

    ctx.fillStyle = `rgba(255,255,255,${0.5 * lit})`;
    ctx.beginPath();
    ctx.ellipse(x - 1.5, y - 1.8, 0.9, 1.4, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// pine trees
// ---------------------------------------------------------------------------

const treeCache = new Map();

/// Renders one pine to an offscreen canvas: trunk with bark grain, five
/// tiers of needled boughs shaded along a consistent top-left light
/// direction, snow resting on the upper surfaces, ornaments with specular
/// highlights, and a star with a bloom.
function renderTreeSprite(scale, colors, seed) {
  const w = 150 * scale;
  const h = 290 * scale;
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(seed);

  const cx = w / 2;
  const groundY = h - 10 * scale;
  const trunkW = 13 * scale;
  const trunkH = 30 * scale;

  // --- contact shadow -----------------------------------------------------
  const shadowGrad = c.createRadialGradient(cx, groundY, 0, cx, groundY, 58 * scale);
  shadowGrad.addColorStop(0, 'rgba(0,0,0,0.45)');
  shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = shadowGrad;
  c.beginPath();
  c.ellipse(cx, groundY, 58 * scale, 12 * scale, 0, 0, Math.PI * 2);
  c.fill();

  // --- trunk --------------------------------------------------------------
  const trunkTop = groundY - trunkH;
  const bark = c.createLinearGradient(cx - trunkW / 2, 0, cx + trunkW / 2, 0);
  bark.addColorStop(0, '#2e1b10');
  bark.addColorStop(0.35, '#5a3722');
  bark.addColorStop(0.7, '#6b432a');
  bark.addColorStop(1, '#311d12');
  c.fillStyle = bark;
  c.beginPath();
  c.moveTo(cx - trunkW / 2, groundY);
  c.lineTo(cx - trunkW * 0.36, trunkTop);
  c.lineTo(cx + trunkW * 0.36, trunkTop);
  c.lineTo(cx + trunkW / 2, groundY);
  c.closePath();
  c.fill();

  c.strokeStyle = 'rgba(0,0,0,0.35)';
  c.lineWidth = 0.8 * scale;
  for (let i = 0; i < 4; i++) {
    const gx = cx - trunkW / 2 + rand() * trunkW;
    c.beginPath();
    c.moveTo(gx, trunkTop + 2 * scale);
    c.lineTo(gx + (rand() - 0.5) * 2 * scale, groundY);
    c.stroke();
  }

  // --- boughs -------------------------------------------------------------
  const tiers = 5;
  const foliageBottom = groundY - trunkH + 6 * scale;
  const foliageTop = 26 * scale;
  const span = foliageBottom - foliageTop;
  const baseW = 122 * scale;

  const green = colors.secondary;
  const needleLight = shade(green, 26);
  const needleDark = shade(green, -30);
  const snowTops = [];

  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1); // 0 bottom .. 1 top
    const tierBottom = foliageBottom - span * (t / tiers);
    const tierW = baseW * (1 - f * 0.74);
    const tierH = (span / tiers) * 2.05;
    const apexY = tierBottom - tierH;

    // Needled silhouette: walk down each side in steps, each step kicking
    // outward into a spike so the edge reads as clumps of needles rather
    // than a clean triangle.
    const steps = 6;
    c.beginPath();
    c.moveTo(cx, apexY);
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const ex = cx - (tierW / 2) * p;
      const ey = apexY + tierH * p;
      const spike = (5 + rand() * 5) * scale * p;
      c.lineTo(ex - spike, ey - 3 * scale * p);
      c.lineTo(ex, ey);
    }
    // Zigzag bottom edge (drooping needle tips), left to right.
    const bottomSegs = Math.max(4, Math.round(tierW / (13 * scale)));
    for (let i = 0; i <= bottomSegs; i++) {
      const p = i / bottomSegs;
      const bx = cx - tierW / 2 + tierW * p;
      const dip = (4 + rand() * 5) * scale;
      c.lineTo(bx + (tierW / bottomSegs) * 0.5, tierBottom + dip);
      c.lineTo(bx + tierW / bottomSegs, tierBottom - 1 * scale);
    }
    for (let i = steps; i >= 1; i--) {
      const p = i / steps;
      const ex = cx + (tierW / 2) * p;
      const ey = apexY + tierH * p;
      const spike = (5 + rand() * 5) * scale * p;
      c.lineTo(ex, ey);
      c.lineTo(ex + spike, ey - 3 * scale * p);
    }
    c.closePath();

    // Light from upper-left: lit face top-left, shadow bottom-right.
    const g = c.createLinearGradient(cx - tierW / 2, apexY, cx + tierW / 2, tierBottom);
    g.addColorStop(0, needleLight);
    g.addColorStop(0.38, green);
    g.addColorStop(1, needleDark);
    c.fillStyle = g;
    c.fill();

    // Ambient occlusion where this tier meets the one below it.
    const ao = c.createLinearGradient(0, tierBottom - 14 * scale, 0, tierBottom + 4 * scale);
    ao.addColorStop(0, 'rgba(0,0,0,0)');
    ao.addColorStop(1, 'rgba(0,0,0,0.33)');
    c.fillStyle = ao;
    c.fill();

    snowTops.push({ apexY, tierBottom, tierW });
  }

  // --- snow resting on the boughs -----------------------------------------
  // Snow is laid along each tier's lower edge — the drooping branch tips.
  // Those are the near-horizontal, upward-facing surfaces on a pine; the
  // flanks between them are far too steep to hold anything, so dusting
  // those instead just reads as white tick marks stuck to a triangle.
  for (const { tierBottom, tierW } of snowTops) {
    const caps = Math.max(4, Math.round(tierW / (13 * scale)));
    for (let i = 0; i <= caps; i++) {
      if (rand() > 0.72) continue;
      const p = i / caps;
      const x = cx - tierW / 2 + tierW * p;
      // Follow the tier's lower edge, which lifts slightly toward the middle.
      const y = tierBottom - Math.sin(p * Math.PI) * 3 * scale + (rand() - 0.5) * 2 * scale;
      const len = (5 + rand() * 5) * scale;
      const snow = c.createLinearGradient(x, y - len * 0.5, x, y + len * 0.35);
      snow.addColorStop(0, 'rgba(255,255,255,0.98)');
      snow.addColorStop(1, 'rgba(200,217,236,0.6)');
      c.fillStyle = snow;
      c.beginPath();
      c.ellipse(x, y, len, len * 0.36, (rand() - 0.5) * 0.3, 0, Math.PI * 2);
      c.fill();
    }
  }

  // --- ornaments ----------------------------------------------------------
  const ornamentColors = [colors.primary, colors.accent, '#f5f7fa', shade(colors.primary, 18)];
  for (let i = 0; i < 13; i++) {
    const tier = Math.floor(rand() * tiers);
    const { apexY, tierBottom, tierW } = snowTops[tier];
    const p = 0.12 + rand() * 0.76;
    const y = apexY + (tierBottom - apexY) * (0.45 + rand() * 0.5);
    const halfSpread = (tierW / 2) * ((y - apexY) / Math.max(1, tierBottom - apexY)) * 0.82;
    const x = cx + (p * 2 - 1) * halfSpread;
    const r = (3.6 + rand() * 1.6) * scale;
    const col = ornamentColors[i % ornamentColors.length];

    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.beginPath();
    c.arc(x + 0.8 * scale, y + 1 * scale, r, 0, Math.PI * 2);
    c.fill();

    const ball = c.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.1, x, y, r);
    ball.addColorStop(0, shade(col, 52));
    ball.addColorStop(0.45, col);
    ball.addColorStop(1, shade(col, -38));
    c.fillStyle = ball;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();

    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath();
    c.ellipse(x - r * 0.34, y - r * 0.4, r * 0.24, r * 0.16, -0.6, 0, Math.PI * 2);
    c.fill();
  }

  // --- star topper --------------------------------------------------------
  const starY = foliageTop - 2 * scale;
  c.globalCompositeOperation = 'lighter';
  const starGlow = c.createRadialGradient(cx, starY, 0, cx, starY, 26 * scale);
  starGlow.addColorStop(0, alpha(colors.accent, 0.7));
  starGlow.addColorStop(0.35, alpha(colors.accent, 0.22));
  starGlow.addColorStop(1, alpha(colors.accent, 0));
  c.fillStyle = starGlow;
  c.beginPath();
  c.arc(cx, starY, 26 * scale, 0, Math.PI * 2);
  c.fill();
  c.globalCompositeOperation = 'source-over';

  const starGrad = c.createLinearGradient(cx - 10 * scale, starY - 10 * scale, cx + 10 * scale, starY + 10 * scale);
  starGrad.addColorStop(0, '#fffbe6');
  starGrad.addColorStop(0.5, colors.accent);
  starGrad.addColorStop(1, shade(colors.accent, -25));
  c.fillStyle = starGrad;
  drawStar(c, cx, starY, 5, 12 * scale, 5 * scale);

  return cv;
}

function drawStar(ctx, cx, cy, points, outerR, innerR) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function treeSprite(scale, colors, seed) {
  const key = `${scale.toFixed(2)}|${colors.secondary}|${colors.primary}|${colors.accent}|${seed}`;
  let sprite = treeCache.get(key);
  if (!sprite) {
    sprite = renderTreeSprite(scale, colors, seed);
    // The cache only ever holds a handful of entries (two seeds x the
    // sizes actually used), but clear it if a resize storm grows it.
    if (treeCache.size > 8) treeCache.clear();
    treeCache.set(key, sprite);
  }
  return sprite;
}

/// Draws one pine tree in each bottom corner, mirrored so they don't look
/// like the same asset pasted twice.
export function drawTrees(ctx, width, height, colors) {
  const scale = Math.max(0.75, Math.min(1.7, height / 900));
  const left = treeSprite(scale, colors, 12345);
  const right = treeSprite(scale, colors, 987654);

  const margin = 18 * scale;
  ctx.drawImage(left, margin, height - left.height);

  ctx.save();
  ctx.translate(width - margin, height - right.height);
  ctx.scale(-1, 1);
  ctx.drawImage(right, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// fireplace
// ---------------------------------------------------------------------------

let fireplaceCache = { key: null, sprite: null, geom: null };

/// Renders the static half of the fireplace: stone surround with per-stone
/// shading and mortar, a timber mantel with grain, the hearth cavity with
/// its inner falloff, and charred logs.
function renderFireplaceSprite(w, h, scale) {
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(4242);

  const openingW = w * 0.52;
  const openingH = h * 0.56;
  const ox = (w - openingW) / 2;
  const oy = h - openingH;

  // --- stone surround -----------------------------------------------------
  const rowH = 17 * scale;
  const rows = Math.ceil((h - 14 * scale) / rowH);
  for (let row = 0; row < rows; row++) {
    const ry = 14 * scale + row * rowH;
    const offset = row % 2 === 0 ? 0 : 17 * scale;
    for (let sx = -20 * scale; sx < w + 20 * scale; sx += 34 * scale) {
      const bx = sx + offset;
      const bw = 34 * scale - 2.5 * scale;
      const bh = rowH - 2.5 * scale;
      // Stone tone varies per block so the wall doesn't read as a texture tile.
      // Warm, darker hearth stone — pale grey block reads as concrete.
      const tone = 0.72 + rand() * 0.46;
      const base = `rgb(${clamp255(96 * tone)},${clamp255(83 * tone)},${clamp255(73 * tone)})`;
      const g = c.createLinearGradient(bx, ry, bx, ry + bh);
      g.addColorStop(0, shade(base, 12));
      g.addColorStop(0.55, base);
      g.addColorStop(1, shade(base, -14));
      c.fillStyle = g;
      roundRect(c, bx, ry, bw, bh, 2.5 * scale);
      c.fill();

      // Top bevel highlight + bottom mortar shadow.
      c.strokeStyle = 'rgba(255,255,255,0.10)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(bx + 2, ry + 0.5);
      c.lineTo(bx + bw - 2, ry + 0.5);
      c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.30)';
      c.beginPath();
      c.moveTo(bx + 2, ry + bh - 0.5);
      c.lineTo(bx + bw - 2, ry + bh - 0.5);
      c.stroke();
    }
  }

  // Vignette across the stonework so the edges fall off instead of ending flat.
  const vign = c.createLinearGradient(0, 0, w, 0);
  vign.addColorStop(0, 'rgba(0,0,0,0.45)');
  vign.addColorStop(0.5, 'rgba(0,0,0,0)');
  vign.addColorStop(1, 'rgba(0,0,0,0.45)');
  c.fillStyle = vign;
  c.fillRect(0, 0, w, h);

  // --- hearth cavity ------------------------------------------------------
  c.save();
  hearthPath(c, ox, oy, openingW, openingH, scale);
  c.clip();
  const cave = c.createLinearGradient(0, oy, 0, oy + openingH);
  cave.addColorStop(0, '#070504');
  cave.addColorStop(0.55, '#140d09');
  cave.addColorStop(1, '#24150d');
  c.fillStyle = cave;
  c.fillRect(ox - 4, oy - 4, openingW + 8, openingH + 8);

  // Soot staining up the back wall.
  const soot = c.createRadialGradient(ox + openingW / 2, oy + openingH, 4, ox + openingW / 2, oy + openingH, openingH * 0.9);
  soot.addColorStop(0, 'rgba(60,30,12,0.55)');
  soot.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = soot;
  c.fillRect(ox - 4, oy - 4, openingW + 8, openingH + 8);

  // --- logs ---------------------------------------------------------------
  const logY = oy + openingH - 13 * scale;
  const logs = [
    { x: ox + openingW * 0.34, y: logY + 2 * scale, rx: openingW * 0.27, ry: 7.5 * scale, rot: -0.09 },
    { x: ox + openingW * 0.66, y: logY + 3 * scale, rx: openingW * 0.26, ry: 7 * scale, rot: 0.08 },
    { x: ox + openingW * 0.5, y: logY - 7 * scale, rx: openingW * 0.23, ry: 6.5 * scale, rot: 0.04 },
  ];
  for (const log of logs) {
    c.save();
    c.translate(log.x, log.y);
    c.rotate(log.rot);
    const lg = c.createLinearGradient(0, -log.ry, 0, log.ry);
    lg.addColorStop(0, '#3c2415');
    lg.addColorStop(0.5, '#2a180e');
    lg.addColorStop(1, '#160c07');
    c.fillStyle = lg;
    c.beginPath();
    c.ellipse(0, 0, log.rx, log.ry, 0, 0, Math.PI * 2);
    c.fill();
    // End grain
    c.fillStyle = '#4a2c19';
    c.beginPath();
    c.ellipse(-log.rx * 0.88, 0, log.ry * 0.55, log.ry * 0.9, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(20,10,5,0.7)';
    c.lineWidth = 1;
    c.beginPath();
    c.ellipse(-log.rx * 0.88, 0, log.ry * 0.3, log.ry * 0.5, 0, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  c.restore();

  // Inner shadow around the hearth edge, so the opening reads as a recess.
  c.save();
  hearthPath(c, ox, oy, openingW, openingH, scale);
  c.strokeStyle = 'rgba(0,0,0,0.75)';
  c.lineWidth = 6 * scale;
  c.stroke();
  c.restore();

  // --- mantel -------------------------------------------------------------
  const mantelH = 15 * scale;
  const mantel = c.createLinearGradient(0, 0, 0, mantelH);
  mantel.addColorStop(0, '#6b4429');
  mantel.addColorStop(0.4, '#4e301c');
  mantel.addColorStop(1, '#301c10');
  c.fillStyle = mantel;
  roundRect(c, -6 * scale, 0, w + 12 * scale, mantelH, 3 * scale);
  c.fill();
  c.strokeStyle = 'rgba(255,220,180,0.16)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, 1);
  c.lineTo(w, 1);
  c.stroke();
  for (let i = 0; i < 6; i++) {
    c.strokeStyle = 'rgba(0,0,0,0.22)';
    const gy = 3 * scale + rand() * (mantelH - 6 * scale);
    c.beginPath();
    c.moveTo(4 * scale, gy);
    c.bezierCurveTo(w * 0.35, gy + (rand() - 0.5) * 3, w * 0.7, gy - (rand() - 0.5) * 3, w - 4 * scale, gy);
    c.stroke();
  }

  return { sprite: cv, geom: { ox, oy, openingW, openingH } };
}

function hearthPath(ctx, ox, oy, openingW, openingH, scale) {
  const r = openingW * 0.5;
  ctx.beginPath();
  ctx.moveTo(ox, oy + openingH);
  ctx.lineTo(ox, oy + openingH * 0.42);
  ctx.quadraticCurveTo(ox, oy, ox + r, oy);
  ctx.quadraticCurveTo(ox + openingW, oy, ox + openingW, oy + openingH * 0.42);
  ctx.lineTo(ox + openingW, oy + openingH);
  ctx.closePath();
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

/// Draws the fireplace: cached stonework blitted once, then the live fire —
/// additive flame tongues, an ember bed, rising sparks, and warm light
/// spilling onto the floor and up the surround.
export function drawFireplace(ctx, width, height, time) {
  const scale = Math.max(0.85, Math.min(1.7, height / 900));
  const w = 210 * scale;
  const h = 178 * scale;
  const x = width / 2 - w / 2;
  const y = height - h;

  const key = `${Math.round(w)}x${Math.round(h)}`;
  if (fireplaceCache.key !== key) {
    const { sprite, geom } = renderFireplaceSprite(w, h, scale);
    fireplaceCache = { key, sprite, geom };
  }
  const { sprite, geom } = fireplaceCache;
  const { ox, oy, openingW, openingH } = geom;

  ctx.save();

  // Warm light spilling out onto the floor in front of the hearth, drawn
  // under the fireplace itself so it reads as light on the ground.
  const spillX = x + ox + openingW / 2;
  const spillY = y + oy + openingH;
  const breathe = 0.86 + 0.14 * Math.sin(time * 2.3) + 0.05 * Math.sin(time * 7.1);
  ctx.globalCompositeOperation = 'lighter';
  const spill = ctx.createRadialGradient(spillX, spillY, 0, spillX, spillY, 210 * scale * breathe);
  spill.addColorStop(0, `rgba(255,150,60,${0.30 * breathe})`);
  spill.addColorStop(0.45, `rgba(255,110,40,${0.10 * breathe})`);
  spill.addColorStop(1, 'rgba(255,90,30,0)');
  ctx.fillStyle = spill;
  ctx.fillRect(spillX - 240 * scale, spillY - 190 * scale, 480 * scale, 260 * scale);
  ctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(sprite, x, y);

  // --- fire ---------------------------------------------------------------
  const baseX = x + ox + openingW / 2;
  const baseY = y + oy + openingH - 16 * scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + ox, y + oy, openingW, openingH);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';

  // Ember bed under the logs.
  const bed = ctx.createRadialGradient(baseX, baseY + 6 * scale, 0, baseX, baseY + 6 * scale, 48 * scale);
  bed.addColorStop(0, `rgba(255,120,30,${0.75 * breathe})`);
  bed.addColorStop(0.5, `rgba(220,60,15,${0.28 * breathe})`);
  bed.addColorStop(1, 'rgba(120,20,0,0)');
  ctx.fillStyle = bed;
  ctx.beginPath();
  ctx.ellipse(baseX, baseY + 6 * scale, 48 * scale, 18 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  // Flame tongues. Each has its own drift and flicker frequency; drawn
  // additively so overlaps brighten toward white at the core, the way a
  // real flame's hottest region does.
  // Wide, splayed outer tongues with progressively narrower, hotter ones
  // stacked toward the middle: a fire is broad at the log bed and tapers,
  // not a single vertical spike.
  const tongues = [
    { dx: -26, w: 22, hgt: 34, hue: [255, 80, 20], f: 2.7, ph: 0.0 },
    { dx: 25, w: 21, hgt: 31, hue: [255, 85, 22], f: 3.3, ph: 1.1 },
    { dx: -15, w: 24, hgt: 52, hue: [255, 100, 28], f: 3.1, ph: 2.4 },
    { dx: 14, w: 23, hgt: 48, hue: [255, 115, 32], f: 3.9, ph: 1.7 },
    { dx: -4, w: 26, hgt: 70, hue: [255, 150, 45], f: 2.6, ph: 3.4 },
    { dx: 5, w: 19, hgt: 80, hue: [255, 190, 80], f: 4.6, ph: 5.1 },
    { dx: -1, w: 11, hgt: 58, hue: [255, 240, 195], f: 6.2, ph: 2.2 },
  ];

  for (const t of tongues) {
    const flick = 0.78 + 0.22 * Math.sin(time * t.f + t.ph) + 0.09 * Math.sin(time * (t.f * 3.7) + t.ph);
    const sway = Math.sin(time * (t.f * 0.6) + t.ph) * 6 * scale;
    // The root sits partway toward the tip's offset, so outer tongues rise
    // from their own spot along the log bed rather than all from one point.
    const rootX = baseX + t.dx * scale * 0.55;
    const tipX = baseX + t.dx * scale + sway;
    const tipY = baseY - t.hgt * scale * flick;
    const halfW = t.w * scale * flick;
    const [r, g, b] = t.hue;

    const grad = ctx.createLinearGradient(rootX, baseY, tipX, tipY);
    grad.addColorStop(0, `rgba(${r},${Math.round(g * 0.55)},10,${0.5 * breathe})`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},${0.42 * breathe})`);
    grad.addColorStop(1, `rgba(${r},${Math.min(255, g + 60)},${Math.min(255, b + 80)},0)`);
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(rootX - halfW, baseY);
    ctx.bezierCurveTo(
      rootX - halfW * 1.15, baseY - (baseY - tipY) * 0.45,
      tipX - halfW * 0.5, baseY - (baseY - tipY) * 0.78,
      tipX, tipY
    );
    ctx.bezierCurveTo(
      tipX + halfW * 0.5, baseY - (baseY - tipY) * 0.78,
      rootX + halfW * 1.15, baseY - (baseY - tipY) * 0.45,
      rootX + halfW, baseY
    );
    ctx.closePath();
    ctx.fill();
  }

  // Rising sparks. Positions are derived from time rather than stored
  // state, so there's no particle array to keep in sync across resizes.
  for (let i = 0; i < 14; i++) {
    const seedA = i * 1.618;
    const life = (time * (0.35 + (i % 5) * 0.06) + seedA) % 1;
    const sx = baseX + Math.sin(seedA * 9.7 + life * 6.2) * (16 + (i % 4) * 7) * scale;
    const sy = baseY - life * openingH * 0.92;
    const a = (1 - life) * 0.85 * breathe;
    const sr = (0.9 + (i % 3) * 0.5) * scale * (1 - life * 0.5);
    ctx.fillStyle = `rgba(255,${Math.round(150 + 80 * (1 - life))},${Math.round(60 * (1 - life))},${a})`;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Firelight washing up the inside edges of the stone surround.
  ctx.globalCompositeOperation = 'lighter';
  const wash = ctx.createRadialGradient(baseX, baseY, 4 * scale, baseX, baseY, 130 * scale);
  wash.addColorStop(0, `rgba(255,140,50,${0.22 * breathe})`);
  wash.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = wash;
  ctx.fillRect(x - 30 * scale, y - 20 * scale, w + 60 * scale, h + 20 * scale);

  ctx.restore();
}
