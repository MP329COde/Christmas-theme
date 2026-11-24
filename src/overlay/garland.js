// Guirlande du haut de l'écran.
//
// Cinq styles (voir GARLAND_STYLES dans shared/scene.js) partagent la même
// géométrie : un câble accroché en plusieurs points, qui s'affaisse entre
// eux. Tout ce qui ne bouge pas — câble, douilles, branches, fanions — est
// cuit une fois dans un canevas hors écran ; une image ne coûte ensuite
// qu'une copie du fond plus deux copies de sprite par ampoule. Les verres
// d'ampoule sont eux aussi des sprites, cuits une fois par couleur et forme.

import { bulbLevel } from '../shared/scene.js';

const TAU = Math.PI * 2;

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w));
  cv.height = Math.max(1, Math.ceil(h));
  return cv;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgb(color) {
  const v = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : 'ffffff';
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}
const rgba = (color, a) => `rgba(${rgb(color).join(',')},${a})`;
function shade(color, amt) {
  return `rgb(${rgb(color).map((c) => Math.max(0, Math.min(255, Math.round(c + amt)))).join(',')})`;
}

const spriteCache = new Map();
function cached(key, build) {
  let sprite = spriteCache.get(key);
  if (!sprite) {
    if (spriteCache.size > 160) spriteCache.clear();
    sprite = build();
    spriteCache.set(key, sprite);
  }
  return sprite;
}

function glow(color) {
  return cached(`glow|${color}`, () => {
    const cv = makeCanvas(64, 64);
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, rgba(color, 0.95));
    g.addColorStop(0.2, rgba(color, 0.5));
    g.addColorStop(0.5, rgba(color, 0.14));
    g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    return cv;
  });
}

function starPath(c, cx, cy, outer, inner) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    c[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  c.closePath();
}

/// Verre d'ampoule 48×64 (douille en haut, centre du verre en 24,38).
/// `lit` choisit entre le verre éteint (teinté, sombre) et allumé (cœur
/// presque blanc) : on fond les deux à l'affichage selon le niveau.
function bulbSprite(color, shape, lit) {
  return cached(`bulb|${color}|${shape}|${lit}`, () => {
    const cv = makeCanvas(48, 64);
    const c = cv.getContext('2d');
    const cx = 24, cy = 38;
    const body = c.createRadialGradient(cx - 4, cy - 5, 1, cx, cy, 20);
    if (lit) {
      body.addColorStop(0, '#ffffff');
      body.addColorStop(0.35, shade(color, 70));
      body.addColorStop(1, color);
    } else {
      body.addColorStop(0, shade(color, -10));
      body.addColorStop(1, shade(color, -95));
    }
    c.fillStyle = body;
    if (shape === 'star') {
      starPath(c, cx, cy, 19, 8.5);
    } else if (shape === 'round') {
      c.beginPath(); c.arc(cx, cy, 11, 0, TAU);
    } else if (shape === 'globe') {
      c.beginPath(); c.arc(cx, cy + 2, 17, 0, TAU);
    } else {
      // Goutte C9 : large en haut, pointe douce en bas.
      c.beginPath();
      c.moveTo(cx - 7, 20);
      c.bezierCurveTo(cx - 16, 30, cx - 12, 52, cx, 60);
      c.bezierCurveTo(cx + 12, 52, cx + 16, 30, cx + 7, 20);
      c.closePath();
    }
    c.fill();
    // Reflet du verre.
    c.fillStyle = `rgba(255,255,255,${lit ? 0.75 : 0.28})`;
    c.beginPath(); c.ellipse(cx - 5, cy - 6, 2.4, 5, -0.5, 0, TAU); c.fill();
    // Douille en laiton.
    const cap = c.createLinearGradient(cx - 7, 0, cx + 7, 0);
    cap.addColorStop(0, '#3a3f38'); cap.addColorStop(0.45, '#8f8a6b'); cap.addColorStop(1, '#2a2e2a');
    c.fillStyle = cap;
    c.fillRect(cx - 6.5, 8, 13, 13);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    for (const y of [11, 15, 19]) c.fillRect(cx - 6.5, y, 13, 1.2);
    return cv;
  });
}

