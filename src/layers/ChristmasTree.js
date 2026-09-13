// ChristmasTree — the reference implementation for every later layer.
//
// WHAT MAKES IT READ AS A TREE RATHER THAN A DRAWING OF ONE
//
// 1. It has actual volume. The skeleton is generated in three dimensions:
//    each tier puts its branches around a full 360 degrees, so branches
//    come toward the viewer, occlude the ones behind them through the
//    depth buffer, and shrink with perspective. The previous renderer laid
//    every bough in one plane at z = 0 — a flat cone cannot look like a
//    conifer no matter how carefully it is shaded.
//
// 2. It is textured, not stroked. The canopy is built from procedurally
//    generated sprig sprites, each carrying a dozen needles with their own
//    shading. Line segments have no surface detail at all, which is the
//    main thing that produces a "vector illustration" look.
//
// 3. It is lit, not shaded by hand. Needles read the shared light rig, so
//    the fireplace warms the side of the tree facing it and every bulb
//    genuinely brightens the needles around it. Foliage uses wrapped
//    diffuse plus a translucency term, because needles scatter light
//    through themselves rather than blocking it.
//
// 4. It moves, continuously and out of step. Wind is applied in the vertex
//    shader from a noise field, with amplitude scaled by distance along
//    the branch, so tips travel and the trunk does not. Every bulb runs
//    its own flicker from its own incommensurate rates — nothing in this
//    layer pulses in unison with anything else.
//
// COST: the whole canopy is ONE instanced draw call, the snow a second,
// the baubles a third and the bulbs a fourth. Per frame the CPU uploads
// only the bulbs (a hundred floats); everything else is static GPU data.

import { Layer } from '../engine/layer.js';
import { createProgram, textureFromCanvas, Blend } from '../engine/gl.js';
import { InstancedQuads, InstanceWriter } from '../engine/instanced.js';
import { LIGHTING_GLSL, hexToRgb } from '../engine/lighting.js';
import { bulbLevel } from '../shared/scene.js';
import { SIMPLEX3, HASH, COLOR } from '../engine/noise.glsl.js';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = 2.39996323; // radians; consecutive tiers never line up

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// procedural texture atlas
// ---------------------------------------------------------------------------

const ATLAS_CELL = 256;
const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;

/// Draws one sprig: a stem with needle pairs along it. Needles get their
/// own length, angle and brightness, and a dark core with a lighter edge,
/// so the sprite has real internal contrast at every zoom level instead of
/// being a flat silhouette.
function drawSprig(c, size, rand, { snowy = false } = {}) {
  const cx = size / 2;
  const baseY = size * 0.96;
  const tipY = size * 0.06;
  const len = baseY - tipY;
  const curve = (rand() - 0.5) * size * 0.16;

  // Stem.
  c.strokeStyle = 'rgba(48,42,26,0.9)';
  c.lineWidth = size * 0.018;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(cx, baseY);
  c.quadraticCurveTo(cx + curve, baseY - len * 0.5, cx + curve * 0.6, tipY);
  c.stroke();

  const pairs = 9 + Math.floor(rand() * 4);
  for (let i = 0; i <= pairs; i++) {
    const t = i / pairs;
    // Point on the stem's quadratic.
    const sx = (1 - t) * (1 - t) * cx + 2 * (1 - t) * t * (cx + curve) + t * t * (cx + curve * 0.6);
    const sy = (1 - t) * (1 - t) * baseY + 2 * (1 - t) * t * (baseY - len * 0.5) + t * t * tipY;
    // Needles are longest at the base of the sprig and shorten toward the
    // tip, which is what gives the sprig its taper.
    const nlen = size * (0.30 - t * 0.17) * (0.75 + rand() * 0.5);
    for (const side of [-1, 1]) {
      const spread = 0.62 + rand() * 0.5 - t * 0.18;
      const ax = side * Math.sin(spread);
      const ay = -Math.cos(spread);
      const ex = sx + ax * nlen;
      const ey = sy + ay * nlen;

      // Dark core.
      const shade = 0.35 + rand() * 0.45 + t * 0.2;
      c.strokeStyle = `rgba(${Math.round(40 + shade * 60)},${Math.round(70 + shade * 105)},${Math.round(38 + shade * 55)},0.95)`;
      c.lineWidth = size * (0.028 - t * 0.008);
      c.beginPath();
      c.moveTo(sx, sy);
      c.lineTo(ex, ey);
      c.stroke();

      // Specular edge along one flank: a needle is a waxy cylinder and
      // catches a line of light, not a uniform tone.
      if (rand() > 0.45) {
        c.strokeStyle = `rgba(${Math.round(150 + rand() * 70)},${Math.round(200 + rand() * 55)},${Math.round(140 + rand() * 60)},0.5)`;
        c.lineWidth = size * 0.009;
        c.beginPath();
        c.moveTo(sx + ax * nlen * 0.25, sy + ay * nlen * 0.25);
        c.lineTo(ex - ax * nlen * 0.08, ey - ay * nlen * 0.08);
        c.stroke();
      }

      if (snowy && ay < -0.2 && rand() > 0.35) {
        // Snow only settles on the upward-facing side.
        c.strokeStyle = `rgba(236,244,255,${0.55 + rand() * 0.4})`;
        c.lineWidth = size * (0.030 - t * 0.008);
        c.beginPath();
        c.moveTo(sx + ax * nlen * 0.3, sy + ay * nlen * 0.3 - size * 0.008);
        c.lineTo(ex, ey - size * 0.01);
        c.stroke();
      }
    }
  }
}

