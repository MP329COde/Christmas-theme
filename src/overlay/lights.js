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

import { resolveAuroraPalette } from '../shared/scene.js';

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

/// AURORA — rebuilt as a curtain of rays.
///
/// The previous version baked one wavy band and combed vertical gaps into
/// it, then slid it sideways. That is why it read as a radio-wave
/// diagram: a fixed silhouette translating across the screen, with hard
/// comb edges and no depth behind it.
///
/// A real aurora is a CURTAIN. Its shape is a long undulating base line
/// high in the atmosphere, and from that line individual rays extend
/// upward along the magnetic field, each with its own height that changes
/// from second to second. It is brightest along the lower edge, fades to
/// nothing at the top, and the base often carries a magenta fringe where
/// nitrogen emits below the green oxygen layer.
///
/// So that is what is drawn: one ray sprite baked per colour, then a few
/// hundred cheap blits per frame whose x, height and alpha are driven by
/// noise. The curtain therefore MORPHS rather than translating, and the
/// rays shimmer independently. Cost is a few hundred drawImage calls and
/// still zero gradients per frame.
const RAY_W = 16;
const RAY_H = 512;

function bakeRay(color, softness) {
  const cv = makeCanvas(RAY_W, RAY_H);
  const c = cv.getContext('2d');
  // Bright at the bottom (the curtain's lower edge), dissolving upward.
  const g = c.createLinearGradient(0, RAY_H, 0, 0);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(0.06, `rgba(${color},0.85)`);
  g.addColorStop(0.22, `rgba(${color},0.5)`);
  g.addColorStop(0.55, `rgba(${color},0.18)`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, RAY_W, RAY_H);

  // Soften the sides so neighbouring rays blend into a sheet instead of
  // reading as a picket fence — the single thing that most gave the old
  // version away.
  c.globalCompositeOperation = 'destination-in';
  const side = c.createLinearGradient(0, 0, RAY_W, 0);
  side.addColorStop(0, 'rgba(0,0,0,0)');
  side.addColorStop(0.5, `rgba(0,0,0,${softness})`);
  side.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = side;
  c.fillRect(0, 0, RAY_W, RAY_H);
  return cv;
}

/// The diffuse air-glow the rays sit in. Without it the curtain floats on
/// black and the sky behind has no body.
///
/// Faded on the left and right as well as top and bottom: the glow is
/// drawn as a run of overlapping segments that follow the curtain's base
/// line, and a segment with hard vertical edges leaves a visible
/// rectangular seam against its neighbour.
function bakeHaze(color) {
  const W = 256;
  const H = 256;
  const cv = makeCanvas(W, H);
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, H, 0, 0);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(0.12, `rgba(${color},0.30)`);
  g.addColorStop(0.45, `rgba(${color},0.12)`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  c.globalCompositeOperation = 'destination-in';
  const side = c.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(0,0,0,0)');
  side.addColorStop(0.4, 'rgba(0,0,0,1)');
  side.addColorStop(0.6, 'rgba(0,0,0,1)');
  side.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = side;
  c.fillRect(0, 0, W, H);
  return cv;
}