function bakeGarland(width, colors, o) {
  const swags = Math.max(1, Math.min(12, Math.round(o.swags)));
  const span = width / swags;
  const depth = Math.max(10, Math.min(70, span * 0.085)) * o.sag * (o.style === 'curtain' ? 0.35 : 1);
  const top = o.style === 'pine' || o.style === 'tinsel' ? 16 : 9;
  const height = top + depth + (o.style === 'curtain' ? 170 * o.size : 90 * o.size) + 20;
  const cv = makeCanvas(width, height);
  const c = cv.getContext('2d');
  const rand = mulberry32(2412 + swags);
  const wire = (x) => {
    const u = (x / span) % 1;
    return top + depth * 4 * u * (1 - u);
  };
  const slope = (x) => (wire(x + 1) - wire(x - 1)) / 2;
  const bulbs = [];
  const sparks = [];
  c.lineCap = 'round';
  c.lineJoin = 'round';

  const strokeWire = (color, lw, dash) => {
    c.strokeStyle = color; c.lineWidth = lw; c.setLineDash(dash ?? []);
    c.beginPath();
    for (let x = 0; x <= width; x += 6) c[x ? 'lineTo' : 'moveTo'](x, wire(x));
    c.lineTo(width, wire(width - 0.01));
    c.stroke();
    c.setLineDash([]);
  };

  if (o.style === 'pine') {
    // Branchage : un éventail d'aiguilles tous les quelques pixels, plus
    // sombre au cœur et plus clair en surface, puis des baies.
    for (let pass = 0; pass < 2; pass++) {
      for (let x = -4; x <= width + 4; x += 3.2) {
        const y = wire(Math.max(0, Math.min(width - 0.01, x)));
        for (let n = 0; n < 3; n++) {
          const len = (9 + rand() * 13) * (pass ? 0.8 : 1);
          const ang = rand() * TAU;
          c.strokeStyle = `hsl(${128 + rand() * 26},${38 + rand() * 22}%,${pass ? 24 + rand() * 16 : 10 + rand() * 9}%)`;
          c.lineWidth = 0.9 + rand() * 1.1;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len * 0.62);
          c.stroke();
        }
      }
    }
    for (let x = rand() * 40; x < width; x += 26 + rand() * 60) {
      const y = wire(x) + (rand() - 0.3) * 9;
      for (let k = 0; k < 3; k++) {
        c.fillStyle = k ? '#c4162a' : '#e2374a';
        c.beginPath(); c.arc(x + (k - 1) * 4.2, y + (k % 2) * 3, 2.7, 0, TAU); c.fill();
      }
    }
  } else if (o.style === 'tinsel') {
    const base = colors[0] ?? '#ffd75e';
    for (let x = -4; x <= width + 4; x += 2.1) {
      const y = wire(Math.max(0, Math.min(width - 0.01, x)));
      for (let n = 0; n < 3; n++) {
        const len = 6 + rand() * 12;
        const ang = rand() * TAU;
        const tone = rand();
        c.strokeStyle = tone > 0.82 ? 'rgba(255,255,255,0.9)' : shade(base, -70 + tone * 110);
        c.lineWidth = 0.8 + rand() * 0.8;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len * 0.7);
        c.stroke();
      }
      if (rand() < 0.07) sparks.push({ x, y: y + (rand() - 0.5) * 12, phase: rand() * TAU });
    }
  } else {
    // Câble torsadé : un brin sombre, un filet clair en pointillé dessus.
    strokeWire('rgba(14,22,18,0.92)', 2.6);
    strokeWire('rgba(120,140,128,0.5)', 0.9, [3, 5]);
  }

  // Points d'accroche : un nœud à chaque attache intérieure.
  if (o.style !== 'curtain') {
    for (let i = 1; i < swags; i++) {
      const x = i * span, y = top;
      const bow = o.style === 'pine' || o.style === 'tinsel';
      c.fillStyle = bow ? '#c4162a' : '#2a2f33';
      if (bow) {
        for (const side of [-1, 1]) {
          c.beginPath(); c.moveTo(x, y);
          c.quadraticCurveTo(x + side * 16, y - 12, x + side * 15, y + 1);
          c.quadraticCurveTo(x + side * 14, y + 9, x, y); c.fill();
          c.beginPath(); c.moveTo(x, y); c.lineTo(x + side * 9, y + 22); c.lineTo(x + side * 2, y + 19); c.closePath(); c.fill();
        }
        c.fillStyle = '#8f0f1e'; c.beginPath(); c.arc(x, y, 4, 0, TAU); c.fill();
      } else {
        c.beginPath(); c.arc(x, y, 3, 0, TAU); c.fill();
      }
    }
  }

  const step = (o.style === 'curtain' ? 30 : o.style === 'bunting' ? 62 : o.style === 'pine' ? 44 : 46) * o.spacing * Math.max(0.8, Math.sqrt(o.size));
  const count = Math.max(2, Math.round(width / step));
  for (let i = 0; i <= count; i++) {
    const x = (i / count) * width;
    const xc = Math.max(0.5, Math.min(width - 0.5, x));
    const y = wire(xc);
    if (o.style === 'curtain') {
      // Brins verticaux de longueurs alternées, une diode tous les 20 px.
      const len = [150, 70, 110, 50, 130, 90][i % 6] * o.size;
      c.strokeStyle = 'rgba(14,22,18,0.75)'; c.lineWidth = 1.1;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + len); c.stroke();
      for (let d = 18; d <= len; d += 20) {
        bulbs.push({ x, y: y + d, angle: 0, led: true, index: bulbs.length, phase: rand() * TAU, color: colors[(i + Math.floor(d / 20)) % colors.length] });
      }
    } else if (o.style === 'bunting') {
      if (i < count) {
        const x2 = ((i + 1) / count) * width;
        const y2 = wire(Math.min(width - 0.5, x2));
        const color = colors[i % colors.length];
        const drop = 44 * o.size;
        const grad = c.createLinearGradient(0, y, 0, y + drop);
        grad.addColorStop(0, shade(color, 12)); grad.addColorStop(1, shade(color, -45));
        c.fillStyle = grad;
        c.beginPath(); c.moveTo(x + 3, y + 1); c.lineTo(x2 - 3, y2 + 1);
        c.lineTo((x + x2) / 2, (y + y2) / 2 + drop); c.closePath(); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x + 5, y + 3); c.lineTo(x2 - 5, y2 + 3); c.stroke();
      }
      bulbs.push({ x, y: y + 3, angle: 0, index: i, phase: rand() * TAU, color: colors[(i + 2) % colors.length], small: true });
    } else {
      const embedded = o.style === 'pine' || o.style === 'tinsel';
      bulbs.push({
        x, y: y + (embedded ? 4 + rand() * 6 : 0),
        // L'ampoule pend, légèrement entraînée par la pente du câble.
        angle: Math.atan(slope(xc)) * 0.6 + (rand() - 0.5) * 0.28,
        index: i, phase: rand() * TAU, color: colors[i % colors.length], small: embedded,
      });
    }
  }
  return { cv, bulbs, sparks };
}