/// Bark: vertical fibre with knots. One cell, used for the trunk.
function drawBark(c, size, rand) {
  c.fillStyle = '#3a2415';
  c.fillRect(size * 0.22, 0, size * 0.56, size);
  for (let i = 0; i < 90; i++) {
    const x = size * 0.22 + rand() * size * 0.56;
    const y = rand() * size;
    const h = size * (0.05 + rand() * 0.3);
    c.strokeStyle = `rgba(${20 + rand() * 90},${12 + rand() * 60},${6 + rand() * 34},${0.25 + rand() * 0.5})`;
    c.lineWidth = size * (0.006 + rand() * 0.016);
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + (rand() - 0.5) * size * 0.04, y + h * 0.5, x + (rand() - 0.5) * size * 0.05, y + h);
    c.stroke();
  }
}

function buildAtlas(seed) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_CELL * ATLAS_COLS;
  canvas.height = ATLAS_CELL * ATLAS_ROWS;
  const c = canvas.getContext('2d');
  const rand = mulberry32(seed);

  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    c.save();
    c.translate(col * ATLAS_CELL, row * ATLAS_CELL);
    c.beginPath();
    c.rect(0, 0, ATLAS_CELL, ATLAS_CELL);
    c.clip();
    if (i < 5) drawSprig(c, ATLAS_CELL, rand);
    else if (i < 7) drawSprig(c, ATLAS_CELL, rand, { snowy: true });
    else drawBark(c, ATLAS_CELL, rand);
    c.restore();
  }
  return canvas;
}

/// Radial falloff with a hot core, used for bulbs and the star. Baked once
/// rather than evaluated per fragment, and reused by every light sprite.
function buildGlow(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const r = size / 2;
  const g = c.createRadialGradient(r, r, 0, r, r, r);
  // A tight core with a long faint skirt. The earlier, wider falloff made
  // every bulb read as a soft orb the same size as a bauble; a real string
  // light is a small hot point whose halo is much dimmer than its centre.
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.05, 'rgba(255,255,255,0.88)');
  g.addColorStop(0.13, 'rgba(255,255,255,0.30)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.07)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.02)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return canvas;
}

/// The topper. A glow sprite alone reads as a smudge of fog, not a star —
/// what the eye recognises is the anisotropic flare: four long spikes,
/// four short ones, and a small overexposed core.
function buildStar(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const r = size / 2;
  c.globalCompositeOperation = 'lighter';

  const halo = c.createRadialGradient(r, r, 0, r, r, r * 0.5);
  halo.addColorStop(0, 'rgba(255,255,255,0.9)');
  halo.addColorStop(0.25, 'rgba(255,255,255,0.28)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = halo;
  c.fillRect(0, 0, size, size);

  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0 ? 1 : 0.42;
    const angle = (Math.PI / 4) * i + Math.PI / 4;
    c.save();
    c.translate(r, r);
    c.rotate(angle);
    const g = c.createLinearGradient(0, 0, r * long, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.12, `rgba(255,250,230,${0.5 * long})`);
    g.addColorStop(1, 'rgba(255,240,200,0)');
    c.fillStyle = g;
    // A spike is a needle-thin triangle: wide at the core, vanishing at
    // the tip.
    c.beginPath();
    c.moveTo(0, -size * 0.016 * long);
    c.lineTo(r * long, 0);
    c.lineTo(0, size * 0.016 * long);
    c.closePath();
    c.fill();
    c.restore();
  }

  const core = c.createRadialGradient(r, r, 0, r, r, r * 0.09);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = core;
  c.fillRect(0, 0, size, size);
  return canvas;
}

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------