const auroraCurtains = new Map();
function paletteKey(paletteName, customColors = null) {
  if (paletteName !== 'custom' || !customColors) return paletteName;
  return `custom:${customColors.colors.join(',')}:${(customColors.haze ?? []).join(',')}`;
}
function getAurora(paletteName, customColors = null) {
  const key = paletteKey(paletteName, customColors);
  if (auroraCurtains.has(key)) return auroraCurtains.get(key);
  const rand = mulberry32(80211);
  const palette = resolveAuroraPalette(paletteName, customColors);
  // Three curtains at different depths. The far one is slow, wide and
  // dim; the near one is faster and sharper. That difference alone gives
  // the sky depth the old single band never had.
  const specs = [
    { color: palette.colors[0].slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','), haze: palette.haze[0].slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','), depth: 0.35, softness: 0.85, rays: 120, drift: 0.010, base: 0.15, amp: 0.045, alpha: 0.27 },
    { color: palette.colors[1].slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','), haze: palette.haze[1].slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','), depth: 0.65, softness: 0.7, rays: 90, drift: -0.017, base: 0.11, amp: 0.06, alpha: 0.17 },
    { color: palette.colors[2].slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','), haze: palette.haze[2].slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','), depth: 1.0, softness: 0.6, rays: 60, drift: 0.026, base: 0.19, amp: 0.04, alpha: 0.12 },
  ];
  for (const s of specs) {
    s.ray = bakeRay(s.color, s.softness);
    s.hazeSprite = bakeHaze(s.haze);
    s.phases = new Float32Array(s.rays);
    s.rates = new Float32Array(s.rays);
    s.widths = new Float32Array(s.rays);
    // Jitters each ray off its even i/rays slot. A per-ray jitter alone
    // still reads as a comb, though — every ray keeps roughly its own
    // slot, so the AVERAGE spacing stays perfectly even and the eye still
    // locks onto that rhythm. A real curtain has whole stretches that
    // bunch into wisps and others that thin out, so on top of the per-ray
    // jitter, warpFreq/warpPhase/warpAmp below bend the 0..1 layout with
    // two unrelated low-frequency waves per curtain, unevenly compressing
    // and stretching stretches of it — that's what actually kills the
    // "radio-wave diagram" look, not the fine jitter.
    s.offsets = new Float32Array(s.rays);
    s.warpAmp = [0.05 + rand() * 0.05, 0.025 + rand() * 0.03];
    s.warpFreq = [1 + Math.floor(rand() * 2), 3 + Math.floor(rand() * 3)];
    s.warpPhase = [rand() * Math.PI * 2, rand() * Math.PI * 2];
    for (let i = 0; i < s.rays; i++) {
      s.phases[i] = rand() * Math.PI * 2;
      s.rates[i] = 0.35 + rand() * 1.25;
      s.widths[i] = 0.7 + rand() * 1.5;
      s.offsets[i] = (rand() - 0.5) * 1.6 / s.rays;
    }
    // Same reasoning as the ray offsets above, applied to the haze
    // segments: 13 identical sprites sitting on a perfectly even i/segs
    // grid sum, under additive blending, into a periodic ripple — visible
    // as vertical bands across the whole curtain. A little per-segment
    // jitter in position, height and strength breaks that periodicity up.
    const segs = 12;
    s.hazeOffsetX = new Float32Array(segs + 1);
    s.hazeOffsetY = new Float32Array(segs + 1);
    s.hazeAlphaJ = new Float32Array(segs + 1);
    for (let i = 0; i <= segs; i++) {
      s.hazeOffsetX[i] = (rand() - 0.5) * 0.7 / segs;
      s.hazeOffsetY[i] = (rand() - 0.5) * 0.16;
      s.hazeAlphaJ[i] = 0.75 + rand() * 0.5;
    }
  }
  auroraCurtains.set(key, specs);
  return specs;
}

/// Where a curtain's lower edge sits at horizontal position `t` (0..1).
/// Three waves of unrelated wavelength beating against each other: two
/// slow ones fold and unfold the curtain as a whole, and a third, faster
/// one breaks up the resulting line with the small irregular wrinkles a
/// real curtain has along its base — without it the fold reads as one
/// smooth, symmetrical arc, which is closer to a diagram than a sky.
function curtainBase(spec, t, time, h) {
  return h * spec.base
    + Math.sin(t * 6.0 + time * 0.09 + spec.depth * 3.0) * h * spec.amp
    + Math.sin(t * 2.3 - time * 0.055) * h * spec.amp * 1.4
    + Math.sin(t * 17.0 + spec.depth * 7.0 + time * 0.14) * h * spec.amp * 0.32;
}

