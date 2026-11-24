import { BACKGROUND_PALETTES } from '../shared/scene.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const number = (v, fallback, lo, hi) => clamp(Number.isFinite(Number(v)) ? Number(v) : fallback, lo, hi);
const hex = (v, fallback) => /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')},${alpha})`;
const mix = (a, b, t) => `#${[1, 3, 5].map((i) => Math.round(
  parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t,
).toString(16).padStart(2, '0')).join('')}`;

function random(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function backgroundMotion(cfg, reducedMotion = false) {
  return reducedMotion || cfg.backgroundAnimation === 'none'
    ? 0 : number(cfg.backgroundMotion ?? 1, 1, 0, 2);
}

// One selected request and at most two decoded images. Late reads/decodes
// cannot replace a newer selection, including a switch to no background.
export function createBackgroundImageLoader(load, decode = async (url) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}) {
  let selected = null, image = null, generation = 0, pending = Promise.resolve();
  const cache = new Map();
  return {
    get image() { return image; },
    select(key, force = false) {
      if (key === selected && !force) return pending;
      selected = key;
      const request = ++generation;
      image = null;
      if (!key) return (pending = Promise.resolve());
      pending = (async () => {
        try {
          const url = await load(key);
          if (request !== generation || !url) return;
          const cached = cache.get(key);
          const decoded = cached?.url === url ? cached.image : await decode(url);
          if (request !== generation) return;
          cache.delete(key);
          cache.set(key, { url, image: decoded });
          if (cache.size > 2) cache.delete(cache.keys().next().value);
          image = decoded;
        } catch {
          // Invalid/missing images are a transparent background, not a
          // reason to interrupt the rest of the decorations.
        }
      })();
      return pending;
    },
  };
}

export function imagePlacement(w, h, iw, ih, cfg, time, reducedMotion = false) {
  const motion = backgroundMotion(cfg, reducedMotion);
  const dx = Math.sin(time * 0.11) * w * 0.028 * motion;
  const dy = Math.cos(time * 0.08 + 0.9) * h * 0.022 * motion;
  // Overscan covers BOTH sides of the maximum pan, not just half of it.
  const zoom = 1 + 0.06 * motion + (cfg.backgroundAnimation === 'kenburns'
    ? 0.04 * motion * (1 + Math.sin(time * 0.15 + 0.5)) : 0);
  const fit = cfg.backgroundFit ?? 'cover';
  const scale = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const width = (fit === 'stretch' ? w : iw * scale) * zoom;
  const height = (fit === 'stretch' ? h : ih * scale) * zoom;
  return { x: (w - width) / 2 + dx, y: (h - height) / 2 + dy, width, height, dx, dy };
}

export function drawImageBackground(c, image, w, h, cfg, time, reducedMotion = false) {
  const iw = image?.naturalWidth, ih = image?.naturalHeight;
  if (!iw || !ih) return;
  const p = imagePlacement(w, h, iw, ih, cfg, time, reducedMotion);
  c.save();
  c.beginPath(); c.rect(0, 0, w, h); c.clip();
  c.globalAlpha = number(cfg.backgroundOpacity ?? 1, 1, 0, 1);
  if (cfg.backgroundFit === 'tile') {
    const pattern = c.createPattern(image, 'repeat');
    if (pattern) {
      c.translate(p.dx, p.dy);
      c.fillStyle = pattern;
      c.fillRect(-p.dx, -p.dy, w, h);
    }
  } else {
    c.drawImage(image, p.x, p.y, p.width, p.height);
  }
  c.restore();
}

function layer(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d'));
  return canvas;
}

function hill(c, w, h, y, height, phase) {
  c.beginPath(); c.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) {
    c.lineTo(x, y + Math.sin(x / w * 7 + phase) * height + Math.sin(x / w * 17 + phase) * height * 0.25);
  }
  c.lineTo(w, h); c.closePath(); c.fill();
}