/// Shared projection. The tree lives in scene pixels with y up; this is a
/// weak perspective divide about the tree's own centre, which is all a
/// 2.5D scene needs and keeps every layer's maths identical.
const PROJECT_GLSL = /* glsl */ `
uniform vec2  uResolution;
uniform vec2  uOrigin;   // tree base, scene pixels, y up from the bottom
uniform float uFocal;    // perspective strength, scene pixels
uniform float uZRange;   // half-depth of the object, for the depth buffer

float perspective(float z) { return uFocal / max(uFocal - z, 1.0); }

uniform float uFlip;  // -1 mirrors the tree about its own trunk

vec4 project(vec3 p, out float persp) {
  persp = perspective(p.z);
  vec2 screen = uOrigin + vec2(p.x * uFlip, p.y) * persp;
  // Nearer (larger z) must come out with a smaller depth value.
  float depth = clamp(-p.z / uZRange, -0.98, 0.98);
  return vec4(screen / uResolution * 2.0 - 1.0, depth, 1.0);
}
`;

const FOLIAGE_VS = /* glsl */ `#version 300 es
precision highp float;
${SIMPLEX3}
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;    // position in tree space (pixels, y up, z toward viewer)
in vec3 aNrm;    // outward normal of the sprig
in vec4 aParam;  // size, windPhase, windAmount, billboardRotation
in vec2 aCell;   // atlas cell
uniform float uTime;
uniform float uWind;
uniform vec2  uAtlasCells;
out vec2 vUV;
out vec3 vNrm;
out vec3 vWorld;
out float vZ;
out float vSeed;

void main() {
  vec3 p = aPos;

  // Wind: a slow noise field sampled at the sprig's position, so nearby
  // sprigs move together (they are on the same branch, in the same gust)
  // while distant ones do not — which is the difference between a tree
  // breathing and every leaf jittering independently.
  float field = snoise(vec3(p.xy * 0.0022, uTime * 0.19));
  float gust  = 0.65 + 0.35 * sin(uTime * 0.23 + field * 2.0);
  float sway  = field * 0.7
              + 0.35 * sin(uTime * 1.10 + aParam.y)
              + 0.18 * sin(uTime * 2.37 + aParam.y * 1.7);
  float amp = aParam.z * uWind * gust;
  p.x += sway * 9.0 * amp;
  p.z += sway * 5.0 * amp;
  // A branch pushed sideways also dips: it is pivoting, not sliding.
  p.y -= abs(sway) * 3.2 * amp;

  float persp;
  vec4 clip = project(p, persp);

  float s = aParam.x * persp;
  float ca = cos(aParam.w), sa = sin(aParam.w);
  vec2 corner = vec2(aCorner.x * ca - aCorner.y * sa, aCorner.x * sa + aCorner.y * ca);
  clip.xy += corner * s / uResolution * 2.0;

  vUV = (aCell + (aCorner * 0.5 + 0.5)) / uAtlasCells;
  vNrm = aNrm;
  vWorld = vec3(uOrigin + p.xy, p.z);
  vZ = p.z;
  vSeed = float(gl_InstanceID);
  gl_Position = clip;
}`;

const FOLIAGE_FS = /* glsl */ `#version 300 es
precision highp float;
${COLOR}
${HASH}
${LIGHTING_GLSL}
in vec2 vUV;
in vec3 vNrm;
in vec3 vWorld;
in float vZ;
in float vSeed;
uniform sampler2D uAtlas;
uniform vec3 uDarkGreen;
uniform vec3 uLightGreen;
uniform float uRadius;
out vec4 outColor;

void main() {
  vec4 tex = texture(uAtlas, vUV);
  // Alpha test rather than sorted blending: foliage is thousands of
  // overlapping sprites, and sorting them every frame would cost more than
  // the whole canopy is worth. The depth buffer gives correct occlusion
  // for free at the price of a crisp edge, which needles have anyway.
  if (tex.a < 0.36) discard;
  vec3 albedoTex = tex.rgb / max(tex.a, 1e-3);

  // Per-sprig hue and value variation. A canopy of one green is the
  // single most artificial-looking thing a CG tree can do.
  vec3 h = hash31(vSeed * 7.13 + 1.7);
  vec3 base = mix(uDarkGreen, uLightGreen, h.x * 0.85 + 0.15);
  base *= 0.7 + h.y * 0.55;
  vec3 albedo = toLinear(base) * albedoTex;

  vec3 n = normalize(vNrm);
  vec3 viewDir = vec3(0.0, 0.0, 1.0);

  // Ambient occlusion inside the canopy: sprigs deep behind the silhouette
  // receive far less sky, which is what gives the tree its interior
  // darkness and therefore its sense of depth.
  float ao = mix(0.28, 1.0, smoothstep(-uRadius, uRadius * 0.75, vZ));

  vec3 lit = ambientTerm(n) * ao + lightTerm(vWorld, n, viewDir, 0.85) * mix(0.55, 1.0, ao);
  vec3 color = albedo * lit;

  outColor = vec4(color * tex.a, tex.a);
}`;

