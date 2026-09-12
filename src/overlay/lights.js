// Animated light layers: night sky (stars, aurora, shooting stars),
// glitter on settled snow, and an icicle fringe that catches the light
// and drips. Drawn by snow.js around the rest of the scene.
//
// Same performance model as decor.js, and for the same reason — these
// layers run on every frame of a 120fps budget:
//
//   * every light is a sprite BAKED ONCE (star, sparkle, comet, aurora
//     ribbon, icicle fringe) and blitted with a varying alpha/scale;
//   * NO gradient, path or shadowBlur is created inside the frame loop;
//   * anything whose animation curve has it invisible this frame is
//     skipped before the draw call rather than drawn at alpha 0.
//
// Everything here is additive light (`globalCompositeOperation =
// 'lighter'`), which is both what real light does and what lets these
// layers sit over a transparent overlay without dimming the desktop.

// ---------------------------------------------------------------------------
// helpers (kept local so this module has no import cycle with decor.js)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w));
  cv.height = Math.max(1, Math.ceil(h));
  return cv;
}

// ---------------------------------------------------------------------------
// baked sprites
// ---------------------------------------------------------------------------

/// A star: a tight core with a soft halo and a faint four-point flare.
/// Real point lights flare along the optics, which is what stops a star
/// from reading as a plain white dot.
const starSprite = (() => {
  const S = 48;
  const cv = makeCanvas(S, S);
  const c = cv.getContext('2d');
  const r = S / 2;
  const g = c.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.1, 'rgba(226,238,255,0.85)');
  g.addColorStop(0.3, 'rgba(180,208,255,0.22)');
  g.addColorStop(1, 'rgba(140,180,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);

  c.globalCompositeOperation = 'lighter';
  const flare = c.createLinearGradient(0, r, S, r);
  flare.addColorStop(0, 'rgba(255,255,255,0)');
  flare.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  flare.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = flare;
  c.fillRect(0, r - 0.7, S, 1.4);
  c.save();
  c.translate(r, r);
  c.rotate(Math.PI / 2);
  c.translate(-r, -r);
  c.fillStyle = flare;
  c.fillRect(0, r - 0.7, S, 1.4);
  c.restore();
  return cv;
})();

/// A four-point sparkle — the glint snow crystals throw when a light
/// catches them at the right angle. Longer spikes than the star flare and
/// no halo, because it is a specular flash, not a light source.
const sparkleSprite = (() => {
  const S = 40;
  const cv = makeCanvas(S, S);
  const c = cv.getContext('2d');
  const r = S / 2;
  c.globalCompositeOperation = 'lighter';
  for (const rot of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
    const long = rot % (Math.PI / 2) === 0 ? 1 : 0.45;
    c.save();
    c.translate(r, r);
    c.rotate(rot);
    const g = c.createLinearGradient(-r * long, 0, r * long, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${0.9 * long})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(-r * long, -0.9, 2 * r * long, 1.8);
    c.restore();
  }
  const core = c.createRadialGradient(r, r, 0, r, r, 5);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = core;
  c.fillRect(0, 0, S, S);
  return cv;
})();