/// Drawn straight onto the scene canvas, at full resolution.
///
/// An intermediate low-resolution buffer was tried here and MEASURED
/// SLOWER: it cuts the fill cost of the rays by a ninth, but pays for it
/// with a full-frame upscaled blit, and on a CPU-rasterised canvas that
/// blit costs more than the rays did (6.8 ms/frame against 1.5 ms direct,
/// at 1920x1080). On a GPU-composited canvas the trade would likely go
/// the other way — but "likely" is not a reason to ship a five-fold
/// regression on the one machine that can be measured.
///
/// The cost is kept down instead by the things that are free to get
/// right: rays below the visibility threshold are skipped before the draw
/// call, the ray count is per-curtain rather than per-pixel, and every
/// sprite is baked.
/// `detail` (0..1, default 1) is the automatic-degrade knob: rather than
/// re-baking anything, a lower detail simply skips a stride of rays,
/// evenly spaced round the curtain (not a truncated range, which would
/// leave one side bare) so the curtain looks thinner rather than
/// lopsided. The dropped rays' contribution is folded back into the ones
/// that remain (alpha scaled by the stride) so the curtain doesn't also
/// go dim as it goes sparse.
function drawAurora(ctx, w, h, time, gain, detail = 1, palette = 'classic', customColors = null) {
  const stride = Math.max(1, Math.round(1 / Math.max(0.08, Math.min(1, detail))));
  const effectiveDetail = 1 / stride;
  const spread = Math.min(2, Math.sqrt(1 / effectiveDetail));
  // A real aurora curtain extends past the viewport on both sides, so we
  // render onto a slightly wider virtual band and let the soft edges wrap
  // instead of cutting hard at x=0 and x=w. This removes the black vertical
  // seam/streak artifacts that appeared when rays were clipped by the canvas.
  const overscan = Math.max(64, w * 0.12);
  const renderW = w + overscan * 2;
  for (const spec of getAurora(palette, customColors)) {
    // Slow horizontal drift, wrapped, so the whole curtain migrates the
    // way a real one does over minutes.
    const shift = ((time * spec.drift) % 1 + 1) % 1;

    // Air-glow first, in segments that overlap by half their width so the
    // soft-edged sprites cross-fade into one continuous sheet instead of
    // leaving visible rectangular seams.
    ctx.globalAlpha = spec.alpha * 0.45 * gain;
    const segs = 12;
    const segW = (renderW / segs) * 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs + spec.hazeOffsetX[i];
      const x = t * renderW - overscan;
      if (x + segW < 0 || x - segW > w) continue;
      const y = curtainBase(spec, t + shift, time, h) + spec.hazeOffsetY[i] * h * 0.05;
      const hh = h * 0.3;
      ctx.globalAlpha = spec.alpha * 0.45 * gain * spec.hazeAlphaJ[i];
      ctx.drawImage(spec.hazeSprite, x - segW / 2, y - hh, segW, hh);
    }
    ctx.globalAlpha = spec.alpha * 0.45 * gain;

    for (let i = 0; i < spec.rays; i += stride) {
      const raw = i / spec.rays;
      const warp = spec.warpAmp[0] * Math.sin(raw * spec.warpFreq[0] * Math.PI * 2 + spec.warpPhase[0])
                 + spec.warpAmp[1] * Math.sin(raw * spec.warpFreq[1] * Math.PI * 2 + spec.warpPhase[1]);
      const t = ((raw + warp + spec.offsets[i] + shift) % 1 + 1) % 1;
      const x = t * renderW - overscan;
      const base = curtainBase(spec, t, time, h);
      // Each ray breathes on its own rate, and a slow travelling wave runs
      // along the curtain so brightness sweeps through it rather than
      // every ray pulsing at once.
      const own = 0.5 + 0.5 * Math.sin(time * spec.rates[i] + spec.phases[i]);
      const travel = 0.5 + 0.5 * Math.sin(t * 11.0 - time * 0.55 + spec.depth);
      const energy = 0.25 + 0.75 * (own * 0.55 + travel * 0.45);
      const height = h * (0.10 + 0.22 * energy);
      const width = RAY_W * spec.widths[i] * (0.8 + 0.4 * energy) * spread;
      const alpha = spec.alpha * energy * gain * spread;
      if (alpha < 0.02) continue;
      if (x + width < 0 || x - width > w) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(spec.ray, x - width / 2, base - height, width, height);
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// star field
// ---------------------------------------------------------------------------

// Average area (in desktop px^2) given to one star. A cell this size is
// what the old per-window random field averaged out to; kept as a grid
// spacing below so the on-screen density is unchanged.
const STAR_CELL = 161;

/// A small, well-mixed integer hash of (cellX, cellY, stream). `stream`
/// separates the independent random values a star needs (position jitter,
/// existence, magnitude, phase, rate...) into different pseudo-random
/// sequences without needing a stateful generator — which matters here
/// because every window must derive the SAME value for the SAME cell,
/// with nothing carried between calls.
function hashCell(cx, cy, stream) {
  let h = (cx * 374761393 + cy * 668265263 + stream * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

let starField = null;
let starFieldKey = '';

/// Stars are derived from a fixed grid over the virtual desktop, keyed by
/// GLOBAL cell coordinates rather than anything local to one window. The
/// same cell hashes to the same star everywhere, so two overlay windows
/// sitting side by side render matching stars right up to the shared edge
/// — there is no independent per-monitor field to fall out of alignment.
///
/// `originX`/`originY` place this window's local (0,0) in that shared
/// space (the monitor's real desktop position, from Tauri's Monitor API);
/// a window with no such info (outside Tauri, or before it resolves) just
/// passes 0,0, which keeps the previous single-window behaviour exactly.
function getStars(w, h, originX = 0, originY = 0, density = 1) {
  const cellSize = STAR_CELL / Math.sqrt(Math.max(0.25, Math.min(2, density)));
  const key = `${w}x${h}x${originX}x${originY}x${cellSize}`;
  if (starField && starFieldKey === key) return starField;

  const skyH = h * 0.62;
  const cx0 = Math.floor(originX / cellSize) - 1;
  const cx1 = Math.floor((originX + w) / cellSize) + 1;
  const cy0 = Math.floor(originY / cellSize) - 1;
  const cy1 = Math.floor((originY + skyH) / cellSize) + 1;

  const stars = [];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      // Not every cell gets a star — a rigid one-per-cell grid would read
      // as a lattice rather than a sky. ~78% occupancy keeps the average
      // density right while breaking up the regularity.
      if (hashCell(cx, cy, 0) > 0.78) continue;
      const gx = cx * cellSize + hashCell(cx, cy, 1) * cellSize;
      const gy = cy * cellSize + hashCell(cx, cy, 2) * cellSize;
      if (gy < originY || gy > originY + skyH) continue;
      const x = gx - originX;
      const y = gy - originY;
      if (x < -20 || x > w + 20) continue;
      // Brightness follows a steep curve: a real sky is mostly faint stars
      // with a handful of bright ones, not a uniform spread.
      const mag = hashCell(cx, cy, 3) ** 2.4;
      stars.push({
        x,
        y,
        size: 3 + mag * 12,
        base: 0.18 + mag * 0.7,
        // Scintillation is fast and irregular, so two incommensurate rates.
        phase: hashCell(cx, cy, 4) * Math.PI * 2,
        rate: 0.7 + hashCell(cx, cy, 5) * 2.6,
        rate2: 3.1 + hashCell(cx, cy, 6) * 5.5,
        // A stable per-star draw, used to thin the field under automatic
        // degrade (drawSky's `starDetail`). Deriving it from the same
        // grid hash — rather than re-rolling anything — means a lower
        // detail level always drops the SAME subset of stars (whichever
        // dimmer stars this pushes below the cutoff), so the field
        // doesn't reshuffle as quality steps up and down.
        thin: hashCell(cx, cy, 7),
      });
    }
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
    drawAurora(ctx, w, h, time, gain, opts.auroraDetail ?? 1, opts.auroraPalette, opts.auroraCustomColors);
  }

  if (opts.stars) {
    const starDetail = opts.starDetail ?? 1;
    const starDensity = opts.starDensity ?? 1;
    for (const s of getStars(w, h, opts.originX ?? 0, opts.originY ?? 0, starDensity)) {
      if (s.thin > starDetail) continue;
      const twinkle =
        0.62 + 0.26 * Math.sin(time * s.rate + s.phase) + 0.12 * Math.sin(time * s.rate2);
      const alpha = s.base * twinkle * gain;
      if (alpha < 0.03) continue;
      const size = s.size * (0.85 + twinkle * 0.3);
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(starSprite, s.x - size / 2, s.y - size / 2, size, size);
    }

    // One shooting star at a time, on a 9s cycle at the default rate.
    const shootingStarFrequency = Math.max(0, opts.shootingStarFrequency ?? 1);
    const cycleLength = shootingStarFrequency ? 9 / shootingStarFrequency : Infinity;
    const cycle = time % cycleLength;
    if (shootingStarFrequency && cycle < 0.7) {
      const p = cycle / 0.7;
      const n = Math.floor(time / cycleLength);
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
  const density = Math.max(0, opts.density ?? 1);
  const key = `${w}x${h}x${density}`;
  if (!glitterPoints || glitterKey !== key) {
    const rand = mulberry32(77345);
    const count = Math.round((w / 14) * density);
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

/// Exposed for tests only: the per-ray off-grid jitter for one curtain of
/// a palette, so a test can assert on the actual fix (rays not landing on
/// an even i/rays grid) rather than inferring it from noisy pixel data.
export function _testAuroraRayOffsets(paletteName = 'classic', curtainIndex = 0, customColors = null) {
  return Array.from(getAurora(paletteName, customColors)[curtainIndex].offsets);
}

/// Invalidate the aurora cache. Called when custom aurora colours change.
export function invalidateAurora() {
  auroraCurtains.clear();
}