function pine(c, x, y, height, rng, needle, snow, detail) {
  const width = height * (0.17 + rng() * 0.06);
  c.fillStyle = mix(needle, '#6a737c', 0.22);
  c.fillRect(x - height * 0.009, y - height, height * 0.018, height);
  const tiers = detail ? 15 : 10;
  for (let tier = tiers - 1; tier >= 0; tier--) {
    const t = (tier + 1) / tiers;
    const top = y - height + t * height * 0.86;
    const span = width * t;
    for (const side of [-1, 1]) {
      const reach = span * (0.82 + rng() * 0.25);
      c.fillStyle = mix(needle, '#010a12', rng() * 0.3);
      c.beginPath(); c.moveTo(x, top - height * 0.1);
      for (let twig = 0; twig < 7; twig++) {
        const u = twig / 6;
        c.lineTo(x + side * reach * u, top + height * 0.035 * u + (twig % 2) * height * 0.026);
      }
      c.lineTo(x + side * span * 0.22, top + height * 0.07);
      c.lineTo(x, top + height * 0.04); c.closePath(); c.fill();
      c.strokeStyle = rgba(snow, detail ? 0.68 : 0.34);
      c.lineWidth = Math.max(0.55, height * 0.008 * t);
      c.lineCap = 'round';
      c.beginPath(); c.moveTo(x + side * span * 0.08, top - height * 0.025);
      c.quadraticCurveTo(x + side * reach * 0.45, top + height * 0.004,
        x + side * reach * 0.84, top + height * 0.02);
      c.stroke();
    }
  }
}