/// A comet head and tail, baked pointing to the right so a shooting star
/// is one rotated blit.
const cometSprite = (() => {
  const W = 256;
  const H = 24;
  const cv = makeCanvas(W, H);
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(160,200,255,0)');
  g.addColorStop(0.7, 'rgba(200,224,255,0.25)');
  g.addColorStop(0.95, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  // A tail that tapers to the head instead of a flat bar.
  c.beginPath();
  c.moveTo(0, H / 2);
  c.quadraticCurveTo(W * 0.7, H / 2 - 3.2, W, H / 2 - 1.2);
  c.quadraticCurveTo(W * 0.7, H / 2 + 3.2, 0, H / 2);
  c.closePath();
  c.fill();
  const head = c.createRadialGradient(W - 6, H / 2, 0, W - 6, H / 2, 9);
  head.addColorStop(0, 'rgba(255,255,255,1)');
  head.addColorStop(1, 'rgba(190,220,255,0)');
  c.fillStyle = head;
  c.fillRect(W - 24, 0, 24, H);
  return cv;
})();

/// One aurora curtain: a wavy band with a vertical falloff, then vertical
/// striations combed through it. The striations are the whole trick — a
/// smooth blob reads as fog, a combed one reads as an aurora.
function bakeAurora(color, seed) {
  const W = 640;
  const H = 260;
  const cv = makeCanvas(W, H);
  const c = cv.getContext('2d');
  const rand = mulberry32(seed);

  // A real aurora is brightest a little way down the curtain and fades to
  // nothing well before the horizon. Keeping the peak modest matters here
  // for a second reason: this is an overlay over the user's desktop, and a
  // heavy wash of colour across half the screen would get in the way of
  // whatever they are actually looking at.
  const band = c.createLinearGradient(0, 0, 0, H);
  band.addColorStop(0, `rgba(${color},0)`);
  band.addColorStop(0.16, `rgba(${color},0.34)`);
  band.addColorStop(0.38, `rgba(${color},0.52)`);
  band.addColorStop(0.62, `rgba(${color},0.1)`);
  // Reaches zero before the sprite's own edge, so the curtain dissolves
  // into the sky instead of ending on a straight horizontal cut.
  band.addColorStop(0.82, `rgba(${color},0)`);
  band.addColorStop(1, `rgba(${color},0)`);

  c.fillStyle = band;
  c.beginPath();
  c.moveTo(0, H * 0.3);
  for (let x = 0; x <= W; x += 16) {
    const t = x / W;
    const y = H * 0.3 + Math.sin(t * 6.2 + seed) * H * 0.12 + Math.sin(t * 13.7) * H * 0.05;
    c.lineTo(x, y);
  }
  c.lineTo(W, H);
  c.lineTo(0, H);
  c.closePath();
  c.fill();

  // Comb it: erase narrow vertical gaps so the curtain shows rays. The
  // gaps are deeper towards the bottom, which is what gives a curtain its
  // frayed lower edge instead of a straight cut.
  c.globalCompositeOperation = 'destination-out';
  for (let x = 0; x < W; x += 4) {
    const g = c.createLinearGradient(0, 0, 0, H);
    const a = 0.2 + rand() * 0.55;
    g.addColorStop(0, `rgba(0,0,0,${a * 0.5})`);
    g.addColorStop(0.6, `rgba(0,0,0,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0.95)');
    c.fillStyle = g;
    c.fillRect(x + rand() * 2, 0, 1 + rand() * 2, H);
  }
  c.globalCompositeOperation = 'source-over';
  return cv;
}

let auroraSprites = null;
function getAurora() {
  if (!auroraSprites) {
    auroraSprites = [
      { cv: bakeAurora('92,255,176', 3), speed: 0.021, bob: 22, hueAlpha: 0.24 },
      { cv: bakeAurora('120,196,255', 9), speed: -0.014, bob: 15, hueAlpha: 0.17 },
      { cv: bakeAurora('176,128,255', 17), speed: 0.009, bob: 28, hueAlpha: 0.13 },
    ];
  }
  return auroraSprites;
}

// ---------------------------------------------------------------------------
// star field
// ---------------------------------------------------------------------------

let starField = null;
let starFieldKey = '';

function getStars(w, h) {
  const key = `${w}x${h}`;
  if (starField && starFieldKey === key) return starField;
  const rand = mulberry32(20241224);
  const count = Math.round((w * h) / 26000);
  const stars = [];
  for (let i = 0; i < count; i++) {
    // Brightness follows a steep curve: a real sky is mostly faint stars
    // with a handful of bright ones, not a uniform spread.
    const mag = rand() ** 2.4;
    stars.push({
      x: rand() * w,
      y: rand() * h * 0.62,
      size: 3 + mag * 12,
      base: 0.18 + mag * 0.7,
      // Scintillation is fast and irregular, so two incommensurate rates.
      phase: rand() * Math.PI * 2,
      rate: 0.7 + rand() * 2.6,
      rate2: 3.1 + rand() * 5.5,
    });
  }
  starField = stars;
  starFieldKey = key;
  return stars;
}

// ---------------------------------------------------------------------------
// public layers
// ---------------------------------------------------------------------------

/// Sky layer: aurora curtains, twinkling stars and the occasional
/// shooting star. Drawn behind everything else.
export function drawSky(ctx, w, h, time, opts = {}) {
  const gain = opts.lightIntensity ?? 1;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  if (opts.aurora) {
    for (let i = 0; i < getAurora().length; i++) {
      const a = getAurora()[i];
      // Each curtain drifts at its own rate and breathes on its own
      // period, so they never line up into one moving blob.
      const drift = ((time * a.speed) % 1 + 1) % 1;
      const breathe = 0.55 + 0.45 * Math.sin(time * 0.31 + i * 2.1);
      // Kept in the top third of the screen: the sky is where an aurora
      // belongs, and it leaves the working area of the desktop clear.
      const bandH = h * (0.3 + 0.05 * i);
      const y = -h * 0.02 + Math.sin(time * 0.17 + i) * a.bob;
      ctx.globalAlpha = a.hueAlpha * breathe * gain;
      // Two blits offset by one width give a seamless horizontal wrap.
      ctx.drawImage(a.cv, -drift * w, y, w, bandH);
      ctx.drawImage(a.cv, (1 - drift) * w, y, w, bandH);
    }
  }

  if (opts.stars) {
    for (const s of getStars(w, h)) {
      const twinkle =
        0.62 + 0.26 * Math.sin(time * s.rate + s.phase) + 0.12 * Math.sin(time * s.rate2);
      const alpha = s.base * twinkle * gain;
      if (alpha < 0.03) continue;
      const size = s.size * (0.85 + twinkle * 0.3);
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(starSprite, s.x - size / 2, s.y - size / 2, size, size);
    }

    // One shooting star at a time, on a ~9s cycle, crossing in ~0.7s.
    const CYCLE = 9;
    const cycle = time % CYCLE;
    if (cycle < 0.7) {
      const p = cycle / 0.7;
      const n = Math.floor(time / CYCLE);
      const rand = mulberry32(n * 977);
      const startX = rand() * w * 0.7;
      const startY = rand() * h * 0.3;
      const angle = 0.3 + rand() * 0.3;
      const dist = w * 0.45;
      const x = startX + Math.cos(angle) * dist * p;
      const y = startY + Math.sin(angle) * dist * p;
      // Fades in then out, so it never pops on or off at full brightness.
      ctx.globalAlpha = Math.sin(p * Math.PI) * 0.9 * gain;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      const len = 210 * (0.5 + p * 0.8);
      ctx.drawImage(cometSprite, -len, -12, len, 24);
      ctx.restore();
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// ---------------------------------------------------------------------------
// glitter on settled snow
// ---------------------------------------------------------------------------

let glitterPoints = null;
let glitterKey = '';

/// Sparkles scattered over the surface of the settled snow. Each one
/// flashes briefly and rarely — `sin(...)**14` keeps a sparkle dark for
/// most of its cycle, which is what makes the bank glitter instead of
/// shimmering uniformly like water.
export function drawGlitter(ctx, w, h, time, accumulation, opts = {}) {
  if (!accumulation || !accumulation.length) return;
  const gain = opts.lightIntensity ?? 1;
  const key = `${w}x${h}`;
  if (!glitterPoints || glitterKey !== key) {
    const rand = mulberry32(77345);
    const count = Math.round(w / 14);
    glitterPoints = [];
    for (let i = 0; i < count; i++) {
      glitterPoints.push({
        col: Math.floor(rand() * accumulation.length),
        inset: rand() * 0.55,
        size: 7 + rand() * 13,
        phase: rand() * Math.PI * 2,
        rate: 0.5 + rand() * 1.7,
      });
    }
    glitterKey = key;
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of glitterPoints) {
    const depth = accumulation[Math.min(accumulation.length - 1, p.col)];
    if (depth < 2) continue;
    const flash = Math.sin(time * p.rate + p.phase);
    if (flash <= 0) continue;
    const intensity = flash ** 14;
    if (intensity < 0.04) continue;
    const x = p.col * 4;
    const y = h - depth * (1 - p.inset) + 1;
    const size = p.size * (0.6 + intensity * 0.6);
    ctx.globalAlpha = Math.min(1, intensity * gain);
    ctx.drawImage(sparkleSprite, x - size / 2, y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// ---------------------------------------------------------------------------
// icicle fringe
// ---------------------------------------------------------------------------

let icicleCache = null;

function bakeIcicles(w, scale) {
  const h = Math.round(64 * scale);
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const rand = mulberry32(5150);
  const tips = [];

  // Ice is mostly refracted background with a bright rim, so the body is
  // drawn very transparent and the edges carry almost all the contrast.
  // Gaps between groups: a fringe with no gaps reads as a row of teeth,
  // whereas real icicles form in clusters where meltwater runs off.
  let x = rand() * 40 * scale;
  while (x < w) {
    if (rand() < 0.42) {
      x += (18 + rand() * 70) * scale;
      continue;
    }
    const bw = (6 + rand() * 9) * scale;
    const bh = (10 + rand() ** 2.4 * 40) * scale;
    const tipX = x + bw / 2 + (rand() - 0.5) * 2 * scale;

    // Ice is almost entirely refracted background; nearly all of its
    // contrast lives in the rim and the internal highlight below.
    const body = c.createLinearGradient(0, 0, 0, bh);
    body.addColorStop(0, 'rgba(214,236,255,0.3)');
    body.addColorStop(0.55, 'rgba(228,244,255,0.15)');
    body.addColorStop(1, 'rgba(255,255,255,0.05)');
    c.fillStyle = body;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x + bw, 0);
    c.quadraticCurveTo(x + bw * 0.82, bh * 0.55, tipX, bh);
    c.quadraticCurveTo(x + bw * 0.18, bh * 0.55, x, 0);
    c.closePath();
    c.fill();

    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.lineWidth = 1;
    c.stroke();

    // Internal highlight down one flank.
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    c.lineWidth = 1 * scale;
    c.beginPath();
    c.moveTo(x + bw * 0.34, bh * 0.08);
    c.quadraticCurveTo(x + bw * 0.4, bh * 0.5, tipX - 0.5 * scale, bh * 0.9);
    c.stroke();

    tips.push({ x: tipX, y: bh, phase: rand() * Math.PI * 2, rate: 0.25 + rand() * 0.5 });
    x += bw - 1 * scale;
  }

  // A thin, uneven snow lip along the screen edge, tying the fringe to it.
  const lip = c.createLinearGradient(0, 0, 0, 9 * scale);
  lip.addColorStop(0, 'rgba(255,255,255,0.82)');
  lip.addColorStop(1, 'rgba(226,240,255,0)');
  c.fillStyle = lip;
  c.beginPath();
  c.moveTo(0, 0);
  for (let sx = 0; sx <= w; sx += 14) {
    c.lineTo(sx, 3.2 * scale + Math.sin(sx * 0.031) * 1.5 * scale + Math.sin(sx * 0.0083) * 2.2 * scale);
  }
  c.lineTo(w, 0);
  c.closePath();
  c.fill();

  return { cv, tips, h };
}

/// The icicle fringe along the top edge: baked ice, plus two live
/// animations — a specular glint travelling along the row, and meltwater
/// drops that swell at a tip, fall and fade.
export function drawIcicles(ctx, w, h, time, opts = {}) {
  const gain = opts.lightIntensity ?? 1;
  const scale = Math.max(0.8, Math.min(1.8, h / 900));
  if (!icicleCache || icicleCache.w !== w || icicleCache.scale !== scale) {
    icicleCache = { w, scale, ...bakeIcicles(w, scale) };
  }
  const { cv, tips } = icicleCache;

  ctx.drawImage(cv, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Glint: a soft light sweeping across the row, brightening whichever
  // tips it is passing. One moving highlight reads as a light source in
  // the room far better than every tip twinkling independently.
  const sweep = ((time * 0.11) % 1.4) * w;
  for (const t of tips) {
    const d = Math.abs(t.x - sweep);
    const near = Math.max(0, 1 - d / (w * 0.12));
    const breath = 0.35 + 0.3 * Math.sin(time * t.rate + t.phase);
    const alpha = (near * 0.5 + breath * 0.1) * gain;
    if (alpha < 0.05) continue;
    const size = 8 + near * 13;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sparkleSprite, t.x - size / 2, t.y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // Meltwater: a handful of tips drip on long, staggered cycles.
  ctx.fillStyle = 'rgba(216,238,255,0.75)';
  for (let i = 0; i < Math.min(6, tips.length); i++) {
    const t = tips[Math.floor((i * tips.length) / 6)];
    const period = 4.5 + i * 0.9;
    const p = ((time + i * 1.7) % period) / period;
    if (p > 0.45) continue;
    const fall = p / 0.45;
    // Swells at the tip, then accelerates away under gravity.
    const y = t.y + fall * fall * h * 0.35;
    const r = (1.6 + (1 - fall) * 1.4) * scale;
    ctx.globalAlpha = Math.min(1, (1 - fall) * 0.85);
    ctx.beginPath();
    ctx.ellipse(t.x, y, r * 0.8, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/// Invalidates every size-dependent bake. Called on resize so a moved or
/// resized window doesn't keep drawing a fringe and star field cut for
/// the old dimensions.
export function invalidateLights() {
  starField = null;
  glitterPoints = null;
  icicleCache = null;
}
