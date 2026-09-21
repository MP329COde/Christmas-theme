// NorthernLights — the aurora rideau-de-rayons ported to the WebGL2
// engine, so it can run through the existing bloom pipeline instead of
// being flat additive colour.
//
// This reuses the exact composition already proven in Canvas 2D
// (src/overlay/lights.js: getAurora/curtainBase/drawAurora) — three
// curtains at different depths, each an undulating base line with
// independent rays that shimmer and a slow travelling brightness wave —
// but pushes every bit of the animation into the shaders, so the CPU's
// only per-frame cost is a handful of uniform writes and ONE instanced
// draw call, same as the tree.
//
// WHY ONE DRAW CALL COVERS BOTH THE HAZE AND EVERY RAY, IN EVERY CURTAIN:
// each instance carries its own curtain parameters (base height, drift,
// colour, depth) rather than reading them from a uniform indexed by a
// per-instance ID, so nothing here depends on which curtain — or how
// many rays — were baked. The geometry itself is generated once, in
// NORMALISED curtain-fraction space; the vertex shader maps it to actual
// pixels from `uResolution` every frame, so a window resize needs no
// rebuild at all (contrast the tree, which regenerates its skeleton on
// resize because its geometry is in absolute pixels).
//
// AUTOMATIC DEGRADE (src/shared/perf.js) is a DRAW COUNT, not a shader
// branch or a rebuild: rays are uploaded once, ordered by a van der
// Corput sequence merged fairly across the three curtains (see
// `_buildInstances`), so `quads.draw(hazeCount + round(rayCount *
// detail))` is always an EVENLY thinned sky at any detail level — never
// a lopsided arc with one side of the curtain missing rays and the other
// side untouched.

import { Layer } from '../engine/layer.js';
import { createProgram, Blend } from '../engine/gl.js';
import { InstancedQuads, InstanceWriter } from '../engine/instanced.js';
import { resolveAuroraPalette } from '../shared/scene.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Van der Corput, base 2: maps an integer index to a value in [0,1) such
/// that consecutive indices land far apart and any prefix of indices
/// 0..N-1, reordered by this value, is evenly spread across [0,1). That
/// is exactly "thin the curtain evenly" for whatever prefix length the
/// current quality tier ends up drawing.
function vanDerCorput(n) {
  let v = 0;
  let denom = 1;
  while (n > 0) {
    denom *= 2;
    v += (n % 2) / denom;
    n = Math.floor(n / 2);
  }
  return v;
}

// Same three curtains, same numbers, as src/overlay/lights.js's
// getAurora() — the Canvas 2D fallback and this layer are meant to look
// like the same aurora, not two different ones depending on the GPU.
const CURTAIN_SHAPES = [
  { depth: 0.35, rays: 120, drift: 0.010, base: 0.15, amp: 0.045, alpha: 0.27 },
  { depth: 0.65, rays: 90, drift: -0.017, base: 0.11, amp: 0.06, alpha: 0.17 },
  { depth: 1.0, rays: 60, drift: 0.026, base: 0.19, amp: 0.04, alpha: 0.12 },
];