function bake(w, h, cfg, colors) {
  const fog = number(cfg.backgroundFog ?? 0.45, 0.45, 0, 1);
  const moon = number(cfg.backgroundMoon ?? 1, 1, 0, 2);
  const mx = w * number(cfg.backgroundMoonX ?? 0.78, 0.78, 0, 1);
  const my = h * number(cfg.backgroundMoonY ?? 0.18, 0.18, 0, 0.65);
  const unit = Math.min(w, h);
  const lake = cfg.background === 'alpine-lake';
  const village = cfg.background === 'village';
  const sleighNight = cfg.background === 'sleigh-night';
  const tall = lake || sleighNight;
  const moonSize = sleighNight ? 0.062 : 0.023;
  const sky = layer(w, h, (c) => {
    const g = c.createLinearGradient(0, 0, 0, h * 0.85);
    g.addColorStop(0, colors.sky); g.addColorStop(1, colors.horizon);
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    if (moon > 0) {
      const glow = c.createRadialGradient(mx, my, 0, mx, my, unit * 0.25);
      glow.addColorStop(0, rgba(colors.snow, 0.3 * moon));
      glow.addColorStop(0.3, rgba(colors.snow, 0.09 * moon));
      glow.addColorStop(1, rgba(colors.snow, 0));
      c.fillStyle = glow; c.fillRect(0, 0, w, h);
      c.fillStyle = rgba('#f3f5e9', Math.min(1, 0.86 * moon));
      c.beginPath(); c.arc(mx, my, unit * moonSize, 0, Math.PI * 2); c.fill();
      const rng = random(79);
      c.fillStyle = rgba(colors.horizon, 0.15);
      for (let i = 0; i < 12; i++) {
        const a = rng() * Math.PI * 2, r = rng() * unit * moonSize * 0.74;
        c.beginPath(); c.arc(mx + Math.cos(a) * r, my + Math.sin(a) * r, unit * (0.001 + rng() * 0.004), 0, Math.PI * 2); c.fill();
      }
    }
    const rng = random(702);
    for (let ridge = 0; ridge < 3; ridge++) {
      c.fillStyle = mix(colors.sky, colors.horizon, 0.65 - ridge * 0.12);
      c.beginPath(); c.moveTo(0, h);
      for (let x = -w * 0.1; x <= w * 1.15; x += w * 0.07) {
        c.lineTo(x, h * (0.53 + ridge * 0.05) - rng() * h * (tall ? 0.23 : 0.095));
      }
      c.lineTo(w, h); c.closePath(); c.fill();
    }
  });
  const woods = [0, 1].map((depth) => layer(w, h, (c) => {
    const rng = random(2026 + depth * 91);
    const base = h * (0.66 + depth * 0.12);
    const needle = mix(colors.sky, colors.horizon, depth ? 0.1 : 0.4);
    c.fillStyle = needle; hill(c, w, h, base, h * 0.018, depth);
    const count = Math.min(100, Math.ceil(w / h * (depth ? 26 : 45)));
    for (let i = 0; i < count; i++) {
      const x = (i + rng() * 0.8) / (count - 1) * w;
      if (lake && x > w * 0.26 && x < w * 0.8 && depth) continue;
      const height = h * (depth ? 0.12 + rng() * 0.22 : 0.04 + rng() * 0.14);
      pine(c, x, base + Math.sin(x / w * 7 + depth) * h * 0.018 + h * 0.02,
        height, rng, needle, mix(colors.snow, colors.horizon, depth ? 0.15 : 0.5), depth === 1);
    }
    if (fog > 0) {
      const haze = c.createLinearGradient(0, base - h * 0.2, 0, base + h * 0.04);
      haze.addColorStop(0, rgba(colors.horizon, 0));
      haze.addColorStop(1, rgba(colors.horizon, fog * (depth ? 0.45 : 0.85)));
      c.fillStyle = haze; c.fillRect(0, base - h * 0.2, w, h * 0.3);
    }
  }));
  const ground = layer(w, h, (c) => {
    const snow = c.createLinearGradient(0, h * 0.76, 0, h);
    snow.addColorStop(0, mix(colors.snow, colors.horizon, 0.14));
    snow.addColorStop(1, mix(colors.snow, colors.sky, 0.35));
    c.fillStyle = snow; hill(c, w, h, h * (lake ? 0.83 : 0.85), h * 0.027, 0.5);
    if (lake) {
      const ice = c.createLinearGradient(0, h * 0.7, 0, h);
      ice.addColorStop(0, mix(colors.sky, colors.horizon, 0.65));
      ice.addColorStop(1, mix(colors.snow, colors.horizon, 0.52));
      c.fillStyle = ice;
      c.beginPath(); c.moveTo(w * 0.46, h * 0.72);
      c.bezierCurveTo(w * 0.85, h * 0.79, w * 0.18, h * 0.88, w * 0.78, h);
      c.lineTo(w * 0.08, h);
      c.bezierCurveTo(w * 0.35, h * 0.85, w * 0.31, h * 0.82, w * 0.46, h * 0.72);
      c.fill();
      c.save(); c.clip();
      const rng = random(55);
      for (let i = 0; i < 85; i++) {
        const y = h * (0.74 + rng() * 0.26), x = w * rng();
        c.strokeStyle = rgba(colors.snow, (0.06 + rng() * 0.16) * (0.4 + moon * 0.6));
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + w * (0.01 + rng() * 0.06), y - 1); c.stroke();
      }
      c.restore();
    }
    const rng = random(337);
    c.strokeStyle = rgba(colors.snow, 0.2); c.lineWidth = 0.7;
    for (let i = 0; i < 170; i++) {
      const x = rng() * w, y = h * (0.9 + rng() * 0.1);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 1 + rng() * unit * 0.012, y); c.stroke();
    }
  });
  // Village : maisons cuites une fois ; seules les fenêtres et la fumée
  // sont animées par-dessus (quelques rectangles et disques par image).
  const windows = [], chimneys = [];
  const houses = village ? layer(w, h, (c) => {
    const rng = random(1224);
    const count = Math.max(5, Math.min(11, Math.round(w / h * 5)));
    for (let i = 0; i < count; i++) {
      const hw = unit * (0.075 + rng() * 0.05), hh = hw * (0.62 + rng() * 0.3);
      const x = (i + 0.15 + rng() * 0.5) / count * w - hw / 2;
      const base = h * (0.8 + rng() * 0.035);
      const roof = hh * (0.5 + rng() * 0.25);
      const wall = mix(mix(colors.sky, '#3a2a24', 0.55), colors.horizon, rng() * 0.25);
      c.fillStyle = wall; c.fillRect(x, base - hh, hw, hh);
      c.fillStyle = mix(wall, '#000000', 0.35);
      c.beginPath(); c.moveTo(x - hw * 0.08, base - hh); c.lineTo(x + hw / 2, base - hh - roof);
      c.lineTo(x + hw * 1.08, base - hh); c.closePath(); c.fill();
      // Neige sur le toit.
      c.strokeStyle = rgba(colors.snow, 0.95); c.lineWidth = Math.max(2, hw * 0.07); c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(x - hw * 0.06, base - hh - 1); c.lineTo(x + hw / 2, base - hh - roof);
      c.lineTo(x + hw * 1.06, base - hh - 1); c.stroke();
      const cx = x + hw * (0.68 + rng() * 0.12), cw = hw * 0.11;
      c.fillStyle = mix(wall, '#000000', 0.45); c.fillRect(cx, base - hh - roof * 0.75, cw, roof * 0.55);
      c.fillStyle = rgba(colors.snow, 0.95); c.fillRect(cx - 1, base - hh - roof * 0.78, cw + 2, Math.max(2, hw * 0.03));
      chimneys.push({ x: (cx + cw / 2) / w, y: (base - hh - roof * 0.8) / h, phase: rng() * 9 });
      c.fillStyle = mix(wall, '#000000', 0.5); c.fillRect(x + hw * 0.42, base - hh * 0.42, hw * 0.16, hh * 0.42);
      const cols = hw > unit * 0.1 ? 3 : 2;
      for (let k = 0; k < cols; k++) {
        if (rng() < 0.18) continue;
        const ww = hw * 0.15, wh = hh * 0.2;
        const wx = x + hw * (0.12 + k * (0.76 - 0.15) / Math.max(1, cols - 1)), wy = base - hh * 0.8;
        c.fillStyle = '#1b1410'; c.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);
        windows.push({ x: wx / w, y: wy / h, w: ww / w, h: wh / h, phase: rng() * 20, hue: rng() });
      }
    }
    c.fillStyle = mix(colors.snow, colors.horizon, 0.1); hill(c, w, h, h * 0.835, h * 0.012, 2.2);
  }) : null;
  const sleigh = sleighNight ? layer(360, 90, (c) => {
    c.fillStyle = mix(colors.sky, '#000000', 0.55); c.strokeStyle = c.fillStyle; c.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const x = 150 + i * 50, y = 44 - i * 6;
      c.beginPath(); c.ellipse(x, y, 17, 6.5, -0.15, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(x + 18, y - 9, 6.5, 4.5, -0.5, 0, Math.PI * 2); c.fill();
      c.lineWidth = 2.2; c.beginPath();
      c.moveTo(x - 11, y + 3); c.lineTo(x - 20, y + 17); c.moveTo(x - 6, y + 4); c.lineTo(x - 9, y + 19);
      c.moveTo(x + 9, y + 3); c.lineTo(x + 20, y + 14); c.moveTo(x + 13, y + 1); c.lineTo(x + 26, y + 8);
      c.moveTo(x + 19, y - 12); c.lineTo(x + 17, y - 22); c.moveTo(x + 18, y - 17); c.lineTo(x + 24, y - 21);
      c.stroke();
    }
    c.lineWidth = 1.2; c.beginPath(); c.moveTo(96, 50); c.lineTo(330, 20); c.stroke();
    c.beginPath(); c.moveTo(22, 46); c.quadraticCurveTo(26, 68, 60, 66); c.lineTo(98, 64);
    c.quadraticCurveTo(104, 50, 96, 44); c.lineTo(80, 50); c.lineTo(46, 50); c.quadraticCurveTo(30, 44, 22, 46); c.fill();
    c.lineWidth = 2.5; c.beginPath(); c.moveTo(16, 74); c.lineTo(100, 74); c.quadraticCurveTo(112, 72, 110, 62); c.stroke();
    c.beginPath(); c.arc(60, 36, 11, 0, Math.PI * 2); c.fill();                     // hotte
    c.beginPath(); c.arc(78, 38, 7, 0, Math.PI * 2); c.fill();                      // Père Noël
    c.beginPath(); c.moveTo(72, 33); c.lineTo(80, 22); c.lineTo(85, 34); c.fill();  // bonnet
  }) : null;
  const glow = layer(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,178,95,0.38)');
    g.addColorStop(0.35, 'rgba(255,151,67,0.17)');
    g.addColorStop(1, 'rgba(255,133,50,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  });
  return { sky, woods, ground, glow, houses, windows, chimneys, sleigh };
}