const ORNAMENT_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;
in vec3 aColor;
in vec2 aParam; // radius, kind (0 = glossy ball, 1 = matte)
out vec2 vQ;
out vec3 vColor;
out vec3 vWorld;
out float vKind;
void main() {
  float persp;
  vec4 clip = project(aPos, persp);
  clip.xy += aCorner * (aParam.x * persp) / uResolution * 2.0;
  vQ = aCorner;
  vColor = aColor;
  vWorld = vec3(uOrigin + aPos.xy, aPos.z);
  vKind = aParam.y;
  gl_Position = clip;
}`;

const ORNAMENT_FS = /* glsl */ `#version 300 es
precision highp float;
${COLOR}
${LIGHTING_GLSL}
in vec2 vQ;
in vec3 vColor;
in vec3 vWorld;
in float vKind;
out vec4 outColor;

void main() {
  // Sphere impostor: the quad is shaded as if it were a ball, which gives
  // a correct normal at every pixel and therefore a real moving highlight
  // instead of a painted-on white dot.
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  vec3 n = vec3(vQ, sqrt(max(1.0 - r2, 0.0)));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 albedo = toLinear(vColor);

  vec3 lit = ambientTerm(n) * 0.8 + lightTerm(vWorld, n, viewDir, 0.0);
  vec3 color = albedo * lit;
  // Glass is smooth and takes a tight highlight; a matte finish takes a
  // broad soft one. Both come from the same rig, so a bauble reflects
  // whichever bulb happens to be bright this instant.
  float shininess = mix(64.0, 9.0, vKind);
  float strength = mix(1.5, 0.25, vKind);
  color += specularTerm(vWorld, n, viewDir, shininess, strength);
  // Fresnel rim: grazing angles reflect more, which is what makes the
  // silhouette of a glass ball brighter than its middle.
  color += toLinear(vColor) * pow(1.0 - n.z, 4.0) * 0.6;

  float edge = smoothstep(1.0, 0.93, r2);
  outColor = vec4(color * edge, edge);
}`;

const BULB_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;
in vec3 aColor;
in vec2 aParam; // size, brightness
out vec2 vUV;
out vec3 vColor;
out float vBright;
void main() {
  float persp;
  vec4 clip = project(aPos, persp);
  // A brighter bulb blooms physically larger, which is how an eye reads
  // intensity on a small light source.
  float s = aParam.x * persp * (0.7 + 0.5 * aParam.y);
  clip.xy += aCorner * s / uResolution * 2.0;
  // Depth bias toward the viewer. A bulb clipped to the branch it is
  // wired to sits level with the sprigs around it, so half the string
  // lost the depth test and only the ones on the silhouette survived.
  // Biasing it a little nearer is the same decal trick a renderer uses
  // for anything attached to a surface — it still loses to branches
  // clearly in front of it, which is what keeps the far side hidden.
  clip.z -= 0.06;
  vUV = aCorner * 0.5 + 0.5;
  vColor = aColor;
  vBright = aParam.y;
  gl_Position = clip;
}`;

const BULB_FS = /* glsl */ `#version 300 es
precision highp float;
${COLOR}
in vec2 vUV;
in vec3 vColor;
in float vBright;
uniform sampler2D uGlow;
out vec4 outColor;
void main() {
  float g = texture(uGlow, vUV).a;
  // Only the very centre is allowed to desaturate toward white. Letting
  // the whole sprite blow out is what turns a warm bulb into a featureless
  // white blob — the colour has to survive everywhere except the core.
  vec3 tint = mix(toLinear(vColor), vec3(1.0), smoothstep(0.86, 1.0, g) * vBright);
  vec3 c = tint * g * vBright * 3.1;
  outColor = vec4(c, g * vBright * 0.4);
}`;