function hexToRgb(hex) {
  const value = hex.slice(1);
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function curtainsForPalette(paletteName, customColors = null) {
  const palette = resolveAuroraPalette(paletteName, customColors);
  return CURTAIN_SHAPES.map((shape, index) => ({
    ...shape, color: hexToRgb(palette.colors[index]), haze: hexToRgb(palette.haze[index]),
  }));
}
// i in 0..HAZE_SEGMENTS inclusive: 13 overlapping segments per curtain,
// matching the Canvas 2D bake's `segs = 12` loop exactly.
const HAZE_SEGMENTS = 12;
const INSTANCE_STRIDE = 16; // 4 vec4 attributes below

const VS = /* glsl */ `#version 300 es
precision highp float;
in vec2 aCorner;  // shared unit quad corner, from InstancedQuads
in vec4 aBase;    // t (curtain-fraction position), baseFrac, ampFrac, drift
in vec4 aShape;   // widthJitter, depth, isRay (1) / isHaze (0), unused
in vec4 aPhase;   // shimmer phase, shimmer rate, horizontal off-grid jitter, unused
in vec4 aColorA;  // r, g, b, base alpha
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uCamOffset; // camera parallax at depth = 1; scaled by aShape.y below
uniform float uGain;
uniform float uDetail;
out vec3 vColor;
out float vAlpha;
out float vVertT;  // 0 at the curtain's bright lower edge, 1 at its dim top
out float vHorizT; // -1..1 across the quad's width, for soft side edges

void main() {
  float depth = aShape.y;
  float isRay = aShape.z;

  // Slow horizontal drift, wrapped — the whole curtain migrates sideways
  // over minutes, same as the Canvas 2D version. aPhase.z is the ray's
  // fixed off-grid jitter (0 for haze), which keeps rays from landing on
  // an even i/rays grid — see the module header.
  float shift = fract(uTime * aBase.w);
  float t = fract(aBase.x + aPhase.z + shift);

  // Three waves of unrelated wavelength beating against each other: two
  // slow ones fold and unfold the curtain as a whole, and a third, faster
  // one breaks the base line up with small irregular wrinkles — matches
  // the Canvas 2D curtainBase() in overlay/lights.js exactly, so the two
  // renderers resolve the same shape.
  float wave = sin(t * 6.0 + uTime * 0.09 + depth * 3.0) * aBase.z
             + sin(t * 2.3 - uTime * 0.055) * aBase.z * 1.4
             + sin(t * 17.0 + depth * 7.0 + uTime * 0.14) * aBase.z * 0.32;
  float distFromTop = uResolution.y * (aBase.y + wave);

  // Each ray breathes on its own rate, and a slow travelling wave runs
  // along the curtain so brightness sweeps through it rather than every
  // ray pulsing in lockstep. Haze ignores this (isRay selects it out) so
  // the background sheet doesn't pulse as hard as the rays sitting on it.
  float own = 0.5 + 0.5 * sin(uTime * aPhase.y + aPhase.x);
  float travel = 0.5 + 0.5 * sin(t * 11.0 - uTime * 0.55 + depth);
  float energy = 0.25 + 0.75 * (own * 0.55 + travel * 0.45);
  float detail = max(0.08, min(1.0, uDetail));
  float spread = min(2.0, sqrt(1.0 / detail));

  float heightPx = mix(uResolution.y * 0.30, uResolution.y * (0.10 + 0.22 * energy), isRay);
  float halfWidthPx = mix(
    uResolution.x / float(${HAZE_SEGMENTS}), // haze: same overlap as the Canvas 2D segW/2
    8.0 * aShape.x * (0.8 + 0.4 * energy) * spread, // ray: widened under lower detail
    isRay
  );

  // Render onto a virtual band 24% wider than the screen so the curtain
  // can extend past the viewport on both sides. This matches the Canvas 2D
  // overscan and prevents hard vertical cutoffs at the left/right edges.
  float overscan = uResolution.x * 0.12;
  float renderW = uResolution.x + overscan * 2.0;
  float centerX = t * renderW - overscan;
  float baseYFromBottom = uResolution.y - distFromTop;

  float vt = aCorner.y * 0.5 + 0.5; // 0 at the bottom (bright), 1 at top (dim)
  vec2 pos = vec2(centerX + aCorner.x * halfWidthPx, baseYFromBottom + vt * heightPx);
  pos += uCamOffset * depth;

  vColor = aColorA.rgb;
  vAlpha = aColorA.a * uGain * mix(0.45, energy * spread, isRay);
  vVertT = vt;
  vHorizT = aCorner.x;

  vec2 ndc = pos / uResolution * 2.0 - 1.0;
  // Fixed, always-far depth: this is ambient sky glow behind everything
  // else in the scene, drawn additively, so it needs no depth WRITE
  // (disabled by the layer around this draw) and only ever needs to sit
  // behind whatever the depth-tested layers put in front of it.
  gl_Position = vec4(ndc, 0.999, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
in float vVertT;
in float vHorizT;
out vec4 outColor;
void main() {
  float vertical = pow(1.0 - clamp(vVertT, 0.0, 1.0), 1.6);
  // Plateau width matches the Canvas 2D haze sprite's side gradient
  // (0.4..0.6 of full width, i.e. |x| < 0.2 in this -1..1 space) — a wider
  // flat core here made neighbouring, 50%-overlapping haze segments stack
  // their full-opacity regions on top of each other under additive
  // blending, which read as periodic vertical bands instead of one
  // continuous sheet.
  float horiz = 1.0 - smoothstep(0.2, 1.0, abs(vHorizT));
  float a = clamp(vAlpha * vertical * horiz, 0.0, 1.0);
  // Premultiplied, to match every other layer's blend convention.
  outColor = vec4(vColor * a, a);
}`;

export class NorthernLights extends Layer {
  constructor(options = {}) {
    super(options.id ?? 'northern-lights', { z: options.z ?? 0.02, enabled: options.enabled ?? true });
    this.opts = { gain: 1, seed: 80211, palette: 'classic', ...options };
    // The automatic quality governor's lever (0..1): see the module
    // header for why this is a draw COUNT, not a rebuild.
    this.detail = 1;
    this.hazeInstanceCount = 0;
    this.rayInstanceCount = 0;
  }

  async init(renderer) {
    const gl = renderer.gl;
    this.gl = gl;
    this.program = createProgram(gl, VS, FS, 'aurora');
    this.quads = new InstancedQuads(gl, this.program.program, [
      { name: 'aBase', size: 4 },
      { name: 'aShape', size: 4 },
      { name: 'aPhase', size: 4 },
      { name: 'aColorA', size: 4 },
    ]);
    this._buildInstances();
    this.ready = true;
  }

  /// Generates every haze segment and ray ONCE, in curtain-fraction space
  /// (not pixels — see the module header). Never called again unless the
  /// layer is disposed and rebuilt, since nothing about this geometry
  /// depends on window size.
  _buildInstances() {
    const rand = mulberry32(this.opts.seed);
    const writer = new InstanceWriter(INSTANCE_STRIDE, 320);
    const curtains = curtainsForPalette(this.opts.palette, this.opts.customColors);

    // Haze always comes first and is always drawn in full, whatever the
    // quality tier — it is what keeps the sky reading as a sheet of light
    // rather than going flat black at the lowest tier.
    let hazeCount = 0;
    for (const c of curtains) {
      const [hr, hg, hb] = c.haze.map((v) => v / 255);
      for (let i = 0; i <= HAZE_SEGMENTS; i++) {
        const t = i / HAZE_SEGMENTS;
        // Same off-grid jitter the rays get below (see the module header
        // and Canvas 2D's matching hazeOffsetX/Y/Alpha): identical sprites
        // sitting on a perfectly even grid sum, under additive blending,
        // into a periodic ripple across the curtain. aPhase.z reuses the
        // vertex shader's existing ray-jitter path; the baseFrac nudge and
        // alpha scale do the same for vertical position and strength.
        const jitterT = (rand() - 0.5) * 0.7 / HAZE_SEGMENTS;
        const jitterBase = c.base * (1 + (rand() - 0.5) * 0.16);
        const jitterAlpha = c.alpha * (0.75 + rand() * 0.5);
        writer.push(
          t, jitterBase, c.amp, c.drift,
          0, c.depth, 0, 0,
          0, 0, jitterT, 0,
          hr, hg, hb, jitterAlpha
        );
        hazeCount++;
      }
    }
    this.hazeInstanceCount = hazeCount;

    // Rays: each curtain's own rays are reordered by a van der Corput
    // sequence (see the function above) so ANY prefix of them, taken in
    // this order, is evenly spread along that curtain rather than a
    // contiguous arc. The three curtains' reordered sequences are then
    // merged by fractional position (0.5, 1.5, 2.5.../length) so a global
    // prefix — the thing automatic degrade actually truncates to — keeps
    // all three depths represented in their original proportion.
    const perCurtain = curtains.map((c) => {
      const [r, g, b] = c.color.map((v) => v / 255);
      const phases = new Float32Array(c.rays);
      const rates = new Float32Array(c.rays);
      const widths = new Float32Array(c.rays);
      // Same off-grid jitter as the Canvas 2D fallback (src/overlay/lights.js),
      // PLUS a low-frequency warp of the whole 0..1 layout (two unrelated
      // sine waves) baked straight into the offset: a per-ray jitter alone
      // still averages out to an even comb, since every ray keeps roughly
      // its own slot — the warp is what actually bunches stretches of the
      // curtain into wisps and thins out others, killing the "comb of
      // parallel bars" look for good.
      const offsets = new Float32Array(c.rays);
      const warpAmp = [0.05 + rand() * 0.05, 0.025 + rand() * 0.03];
      const warpFreq = [1 + Math.floor(rand() * 2), 3 + Math.floor(rand() * 3)];
      const warpPhase = [rand() * Math.PI * 2, rand() * Math.PI * 2];
      for (let i = 0; i < c.rays; i++) {
        phases[i] = rand() * Math.PI * 2;
        rates[i] = 0.35 + rand() * 1.25;
        widths[i] = 0.7 + rand() * 1.5;
        const raw = i / c.rays;
        const warp = warpAmp[0] * Math.sin(raw * warpFreq[0] * Math.PI * 2 + warpPhase[0])
                   + warpAmp[1] * Math.sin(raw * warpFreq[1] * Math.PI * 2 + warpPhase[1]);
        offsets[i] = warp + (rand() - 0.5) * 1.6 / c.rays;
      }
      const order = [...Array(c.rays).keys()].sort(
        (a, b2) => vanDerCorput(a) - vanDerCorput(b2)
      );
      return { c, r, g, b, phases, rates, widths, offsets, order };
    });

    const merged = [];
    for (const pc of perCurtain) {
      pc.order.forEach((rayIdx, pos) => {
        merged.push({ pc, rayIdx, priority: (pos + 0.5) / pc.order.length });
      });
    }
    merged.sort((a, b) => a.priority - b.priority);

    let rayCount = 0;
    for (const { pc, rayIdx } of merged) {
      const { c } = pc;
      const t = rayIdx / c.rays;
      writer.push(
        t, c.base, c.amp, c.drift,
        pc.widths[rayIdx], c.depth, 1, 0,
        pc.phases[rayIdx], pc.rates[rayIdx], pc.offsets[rayIdx], 0,
        pc.r, pc.g, pc.b, c.alpha
      );
      rayCount++;
    }
    this.rayInstanceCount = rayCount;

    this.quads.upload(writer.data, writer.count, this.gl.STATIC_DRAW);
  }

  /// Called by the automatic quality governor (never directly by a user
  /// setting): how much of the ray budget to actually draw this frame,
  /// 0..1. No allocation, no GPU upload — just a smaller instanced draw
  /// count next `render()`.
  setDetail(fraction) {
    this.detail = Math.max(0, Math.min(1, Number(fraction) || 0));
  }

  /// Exposed for the same "did it actually produce geometry" check
  /// gl-trees.js already runs on every layer before adopting the engine.
  get instanceCount() {
    return this.hazeInstanceCount + Math.round(this.rayInstanceCount * this.detail);
  }

  render(ctx) {
    const gl = ctx.gl;
    const u = this.program.uniforms;
    gl.useProgram(this.program.program);
    gl.uniform2f(u.uResolution, ctx.width, ctx.height);
    gl.uniform1f(u.uTime, ctx.time);
    gl.uniform1f(u.uGain, this.opts.gain ?? 1);
    gl.uniform1f(u.uDetail, this.detail);
    const off = ctx.camera.offsetFor(this.z);
    gl.uniform2f(u.uCamOffset, off.x * ctx.dpr, off.y * ctx.dpr);

    // Ambient sky glow: additive, and never occludes anything drawn after
    // it (no depth write) — depth TEST stays on so nothing pathological
    // happens if a future layer ever sorts behind it, but there is
    // nothing for it to actually be occluded by at z = 0.02.
    gl.depthMask(false);
    Blend.add(gl);
    this.quads.draw(this.instanceCount);
    gl.depthMask(true);
    Blend.over(gl);

    ctx.draws += 1;
  }

  dispose() {
    this.quads?.dispose();
    if (this.program && this.gl) this.gl.deleteProgram(this.program.program);
  }
}