function blob(color, size = 256) {
  return layer(size, size, (c) => {
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, rgba(color, 0.9)); g.addColorStop(0.45, rgba(color, 0.32)); g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g; c.fillRect(0, 0, size, size);
  });
}

function disc(color, size = 96) {
  return layer(size, size, (c) => {
    const r = size / 2;
    const g = c.createRadialGradient(r, r, r * 0.55, r, r, r);
    g.addColorStop(0, rgba(color, 0.42)); g.addColorStop(0.82, rgba(color, 0.55)); g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g; c.beginPath(); c.arc(r, r, r, 0, Math.PI * 2); c.fill();
  });
}

const BOKEH_LIGHTS = ['#ffb347', '#ff5d5d', '#ffd75e', '#3ddc97', '#9fe8ff'];

/// Fonds « modernes » : aucun paysage, seulement de grands halos colorés
/// (aurora-gradient) ou des lumières floues qui dérivent (bokeh). Les
/// sprites sont cuits une fois ; une image = une trentaine de copies.
function bakeModern(cfg, colors) {
  if (cfg.background === 'bokeh') {
    return { discs: [...BOKEH_LIGHTS, colors.snow].map((color) => disc(color)) };
  }
  return { blobs: [colors.horizon, mix(colors.horizon, '#5cffb0', 0.6), mix(colors.sky, '#b98cff', 0.55), colors.snow].map((color) => blob(color)) };
}