const SHADOW_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;
in vec2 aParam; // radiusX, radiusY
out vec2 vQ;
void main() {
  float persp;
  vec4 clip = project(aPos, persp);
  clip.xy += aCorner * aParam * persp / uResolution * 2.0;
  vQ = aCorner;
  gl_Position = clip;
}`;

const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vQ;
uniform float uOpacity;
out vec4 outColor;
void main() {
  float d = length(vQ);
  float a = (1.0 - smoothstep(0.0, 1.0, d)) * uOpacity;
  // Premultiplied black: this darkens whatever is behind the window,
  // which for a transparent overlay means it darkens the desktop. A
  // contact shadow is what stops an object from appearing to float.
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

// ---------------------------------------------------------------------------
// layer
// ---------------------------------------------------------------------------

export class ChristmasTree extends Layer {
  constructor(options = {}) {
    super('ChristmasTree', { z: options.z ?? 0.55, enabled: options.enabled ?? true });
    this.opts = {
      seed: 1337,
      heightFraction: 0.66, // of the frame height
      anchor: [0.5, 0.0], // fraction of frame; y measured from the bottom
      needleDark: '#0c2013',
      needleLight: '#3c6b2b',
      bulbColors: ['#ffc169', '#ffa93f', '#ffd79b'],
      ornamentColors: ['#c0392b', '#e8c25a', '#e9edf2', '#8fb7d8', '#b0392b'],
      bulbCount: 96,
      ornamentCount: 38,
      wind: 1.0,
      lightIntensity: 1.0,
      // Scene-driven knobs, so one layer class covers every tree a
      // composition can ask for rather than one hard-coded tree.
      styleWidth: 1.0,    // spruce is narrow, pine is broad
      styleDensity: 1.0,  // branches per tier
      snowAmount: 1.0,
      star: true,
      lightsOn: true,
      lightMode: 'twinkle',
      lightSpeed: 1,
      bulbSize: 1,
      flip: false,
      ...options,
    };
    this.bulbs = [];
    this.bulbData = null;
  }

  async init(renderer) {
    const gl = renderer.gl;
    this.gl = gl;
    this.renderer = renderer;

    this.atlasTex = textureFromCanvas(gl, buildAtlas(this.opts.seed));
    this.glowTex = textureFromCanvas(gl, buildGlow(), { mips: false });
    this.starTex = textureFromCanvas(gl, buildStar(), { mips: false });

    this.foliage = createProgram(gl, FOLIAGE_VS, FOLIAGE_FS, 'tree.foliage');
    this.ornaments = createProgram(gl, ORNAMENT_VS, ORNAMENT_FS, 'tree.ornaments');
    this.bulbProg = createProgram(gl, BULB_VS, BULB_FS, 'tree.bulbs');
    this.shadowProg = createProgram(gl, SHADOW_VS, SHADOW_FS, 'tree.shadow');

    const foliageAttribs = [
      { name: 'aPos', size: 3 },
      { name: 'aNrm', size: 3 },
      { name: 'aParam', size: 4 },
      { name: 'aCell', size: 2 },
    ];
    this.needleBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.snowBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.trunkBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.ornamentBatch = new InstancedQuads(gl, this.ornaments.program, [
      { name: 'aPos', size: 3 },
      { name: 'aColor', size: 3 },
      { name: 'aParam', size: 2 },
    ]);
    this.bulbBatch = new InstancedQuads(gl, this.bulbProg.program, [
      { name: 'aPos', size: 3 },
      { name: 'aColor', size: 3 },
      { name: 'aParam', size: 2 },
    ]);
    this.shadowBatch = new InstancedQuads(gl, this.shadowProg.program, [
      { name: 'aPos', size: 3 },
      { name: 'aParam', size: 2 },
    ]);

    this.build(renderer);
    this.ready = true;
  }

  resize(renderer) {
    if (this.ready) this.build(renderer);
  }

  /// Generates the skeleton and uploads every static batch. Called on
  /// init and on resize; the geometry is deterministic from the seed, so a
  /// resize rebuilds the same tree at a new size rather than a new tree.
  build(renderer) {
    const gl = this.gl;
    const rand = mulberry32(this.opts.seed);
    const H = renderer.height / renderer.dpr; // work in CSS pixels, scale at draw
    const scale = renderer.dpr;
    const height = H * this.opts.heightFraction * scale;
    const radius = height * 0.29 * this.opts.styleWidth;
    this.height = height;
    this.radius = radius;

    const trunkTop = height * 0.12;
    const foliageTop = height * 0.985;
    const TIERS = 22;

    const needles = new InstanceWriter(12, 7000);
    const snow = new InstanceWriter(12, 1200);
    const trunk = new InstanceWriter(12, 12);

    // --- trunk ------------------------------------------------------------
    // Barely visible under the canopy, but its absence is noticeable: the
    // tree would appear to hover.
    for (let i = 0; i < 4; i++) {
      const t = i / 4;
      trunk.push(
        (rand() - 0.5) * radius * 0.04, trunkTop * (0.2 + t * 0.45), (rand() - 0.5) * radius * 0.08,
        0, 0.25, 1,
        radius * 0.13, rand() * 6.28, 0.02, 0,
        3, 1 // bark cell
      );
    }

    // --- canopy -----------------------------------------------------------
    for (let tier = 0; tier < TIERS; tier++) {
      const f = tier / (TIERS - 1); // 0 bottom .. 1 top
      const tierY = trunkTop + (foliageTop - trunkTop) * f;
      // Exponent below 1 keeps the profile slightly concave, like a real
      // conifer, rather than the straight-sided triangle of a stack of
      // scaled shapes.
      const tierR = radius * (1 - f) ** 0.78 * (0.92 + rand() * 0.16);
      if (tierR < radius * 0.05) continue;

      const branches = Math.max(4, Math.round((tierR / radius) * 15));
      for (let b = 0; b < branches; b++) {
        // Golden-angle offset per tier: without it, branch tips line up
        // into visible vertical columns down the tree.
        const ang = (b / branches) * TAU + tier * GOLDEN_ANGLE + rand() * 0.2;
        const dx = Math.cos(ang);
        const dz = Math.sin(ang);
        const len = tierR * (0.82 + rand() * 0.38);
        const droop = (0.2 + rand() * 0.28 + (1.0 - f) * 0.22) * len;

        const sprigs = Math.max(6, Math.round(len / (radius * 0.038)));
        for (let s = 0; s < sprigs; s++) {
          const u = (s + 0.35 + rand() * 0.6) / sprigs;
          // Sprigs fan around the branch axis rather than sitting on it,
          // which is what gives the branch its own thickness.
          const fan = (rand() - 0.5) * 0.55;
          const bx = dx * len * u + Math.cos(ang + Math.PI / 2) * fan * radius * 0.1;
          const bz = dz * len * u + Math.sin(ang + Math.PI / 2) * fan * radius * 0.1;
          // Quadratic sag: a branch is nearly level where it leaves the
          // trunk and falls away increasingly toward its tip.
          const by = tierY - droop * u * u + (rand() - 0.5) * radius * 0.03;

          const nx = dx * 0.72 + (rand() - 0.5) * 0.45;
          const nz = dz * 0.72 + (rand() - 0.5) * 0.45;
          const ny = 0.42 + rand() * 0.4 - u * 0.25;
          const nl = Math.hypot(nx, ny, nz) || 1;

          const size = radius * (0.135 + rand() * 0.075) * (1 - u * 0.2) * (1 - f * 0.22);
          // Wind amount grows along the branch: the tip is a lever arm,
          // the base is bolted to the trunk.
          const windAmount = 0.12 + u * u * 0.95 + f * 0.25;
          // Orient the sprite so its tip points away from the trunk and
          // slightly down — conifer sprigs droop, and a sprite rotated any
          // other way reads as a fern frond sticking up.
          //
          // The sprite's local "up" is +Y; rotating (0,1) by t gives
          // (-sin t, cos t), so to aim it at the screen-space direction
          // (sx, sy) we need t = atan2(-sx, sy).
          const sx = dx * (0.55 + 0.45 * u);
          const sy = -(0.35 + droop / Math.max(len, 1e-3) * 1.3 * u);
          let rot = Math.atan2(-sx, sy) + (rand() - 0.5) * 1.1;
          // A minority of sprigs sit tucked back against the branch rather
          // than fanning outward. Without them every sprig reads as the
          // same frond repeated, which is very visible along the edge of
          // the silhouette.
          if (rand() < 0.22) rot += Math.PI * (0.75 + rand() * 0.5);

          const cell = Math.floor(rand() * 5);
          needles.push(
            bx, by, bz,
            nx / nl, ny / nl, nz / nl,
            size, rand() * TAU, windAmount, rot,
            cell % ATLAS_COLS, Math.floor(cell / ATLAS_COLS)
          );

          // Snow settles on sprigs that face upward and are not buried
          // deep inside the canopy.
          if (ny / nl > 0.42 && u > 0.3 && rand() > 1 - 0.4 * this.opts.snowAmount) {
            const snowCell = 5 + Math.floor(rand() * 2);
            snow.push(
              bx, by + size * 0.06, bz + size * 0.02,
              nx / nl * 0.4, 0.9, nz / nl * 0.4,
              size * 1.02, rand() * TAU, windAmount, rot,
              snowCell % ATLAS_COLS, Math.floor(snowCell / ATLAS_COLS)
            );
          }
        }
      }
    }

    this.needleBatch.upload(needles.data, needles.count, gl.STATIC_DRAW);
    this.snowBatch.upload(snow.data, snow.count, gl.STATIC_DRAW);
    this.trunkBatch.upload(trunk.data, trunk.count, gl.STATIC_DRAW);
    this.instanceCount = needles.count + snow.count + trunk.count;

    // --- baubles ----------------------------------------------------------
    const ornamentCount = Math.max(0, Math.round(this.opts.ornamentCount));
    const orn = new InstanceWriter(8, Math.max(1, ornamentCount));
    for (let i = 0; i < ornamentCount; i++) {
      const f = 0.08 + rand() * 0.82;
      const y = trunkTop + (foliageTop - trunkTop) * f;
      const r = radius * (1 - f) ** 0.78 * (0.84 + rand() * 0.26);
      const a = rand() * TAU;
      const col = hexToRgb(this.opts.ornamentColors[Math.floor(rand() * this.opts.ornamentColors.length)]);
      orn.push(
        Math.cos(a) * r, y, Math.sin(a) * r,
        col[0], col[1], col[2],
        radius * (0.035 + rand() * 0.026), rand() > 0.75 ? 1 : 0
      );
    }
    this.ornamentBatch.upload(orn.data, orn.count, gl.STATIC_DRAW);

    // --- bulbs ------------------------------------------------------------
    // Wound as a spiral, which is how a string actually goes on a tree,
    // and each bulb keeps its own flicker constants for life.
    this.bulbs = [];
    const bulbCount = this.opts.lightsOn === false ? 0 : Math.max(0, Math.round(this.opts.bulbCount));
    for (let i = 0; i < bulbCount; i++) {
      const f = 0.04 + (i / Math.max(1, bulbCount)) * 0.92;
      const y = trunkTop + (foliageTop - trunkTop) * f;
      const r = radius * (1 - f) ** 0.78 * (1.04 + rand() * 0.12);
      // Golden angle, not a round 2.1 rad. A step of 2.1 is close enough
      // to 120 degrees that consecutive bulbs stack into three vertical
      // columns, which on screen collapsed the whole string onto the left
      // and right silhouettes. The golden angle is the one step that never
      // repeats into columns — the same reason a sunflower uses it.
      const a = i * GOLDEN_ANGLE + rand() * 0.5;
      const color = hexToRgb(this.opts.bulbColors[i % this.opts.bulbColors.length]);
      this.bulbs.push({
        x: Math.cos(a) * r,
        y,
        z: Math.sin(a) * r,
        color,
        size: radius * 0.062 * this.opts.bulbSize,
        // Three incommensurate rates per bulb, each with its own phase: no
        // two bulbs share a period, so the string never visibly pulses as
        // a unit the way a single shared sine makes it.
        r1: 0.4 + rand() * 0.7,
        r2: 1.1 + rand() * 1.9,
        r3: 3.3 + rand() * 4.1,
        p1: rand() * TAU,
        p2: rand() * TAU,
        p3: rand() * TAU,
        base: 0.55 + rand() * 0.3,
      });
    }
    this.bulbData = new Float32Array(this.bulbs.length * 8);

    // --- star -------------------------------------------------------------
    this.star = this.opts.star === false
      ? null
      : { x: 0, y: foliageTop + radius * 0.07, z: 0, size: radius * 0.78 };
    this.starData = new Float32Array(8);

    // --- contact shadow ---------------------------------------------------
    const sh = new InstanceWriter(5, 1);
    sh.push(0, radius * 0.02, 0, radius * 1.25, radius * 0.2);
    this.shadowBatch.upload(sh.data, sh.count, gl.STATIC_DRAW);
  }

  /// Per-bulb brightness for this instant. Sum of three sines at rates
  /// that share no common period, so the sequence never repeats audibly
  /// to the eye, plus a rare deeper dip that reads as a loose contact.
  bulbLevel(b, time, index) {
    const mode = this.opts.lightMode;
    if (mode && mode !== 'twinkle') {
      // Chase, wave, sparkle and steady come from the shared light model,
      // so a string set to "chase" runs identically here and in the
      // Canvas 2D garlands.
      return bulbLevel(mode, time, index, b.p1, this.bulbs.length, this.opts.lightSpeed)
        * this.opts.lightIntensity;
    }
    // The default: three incommensurate rates per bulb plus a rare deeper
    // dip, which reads as a loose contact rather than a pattern.
    const t = time * this.opts.lightSpeed;
    const wobble =
      0.5 * Math.sin(t * b.r1 + b.p1) +
      0.3 * Math.sin(t * b.r2 + b.p2) +
      0.2 * Math.sin(t * b.r3 + b.p3);
    const dip = Math.max(0, Math.sin(t * 0.21 + b.p1 * 3.1)) ** 24;
    return Math.max(0.06, (b.base + 0.35 * wobble) * (1 - 0.55 * dip)) * this.opts.lightIntensity;
  }

  update(dt, time) {
    if (!this.bulbData) return;
    const d = this.bulbData;
    for (let i = 0; i < this.bulbs.length; i++) {
      const b = this.bulbs[i];
      const level = this.bulbLevel(b, time, i);
      b.level = level;
      const o = i * 8;
      d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.z;
      d[o + 3] = b.color[0]; d[o + 4] = b.color[1]; d[o + 5] = b.color[2];
      d[o + 6] = b.size; d[o + 7] = level;
    }
    // The star pulses far more slowly than the string, so it reads as a
    // different fixture rather than the brightest bulb.
    this.starLevel = (0.72 + 0.28 * Math.sin(time * 0.55) + 0.06 * Math.sin(time * 3.3)) *
      this.opts.lightIntensity;
    if (!this.star) return;
    const s = this.starData;
    s[0] = this.star.x; s[1] = this.star.y; s[2] = this.star.z;
    s[3] = 1.0; s[4] = 0.93; s[5] = 0.72;
    s[6] = this.star.size; s[7] = this.starLevel;
  }

  /// Only a spread subset of the bulbs becomes a real light — the rig holds
  /// 24 and the rest of the scene needs slots too. Sampling evenly along
  /// the string means the whole tree is still lit from within, and every
  /// chosen light uses the SAME brightness number the sprite does, so a
  /// bulb dimming visibly dims the needles around it.
  contributeLights(rig, time) {
    if (!this.bulbs.length) return;
    const ox = this.originX ?? 0;
    const oy = this.originY ?? 0;
    const picks = 9;
    for (let k = 0; k < picks; k++) {
      const b = this.bulbs[Math.floor((k + 0.5) * (this.bulbs.length / picks))];
      if (!b) continue;
      rig.add(
        ox + b.x, oy + b.y, b.z,
        b.color, (b.level ?? 0.7) * 1.5, this.radius * 1.05
      );
    }
    if (this.star) {
      rig.add(
        ox + this.star.x, oy + this.star.y, this.star.z,
        [1.0, 0.92, 0.7], (this.starLevel ?? 0.8) * 2.4, this.radius * 1.5
      );
    }
  }

  render(ctx) {
    const gl = this.gl;
    const r = ctx.renderer;
    const off = ctx.camera.offsetFor(this.z);
    // Anchor in framebuffer pixels, with y measured up from the bottom —
    // the scene-space convention the whole engine shares.
    this.originX = this.opts.anchor[0] * ctx.width + off.x * ctx.dpr;
    this.originY = this.opts.anchor[1] * ctx.height + off.y * ctx.dpr;

    const flip = this.opts.flip ? -1 : 1;
    const focal = this.radius * 6.5;
    const zRange = this.radius * 1.6;

    const setShared = (u) => {
      gl.uniform2f(u.uResolution, ctx.width, ctx.height);
      gl.uniform2f(u.uOrigin, this.originX, this.originY);
      gl.uniform1f(u.uFocal, focal);
      if (u.uFlip) gl.uniform1f(u.uFlip, flip);
      gl.uniform1f(u.uZRange, zRange);
    };

    // --- contact shadow, first and without depth ------------------------
    gl.useProgram(this.shadowProg.program);
    setShared(this.shadowProg.uniforms);
    gl.uniform1f(this.shadowProg.uniforms.uOpacity, 0.42);
    gl.depthMask(false);
    Blend.over(gl);
    this.shadowBatch.draw();
    gl.depthMask(true);

    // --- foliage, trunk and snow: alpha-tested, depth-written -----------
    gl.useProgram(this.foliage.program);
    const fu = this.foliage.uniforms;
    setShared(fu);
    gl.uniform1f(fu.uTime, ctx.time);
    gl.uniform1f(fu.uWind, this.opts.wind);
    gl.uniform1f(fu.uRadius, this.radius);
    gl.uniform2f(fu.uAtlasCells, ATLAS_COLS, ATLAS_ROWS);
    gl.uniform3fv(fu.uDarkGreen, hexToRgb(this.opts.needleDark));
    gl.uniform3fv(fu.uLightGreen, hexToRgb(this.opts.needleLight));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(fu.uAtlas, 0);
    ctx.rig.upload(gl, fu);
    Blend.over(gl);
    this.trunkBatch.draw();
    this.needleBatch.draw();
    this.snowBatch.draw();

    // --- baubles ---------------------------------------------------------
    gl.useProgram(this.ornaments.program);
    const ou = this.ornaments.uniforms;
    setShared(ou);
    ctx.rig.upload(gl, ou);
    this.ornamentBatch.draw();

    // --- bulbs and star: additive, depth-tested but not depth-written ----
    // Tested so a bulb on the far side is hidden by the branches in front
    // of it; not written so two overlapping glows still add.
    gl.useProgram(this.bulbProg.program);
    const bu = this.bulbProg.uniforms;
    setShared(bu);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.uniform1i(bu.uGlow, 0);
    gl.depthMask(false);
    Blend.add(gl);
    this.bulbBatch.upload(this.bulbData, this.bulbs.length);
    this.bulbBatch.draw();
    // The star is the same program with its own sprite and one instance,
    // drawn without the depth test so it always crowns the tree.
    if (this.star) {
      gl.disable(gl.DEPTH_TEST);
      gl.bindTexture(gl.TEXTURE_2D, this.starTex);
      this.bulbBatch.upload(this.starData, 1);
      this.bulbBatch.draw();
      gl.enable(gl.DEPTH_TEST);
    }
    gl.depthMask(true);
    Blend.over(gl);

    ctx.draws += 7;
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    for (const b of [this.needleBatch, this.snowBatch, this.trunkBatch,
      this.ornamentBatch, this.bulbBatch, this.shadowBatch]) b?.dispose();
    for (const p of [this.foliage, this.ornaments, this.bulbProg, this.shadowProg]) {
      if (p) gl.deleteProgram(p.program);
    }
    gl.deleteTexture(this.atlasTex);
    gl.deleteTexture(this.glowTex);
    gl.deleteTexture(this.starTex);
    this.ready = false;
  }
}