let bake = null;
let bakeKey = '';

/// Dessine la guirlande. `colors` est la palette résolue ; `opts` reprend
/// les champs de defaultGarland plus l'animation des lumières.
export function drawGarland(ctx, width, time, colors, opts = {}) {
  const o = {
    style: opts.style ?? 'classic',
    swags: opts.swags ?? 3,
    sag: opts.sag ?? 1,
    spacing: opts.spacing ?? 1,
    size: opts.size ?? 1,
    shape: opts.bulbShape ?? 'drop',
  };
  const palette = colors?.length ? colors : ['#ffcf8a'];
  const key = `${Math.round(width)}|${o.style}|${o.swags}|${o.sag}|${o.spacing}|${o.size}|${palette.join()}`;
  if (key !== bakeKey) {
    bake = bakeGarland(width, palette, o);
    bakeKey = key;
  }
  const gain = opts.lightIntensity ?? 1;
  const halo = opts.glow ?? 1;
  const total = bake.bulbs.length;
  const detail = opts.detail ?? 1;

  ctx.save();
  ctx.drawImage(bake.cv, 0, 0);

  // Halos d'abord, en mode additif, puis les verres par-dessus.
  ctx.globalCompositeOperation = 'lighter';
  for (const b of bake.bulbs) {
    const lit = bulbLevel(opts.animation, time, b.index, b.phase, total, opts.speed ?? 1);
    b.lit = lit;
    if (b.led && detail < 0.6 && b.index % 2) continue;
    const base = b.led ? 15 : b.small ? 34 : o.shape === 'globe' ? 62 : 50;
    const gs = base * o.size * (0.55 + 0.45 * lit) * (0.7 + 0.3 * halo);
    const cy = b.led || b.small ? b.y : b.y + 20 * o.size;
    ctx.globalAlpha = Math.min(1, (b.led ? 0.95 : 0.8) * lit * gain * halo);
    ctx.drawImage(glow(b.color), b.x - gs / 2, cy - gs / 2, gs, gs);
  }
  for (const s of bake.sparks) {
    const tw = Math.max(0, Math.sin(time * 2.2 + s.phase)) ** 8;
    if (tw < 0.05) continue;
    ctx.globalAlpha = Math.min(1, tw * gain);
    ctx.drawImage(glow('#ffffff'), s.x - 9, s.y - 9, 18, 18);
  }
  ctx.globalCompositeOperation = 'source-over';

  for (const b of bake.bulbs) {
    if (b.led) continue;
    const scale = (b.small ? 0.3 : 0.55) * o.size;
    const w = 48 * scale, h = 64 * scale;
    const shape = b.small ? 'round' : o.shape;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    const oy = b.small ? -38 * scale : -8 * scale;
    ctx.globalAlpha = 1;
    ctx.drawImage(bulbSprite(b.color, shape, false), -w / 2, oy, w, h);
    ctx.globalAlpha = Math.min(1, b.lit * (0.55 + 0.45 * gain));
    ctx.drawImage(bulbSprite(b.color, shape, true), -w / 2, oy, w, h);
    ctx.restore();
  }
  ctx.restore();
  return total;
}