function drawModern(c, w, h, t, cfg, colors, baked, opacity, detail) {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, colors.sky); g.addColorStop(1, mix(colors.sky, colors.horizon, 0.38));
  c.globalAlpha = opacity; c.fillStyle = g; c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  const unit = Math.max(w, h);
  if (baked.blobs) {
    baked.blobs.forEach((sprite, i) => {
      const size = unit * (0.75 + i * 0.12);
      const x = w * (0.5 + 0.38 * Math.sin(t * (0.021 + i * 0.006) + i * 1.9));
      const y = h * (0.42 + 0.3 * Math.cos(t * (0.017 + i * 0.005) + i * 2.6));
      c.globalAlpha = opacity * (i === 3 ? 0.12 : 0.5);
      c.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    });
  } else {
    const count = Math.max(8, Math.round(Math.min(34, w * h / 60000) * detail));
    for (let i = 0; i < count; i++) {
      const depth = (i * 0.618) % 1;
      const size = unit * (0.025 + depth * 0.075);
      const x = ((i * 0.3819 + t * 0.004 * (0.3 + depth)) % 1.2 - 0.1) * w;
      const y = h * ((i * 0.7548) % 1) + Math.sin(t * 0.13 + i) * h * 0.02;
      c.globalAlpha = opacity * (0.22 + 0.3 * depth) * (0.72 + 0.28 * Math.sin(t * 0.5 + i * 2.3));
      c.drawImage(baked.discs[i % baked.discs.length], x - size / 2, y - size / 2, size, size);
    }
  }
  c.globalCompositeOperation = 'source-over';
}

// A renderer owns ONE bake, replaced on appearance/viewport changes.
// Four capped raster layers retain detailed branches without rebuilding
// paths/gradients each frame; animation is only blits and faint flakes.
export function createWinterBackgroundRenderer() {
  let key = '', cached = null;
  return {
    draw(c, w, h, time, cfg, decor = {}, reducedMotion = false) {
      if (!(w > 0 && h > 0)) return;
      const preset = BACKGROUND_PALETTES[cfg.backgroundPalette] ?? BACKGROUND_PALETTES.midnight;
      const colors = cfg.backgroundPalette === 'custom' ? {
        sky: hex(cfg.backgroundSky, preset.sky),
        horizon: hex(cfg.backgroundHorizon, preset.horizon),
        snow: hex(cfg.backgroundSnow, preset.snow),
      } : preset;
      const opacityAll = number(cfg.backgroundOpacity ?? 1, 1, 0, 1);
      const detail = number(decor.detail ?? 1, 1, 0.2, 1);
      if (cfg.background === 'bokeh' || cfg.background === 'aurora-gradient') {
        const modernKey = JSON.stringify(['modern', cfg.background, colors]);
        if (key !== modernKey) { cached = bakeModern(cfg, colors); key = modernKey; }
        const m = backgroundMotion(cfg, reducedMotion);
        c.save(); c.beginPath(); c.rect(0, 0, w, h); c.clip();
        // +40 s : à mouvement nul l'image reste composée, pas empilée à l'origine.
        drawModern(c, w, h, 40 + (m ? time * m : 0), cfg, colors, cached, opacityAll, detail);
        c.restore();
        return;
      }
      const scale = Math.min(1, 1440 / w, 900 / h, Math.sqrt(1300000 / (w * h)));
      const bw = Math.max(1, Math.ceil(w * scale)), bh = Math.max(1, Math.ceil(h * scale));
      const nextKey = JSON.stringify([bw, bh, cfg.background, colors, cfg.backgroundFog,
        cfg.backgroundMoon, cfg.backgroundMoonX, cfg.backgroundMoonY]);
      if (key !== nextKey) {
        cached = bake(bw, bh, cfg, colors);
        key = nextKey;
      }
      const motion = backgroundMotion(cfg, reducedMotion);
      const t = motion ? time * motion : 0;
      const opacity = number(cfg.backgroundOpacity ?? 1, 1, 0, 1);
      c.save(); c.beginPath(); c.rect(0, 0, w, h); c.clip();
      c.globalAlpha = opacity;
      c.drawImage(cached.sky, 0, 0, w, h);
      if (cached.sleigh && motion) {
        // Une traversée du ciel toutes les 50 s environ, sur un arc qui
        // passe devant la lune.
        const u = ((t * 0.02) % 1) * 1.5 - 0.25;
        const sw = Math.min(w, h) * 0.3, sh = sw / 4;
        const sx = u * w, sy = h * (number(cfg.backgroundMoonY ?? 0.18, 0.18, 0, 0.65) + 0.02) + (u - 0.5) ** 2 * h * 0.22;
        c.save(); c.translate(sx, sy); c.rotate(-0.12 + (u - 0.5) * 0.2);
        c.drawImage(cached.sleigh, -sw / 2, -sh / 2, sw, sh);
        c.restore();
      }
      const pan = Math.sin(t * 0.045) * w * 0.008;
      const zoom = cfg.backgroundAnimation === 'kenburns' && motion ? 0.008 * (1 + Math.sin(t * 0.06)) : 0;
      for (let i = 0; i < 2; i++) {
        const margin = w * (0.014 + zoom);
        c.drawImage(cached.woods[i], -margin + pan * (i + 1) * 0.5,
          -h * zoom, w + margin * 2, h * (1 + zoom));
      }
      c.drawImage(cached.ground, 0, 0, w, h);
      if (cached.houses) {
        c.drawImage(cached.houses, 0, 0, w, h);
        for (const win of cached.windows) {
          const flicker = motion ? 0.78 + 0.22 * Math.sin(t * 1.3 + win.phase) * Math.sin(t * 0.37 + win.phase * 2) : 0.85;
          c.globalAlpha = opacity * flicker;
          c.fillStyle = win.hue > 0.8 ? '#ffe9b8' : win.hue > 0.4 ? '#ffc56b' : '#ffab4a';
          c.fillRect(win.x * w, win.y * h, win.w * w, win.h * h);
          c.globalAlpha = opacity * flicker * 0.16;
          c.fillRect((win.x - win.w * 0.6) * w, (win.y - win.h * 0.5) * h, win.w * 2.2 * w, win.h * 2 * h);
        }
        if (motion) {
          c.fillStyle = colors.snow;
          for (const ch of cached.chimneys) {
            for (let k = 0; k < 4; k++) {
              const life = (t * 0.07 + ch.phase + k * 0.25) % 1;
              c.globalAlpha = opacity * 0.16 * (1 - life);
              c.beginPath();
              c.arc(ch.x * w + Math.sin(life * 4 + ch.phase) * h * 0.012 + life * h * 0.02,
                ch.y * h - life * h * 0.09, h * (0.006 + life * 0.014), 0, Math.PI * 2);
              c.fill();
            }
          }
        }
        c.globalAlpha = opacity;
      }
      const contribution = number(cfg.look?.fireplaceContribution ?? 1, 1, 0, 2);
      const intensity = number(decor.lightIntensity ?? 1, 1, 0, 2) * contribution;
      if (intensity > 0) {
        c.globalCompositeOperation = 'screen';
        c.globalAlpha = opacity * Math.min(1, intensity * 0.65);
        for (const fire of cfg.fireplaces ?? []) {
          const size = number(fire.scale ?? 1, 1, 0, 3) * number(decor.decorScale ?? 1, 1, 0, 3);
          if (size === 0) continue;
          const radius = Math.min(w * 0.3, h * 0.4) * size;
          const x = number(fire.x ?? 0.5, 0.5, 0, 1) * w;
          c.drawImage(cached.glow, x - radius, h - radius * 0.4, radius * 2, radius * 0.8);
        }
        c.globalCompositeOperation = 'source-over';
      }
      c.fillStyle = colors.snow;
      const count = Math.min(90, Math.ceil(w * h / 22000));
      for (let i = 0; i < count; i++) {
        const x = ((i * 157.31 + t * (3 + i % 4)) % (w + 20)) - 10;
        const y = ((i * 97.73 + t * (5 + i % 6)) % (h * 0.86));
        c.globalAlpha = opacity * (0.12 + i % 4 * 0.08);
        c.beginPath(); c.arc(x, y, 0.5 + i % 3 * 0.3, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    },
  };
}
