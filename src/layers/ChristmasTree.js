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
import { WIND_GLSL } from '../engine/wind.js';
import { bulbLevel } from '../shared/scene.js';
import { HASH, COLOR } from '../engine/noise.glsl.js';

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
const ATLAS_ROWS = 3;
// Which cell is what. Six plain sprigs and three snow-laden ones, because
// a canopy is thousands of instances and the eye finds a repeat in a set
// of five almost immediately — it is the cheapest realism there is, since
// variety costs atlas space and nothing per frame.
const CELL_SPRIG = 6;
const CELL_SNOWY = 3;
const CELL_BARK = 9;   // two variants: 9, 10
const CELL_DRIFT = 11; // soft snow blob, used for the bank at the base

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
  const density = 0.8 + rand() * 0.5;

  // Stem.
  c.strokeStyle = 'rgba(48,42,26,0.9)';
  c.lineWidth = size * 0.018;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(cx, baseY);
  c.quadraticCurveTo(cx + curve, baseY - len * 0.5, cx + curve * 0.6, tipY);
  c.stroke();

  const pairs = Math.round((11 + rand() * 5) * density);
  // Two passes: the needles pointing AWAY from the viewer first, darker
  // and shorter, then the near ones over them. A single flat fan of
  // strokes has no interior — this is what gives one sprig its own
  // front-to-back depth, before the canopy's depth buffer sees it at all.
  for (const pass of [0, 1]) {
    const behind = pass === 0;
    for (let i = 0; i <= pairs; i++) {
      const t = i / pairs;
      // Point on the stem's quadratic.
      const sx = (1 - t) * (1 - t) * cx + 2 * (1 - t) * t * (cx + curve) + t * t * (cx + curve * 0.6);
      const sy = (1 - t) * (1 - t) * baseY + 2 * (1 - t) * t * (baseY - len * 0.5) + t * t * tipY;
      // Needles are longest at the base of the sprig and shorten toward the
      // tip, which is what gives the sprig its taper.
      const nlen = size * (0.30 - t * 0.17) * (0.75 + rand() * 0.5) * (behind ? 0.78 : 1);
      for (const side of [-1, 1]) {
        const spread = 0.62 + rand() * 0.5 - t * 0.18 + (behind ? 0.22 : 0);
        const ax = side * Math.sin(spread);
        const ay = -Math.cos(spread);
        const ex = sx + ax * nlen;
        const ey = sy + ay * nlen;

        // Dark core, tapering to a point: a needle is a cone, and a
        // constant-width stroke is the classic giveaway of drawn foliage.
        const shade = (0.35 + rand() * 0.45 + t * 0.2) * (behind ? 0.5 : 1);
        c.strokeStyle = `rgba(${Math.round(40 + shade * 60)},${Math.round(70 + shade * 105)},${Math.round(38 + shade * 55)},${behind ? 0.8 : 0.95})`;
        c.lineCap = 'round';
        c.lineWidth = size * (0.026 - t * 0.008);
        c.beginPath();
        c.moveTo(sx, sy);
        c.quadraticCurveTo(
          sx + ax * nlen * 0.55 + ay * nlen * 0.06,
          sy + ay * nlen * 0.55 - ax * nlen * 0.06,
          ex, ey
        );
        c.stroke();
        c.lineWidth = size * 0.006;
        c.beginPath();
        c.moveTo(ex - ax * nlen * 0.14, ey - ay * nlen * 0.14);
        c.lineTo(ex, ey);
        c.stroke();

        // Specular edge along one flank: a needle is a waxy cylinder and
        // catches a line of light, not a uniform tone.
        if (!behind && rand() > 0.45) {
          c.strokeStyle = `rgba(${Math.round(150 + rand() * 70)},${Math.round(200 + rand() * 55)},${Math.round(140 + rand() * 60)},0.5)`;
          c.lineWidth = size * 0.009;
          c.beginPath();
          c.moveTo(sx + ax * nlen * 0.25, sy + ay * nlen * 0.25);
          c.lineTo(ex - ax * nlen * 0.08, ey - ay * nlen * 0.08);
          c.stroke();
        }

        if (snowy && !behind && ay < -0.2 && rand() > 0.35) {
          // Snow only settles on the upward-facing side. Drawn as a chain of
          // soft blobs rather than a hard stroke: a stroke traced the needle
          // exactly and produced a crisp white chevron, which on a hundred
          // sprigs at once reads as a scatter of paper arrows rather than a
          // dusting of snow.
          const steps = 3;
          for (let k = 1; k <= steps; k++) {
            const f = k / steps;
            const px = sx + ax * nlen * f * 0.95;
            const py = sy + ay * nlen * f * 0.95 - size * 0.012;
            const rr = size * (0.030 - t * 0.010) * (1.1 - f * 0.45) * (0.7 + rand() * 0.6);
            const g = c.createRadialGradient(px, py, 0, px, py, rr);
            const alpha = (0.5 + rand() * 0.35) * (1 - f * 0.35);
            g.addColorStop(0, `rgba(240,247,255,${alpha})`);
            g.addColorStop(0.55, `rgba(224,236,252,${alpha * 0.55})`);
            g.addColorStop(1, 'rgba(214,228,248,0)');
            c.fillStyle = g;
            c.beginPath();
            c.arc(px, py, rr, 0, Math.PI * 2);
            c.fill();
          }
        }
      }
    }
  }
}

/// Bark: vertical fibre with knots. Used for the trunk.
function drawBark(c, size, rand) {
  c.fillStyle = '#3a2415';
  c.fillRect(size * 0.22, 0, size * 0.56, size);
  for (let i = 0; i < 140; i++) {
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
  // A rim of light down one edge: a trunk is a cylinder, and without a
  // terminator it reads as a flat brown plank whatever is drawn on it.
  const rim = c.createLinearGradient(size * 0.22, 0, size * 0.78, 0);
  rim.addColorStop(0, 'rgba(0,0,0,0.45)');
  rim.addColorStop(0.35, 'rgba(0,0,0,0)');
  rim.addColorStop(0.72, 'rgba(255,225,180,0.16)');
  rim.addColorStop(1, 'rgba(0,0,0,0.5)');
  c.fillStyle = rim;
  c.fillRect(size * 0.22, 0, size * 0.56, size);
}

/// A soft lump of snow. The bank around the foot of the tree is built out
/// of a dozen of these at different sizes, which is enough to read as a
/// drift and costs nothing — they ride in the existing foliage batch.
function drawDrift(c, size, rand) {
  const cx = size / 2;
  const cy = size * 0.62;
  for (let i = 0; i < 7; i++) {
    const px = cx + (rand() - 0.5) * size * 0.5;
    const py = cy + (rand() - 0.5) * size * 0.22;
    const rr = size * (0.18 + rand() * 0.2);
    const g = c.createRadialGradient(px, py - rr * 0.3, rr * 0.1, px, py, rr);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.5, 'rgba(228,238,252,0.7)');
    g.addColorStop(1, 'rgba(198,214,238,0)');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(px, py, rr, rr * 0.72, 0, 0, Math.PI * 2);
    c.fill();
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
    if (i < CELL_SPRIG) drawSprig(c, ATLAS_CELL, rand);
    else if (i < CELL_SPRIG + CELL_SNOWY) drawSprig(c, ATLAS_CELL, rand, { snowy: true });
    else if (i < CELL_DRIFT) drawBark(c, ATLAS_CELL, rand);
    else drawDrift(c, ATLAS_CELL, rand);
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
${WIND_GLSL}
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;    // position in tree space (pixels, y up, z toward viewer)
in vec3 aNrm;    // outward normal of the sprig
in vec4 aParam;  // size, windPhase, windAmount, billboardRotation
in vec2 aCell;   // atlas cell
in float aMat;   // 0 = needle, 1 = settled snow, 2 = bark
uniform float uTime;
uniform float uWind;
uniform vec2  uAtlasCells;
out vec2 vUV;
out vec2 vLocal;
out vec3 vNrm;
out vec3 vWorld;
out float vZ;
out float vSeed;
out float vMat;
out float vMotion;

void main() {
  // Wind comes from the SHARED field (engine/wind.js), not from a noise
  // function private to this shader: the baubles, the bulbs and the
  // ribbon displace by the same call, so everything hanging on a branch
  // rides the same gust the branch itself does. Neighbouring sprigs stay
  // together because the field is sampled at the anchor, which they
  // nearly share.
  vec3 push = windOffset(aPos, aParam.z * uWind, aParam.y);
  vec3 p = aPos + push;

  float persp;
  vec4 clip = project(p, persp);

  float s = aParam.x * persp;
  // A sprig pushed sideways also rolls about its own stem — a frond is
  // not a rigid card being translated, and the roll is what keeps the
  // canopy from looking like a sheet of decals sliding in unison.
  float roll = aParam.w + clamp(push.x, -30.0, 30.0) * 0.011;
  float ca = cos(roll), sa = sin(roll);
  vec2 corner = vec2(aCorner.x * ca - aCorner.y * sa, aCorner.x * sa + aCorner.y * ca);
  clip.xy += corner * s / uResolution * 2.0;

  vUV = (aCell + (aCorner * 0.5 + 0.5)) / uAtlasCells;
  vLocal = aCorner * 0.5 + 0.5;
  vNrm = aNrm;
  vWorld = vec3(uOrigin + p.xy, p.z);
  vZ = p.z;
  vSeed = float(gl_InstanceID);
  vMat = aMat;
  vMotion = clamp(length(push.xz) * 0.04, 0.0, 1.0);
  gl_Position = clip;
}`;

const FOLIAGE_FS = /* glsl */ `#version 300 es
precision highp float;
${COLOR}
${HASH}
${LIGHTING_GLSL}
in vec2 vUV;
in vec2 vLocal;
in vec3 vNrm;
in vec3 vWorld;
in float vZ;
in float vSeed;
in float vMat;
in float vMotion;
uniform sampler2D uAtlas;
uniform vec3 uDarkGreen;
uniform vec3 uLightGreen;
uniform vec3 uTrunkColor;
uniform vec3 uSnowTint;
uniform float uRadius;
uniform float uTime;
uniform float uFrost;
uniform float uAlphaCut;
out vec4 outColor;

void main() {
  vec4 tex = texture(uAtlas, vUV);
  // Alpha test rather than sorted blending: foliage is thousands of
  // overlapping sprites, and sorting them every frame would cost more than
  // the whole canopy is worth. The depth buffer gives correct occlusion
  // for free at the price of a crisp edge, which needles have anyway.
  // The snow bank at the foot of the tree is the exception — it is drawn
  // blended, with the cut dropped, because a hard edge there would show
  // as a row of cut-out circles against the desktop.
  if (tex.a < uAlphaCut) discard;
  vec3 albedoTex = tex.rgb / max(tex.a, 1e-3);

  // Per-sprig hue and value variation. A canopy of one green is the
  // single most artificial-looking thing a CG tree can do.
  vec3 h = hash31(vSeed * 7.13 + 1.7);
  vec3 base = mix(uDarkGreen, uLightGreen, h.x * 0.85 + 0.15);
  base *= 0.7 + h.y * 0.55;
  // Needles are not one hue either: real spruce runs blue-green at the
  // shaded base of a sprig and yellow-green at the sunlit growing tip,
  // and reproducing that gradient along the sprite is most of what stops
  // the canopy reading as one flat colour field.
  base = mix(base * vec3(0.88, 0.97, 1.06), base * vec3(1.10, 1.06, 0.82), vLocal.y);

  float isSnow = step(0.5, vMat) * step(vMat, 1.5);
  float isBark = step(1.5, vMat);
  // Barely, not fully: the snow is already IN the sprite (the atlas draws
  // white deposits over the needles), so tinting the albedo white as well
  // double-counts it and turns every snow sprig into a paper cut-out.
  base = mix(base, uSnowTint * 0.9, isSnow * 0.28);
  base = mix(base, uTrunkColor, isBark);

  vec3 albedo = toLinear(base) * albedoTex;

  vec3 n = normalize(vNrm);
  vec3 viewDir = vec3(0.0, 0.0, 1.0);

  // Ambient occlusion inside the canopy: sprigs deep behind the silhouette
  // receive far less sky, which is what gives the tree its interior
  // darkness and therefore its sense of depth.
  float ao = mix(0.28, 1.0, smoothstep(-uRadius, uRadius * 0.75, vZ));
  // A sprig at the tip of a branch is on the outside of the canopy and
  // catches more of everything; one near the stem is buried.
  ao *= mix(0.82, 1.0, vLocal.y);

  float translucency = mix(0.85, 0.35, isSnow + isBark);
  vec3 lit = ambientTerm(n) * ao + lightTerm(vWorld, n, viewDir, translucency) * mix(0.55, 1.0, ao);
  vec3 color = albedo * lit;

  // Rime on the needle tips: a cold night frosts the outermost growth
  // first, which is exactly where the eye looks for the silhouette.
  float rime = uFrost * smoothstep(0.68, 1.0, vLocal.y) * (0.35 + 0.65 * h.z) * (1.0 - isBark);
  color = mix(color, color * 0.8 + toLinear(uSnowTint) * ambientTerm(n) * 1.6, rime * 0.45);

  // Snow and rime are made of facets: a handful of them catch a light
  // dead-on and flash. Gated hard so only a few crystals per frame fire,
  // because constant glitter reads as video noise rather than ice.
  float crystals = max(isSnow, rime);
  if (crystals > 0.02) {
    float seed = vSeed * 0.317 + floor(vLocal.x * 3.0) + floor(vLocal.y * 3.0) * 7.0;
    float flash = sin(uTime * 1.9 + seed * 12.9898);
    flash = pow(max(flash, 0.0), 48.0) * step(0.86, fract(seed * 0.618));
    color += vec3(0.9, 0.96, 1.0) * flash * crystals * 1.2;
  }

  // Motion lets a touch more sky through the canopy: a branch in a gust
  // opens up and brightens, which is the cue that sells the movement as
  // physical rather than as a sprite sliding sideways.
  color *= 1.0 + vMotion * 0.12;

  outColor = vec4(color * tex.a, tex.a);
}`;

const ORNAMENT_VS = /* glsl */ `#version 300 es
precision highp float;
${WIND_GLSL}
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;
in vec3 aColor;
in vec4 aParam; // radius, kind (0 = glossy ball, 1 = matte), windAmount, phase
uniform float uWind;
out vec2 vQ;
out vec3 vColor;
out vec3 vWorld;
out float vKind;
out float vSwing;
void main() {
  // A bauble is not glued to the branch: it hangs from it on a hook, so
  // it BOTH rides the branch's own displacement and swings behind it as a
  // pendulum. Leaving the baubles static while the needles moved was the
  // most visible artificial thing left in the layer.
  vec3 push = windOffset(aPos, aParam.z * uWind, aParam.w);
  vec3 p = aPos + push * 0.72;

  float hang = aParam.x * 2.1;
  // The swing lags the gust (a mass on a string does not arrive with the
  // air) and adds its own small natural oscillation, faster for a short
  // hook than a long one, which is what a pendulum actually does.
  float natural = inversesqrt(max(hang, 1.0)) * 34.0;
  float theta = clamp(push.x * 0.010, -0.55, 0.55)
              + 0.055 * sin(uWindPhase * natural + aParam.w);
  p.x += hang * sin(theta);
  p.y -= hang * (1.0 - cos(theta));

  float persp;
  vec4 clip = project(p, persp);
  clip.xy += aCorner * (aParam.x * persp) / uResolution * 2.0;
  // Same decal bias as the bulbs: a bauble hanging off the front of a
  // branch loses the depth test against the sprigs it is resting among.
  clip.z -= 0.03;
  vQ = aCorner;
  vColor = aColor;
  vWorld = vec3(uOrigin + p.xy, p.z);
  vKind = aParam.y;
  vSwing = theta;
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
in float vSwing;
uniform float uGloss;
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
  float shininess = mix(64.0, 9.0, vKind) * mix(0.4, 1.6, uGloss);
  float strength = mix(1.5, 0.25, vKind) * uGloss;
  color += specularTerm(vWorld, n, viewDir, shininess, strength);
  // Fresnel rim: grazing angles reflect more, which is what makes the
  // silhouette of a glass ball brighter than its middle.
  color += albedo * pow(1.0 - n.z, 4.0) * 0.45;
  // A ball is a mirror, and the biggest thing in its mirror is the sky
  // above and the dark ground below. One extra term, and it is the
  // difference between a shaded circle and something with a surface —
  // tinted by the bauble, because a coloured ball does not reflect the
  // sky white, it reflects it its own colour.
  color += mix(albedo, vec3(1.0), 0.35) * ambientTerm(reflect(-viewDir, n))
         * mix(0.9, 0.25, vKind) * (0.25 + 0.75 * uGloss);

  // The metal cap and its hook, rotated with the swing so the whole
  // ornament reads as one rigid object hanging off one point.
  float ca = cos(vSwing), sa = sin(vSwing);
  vec2 q = vec2(vQ.x * ca + vQ.y * sa, -vQ.x * sa + vQ.y * ca);
  float cap = smoothstep(0.62, 0.72, q.y) * (1.0 - smoothstep(0.30, 0.38, abs(q.x)));
  vec3 capColor = vec3(0.62, 0.58, 0.48) * (ambientTerm(n) * 3.0 + lightTerm(vWorld, n, viewDir, 0.0));
  color = mix(color, capColor, cap);

  float edge = smoothstep(1.0, 0.93, r2);
  outColor = vec4(color * edge, edge);
}`;

const BULB_VS = /* glsl */ `#version 300 es
precision highp float;
${WIND_GLSL}
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;
in vec3 aColor;
in vec4 aParam; // size, brightness, windAmount, wind phase
in float aSpin; // billboard rotation: 0 for a bulb, animated for the star
uniform float uWind;
out vec2 vUV;
out vec3 vColor;
out float vBright;
void main() {
  // The string is wired to the branches, so it travels with them. A bulb
  // that stays put while the needles around it move detaches visibly,
  // and that detachment is much easier to see than the movement itself.
  vec3 p = aPos + windOffset(aPos, aParam.z * uWind, aParam.w) * 0.85;
  float persp;
  vec4 clip = project(p, persp);
  // A brighter bulb blooms physically larger, which is how an eye reads
  // intensity on a small light source.
  float s = aParam.x * persp * (0.7 + 0.5 * aParam.y);
  // Spin is 0 for a bulb and animated for the star, whose flare has to
  // turn or its spikes read as a painted-on decal.
  float ca = cos(aSpin), sa = sin(aSpin);
  clip.xy += vec2(aCorner.x * ca - aCorner.y * sa, aCorner.x * sa + aCorner.y * ca)
             * s / uResolution * 2.0;
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
  // A small point source seen through any real optic — a lens, an
  // eyelash, a wet window — throws a cross. Adding it here, scaled by
  // brightness so it only appears on a bulb that is actually bright,
  // is what separates a lit bulb from a coloured dot.
  vec2 d = abs(vUV - 0.5) * 2.0;
  float streak = (exp(-d.x * 26.0) + exp(-d.y * 26.0)) * exp(-length(d) * 2.2);
  g = min(1.0, g + streak * 0.12 * vBright);
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

// The ribbon: a spiral of short oriented segments wound round the tree.
//
// It is a strip of cloth, not a line, so it is drawn as quads that are
// long along the spiral's tangent and narrow across it — which means each
// segment carries its own tangent angle and each one turns to face the
// viewer differently as it goes round the back. It rides the same wind
// field as everything else, with a small extra flutter of its own,
// because a loose satin band moves considerably more than a branch does.
const RIBBON_VS = /* glsl */ `#version 300 es
precision highp float;
${WIND_GLSL}
${PROJECT_GLSL}
in vec2 aCorner;
in vec3 aPos;
in vec4 aParam;  // halfLength, halfWidth, tangent angle, windAmount
in vec4 aShape;  // facing (-1 back / 1 front), wind phase, u along the ribbon, twist rate
uniform float uWind;
uniform float uTime;
out vec2 vLocal;
out vec3 vWorld;
out float vFacing;
out float vU;
out float vTwist;
void main() {
  vec3 push = windOffset(aPos, aParam.w * uWind, aShape.y);
  // Cloth flutters on top of the gust it is riding: a travelling ripple
  // along the band's own length, which is what a satin ribbon does and a
  // branch does not.
  float ripple = sin(aShape.z * 26.0 - uWindPhase * 3.4 + aShape.y) * uWindGust;
  vec3 p = aPos + push * 1.25 + vec3(0.0, ripple * 2.2, ripple * 1.4);

  float persp;
  vec4 clip = project(p, persp);

  // The band narrows as it turns edge-on going round the back of the
  // tree, which is the only cue that says "this is wrapped around
  // something" rather than "this is painted on the silhouette".
  float twist = cos(aShape.w + ripple * 0.35);
  float ca = cos(aParam.z), sa = sin(aParam.z);
  vec2 local = vec2(aCorner.x * aParam.x, aCorner.y * aParam.y * mix(0.45, 1.0, abs(twist)));
  vec2 rotated = vec2(local.x * ca - local.y * sa, local.x * sa + local.y * ca);
  clip.xy += rotated * persp / uResolution * 2.0;
  // Biased toward the viewer only on the near half of the spiral. A
  // uniform bias drew the BACK of the ribbon over the canopy it is
  // supposed to be hidden behind, which flattened the whole wrap.
  clip.z -= 0.035 * aShape.x;

  vLocal = aCorner;
  vWorld = vec3(uOrigin + p.xy, p.z);
  vFacing = aShape.x;
  vU = aShape.z;
  vTwist = twist;
  gl_Position = clip;
}`;

const RIBBON_FS = /* glsl */ `#version 300 es
precision highp float;
${COLOR}
${LIGHTING_GLSL}
in vec2 vLocal;
in vec3 vWorld;
in float vFacing;
in float vU;
in float vTwist;
uniform vec3 uColor;
uniform float uTime;
uniform float uGlitter;
out vec4 outColor;
void main() {
  // Soft on every side, so consecutive segments cross-fade into one
  // continuous band instead of showing a chain of rectangles.
  float across = abs(vLocal.y);
  float along = abs(vLocal.x);
  float a = (1.0 - smoothstep(0.58, 1.0, across)) * (1.0 - smoothstep(0.45, 1.0, along));
  if (a < 0.01) discard;

  // The band's normal turns with the twist, so the cloth catches the
  // light rig at a different angle on the near side and the far side.
  vec3 n = normalize(vec3(vLocal.y * 0.2, vTwist * 0.3, max(vTwist, 0.25)));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 albedo = toLinear(uColor);

  vec3 lit = ambientTerm(n) * 0.45 + lightTerm(vWorld, n, viewDir, 0.3);
  vec3 color = albedo * lit;
  // Satin has an anisotropic sheen running ACROSS the weave: a bright
  // line along the band, offset from its centre because the fold that
  // catches the light is never exactly in the middle of the cloth.
  float sheen = exp(-(vLocal.y - 0.28) * (vLocal.y - 0.28) * 9.0);
  color += specularTerm(vWorld, n, viewDir, 30.0, 0.25) * sheen;
  color += albedo * sheen * 0.12 * (ambientTerm(n) * 2.0 + 0.1);

  // Metallic thread woven through it, firing one glint at a time.
  float seed = floor(vU * 240.0);
  float flash = pow(max(sin(uTime * 2.3 + seed * 12.9898), 0.0), 44.0)
              * step(0.78, fract(seed * 0.618));
  color += vec3(1.0, 0.92, 0.66) * flash * uGlitter * 1.2;

  // The far half of the spiral is behind the trunk and must read darker,
  // or the ribbon looks like a flat ring drawn over the tree.
  color *= mix(0.42, 1.0, vFacing * 0.5 + 0.5);

  outColor = vec4(color * a, a);
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
      trunkColor: '#4a3019',
      snowTint: '#e8f1ff',
      bulbColors: ['#ffc169', '#ffa93f', '#ffd79b'],
      ornamentColors: ['#c0392b', '#e8c25a', '#e9edf2', '#8fb7d8', '#b0392b'],
      bulbCount: 96,
      ornamentCount: 38,
      ornamentGloss: 1,
      wind: 1.0,
      sway: 1.0,
      lightIntensity: 1.0,
      // Scene-driven knobs, so one layer class covers every tree a
      // composition can ask for rather than one hard-coded tree.
      styleWidth: 1.0,    // spruce is narrow, pine is broad
      styleDensity: 1.0,  // branches per tier
      snowAmount: 1.0,
      frost: 0.18,
      star: true,
      starSize: 1,
      starColor: '#fff0c2',
      ribbon: false,
      ribbonColor: '#c0392b',
      ribbonWidth: 1,
      ribbonTurns: 4,
      ribbonGlitter: 1,
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
    this.ribbonProg = createProgram(gl, RIBBON_VS, RIBBON_FS, 'tree.ribbon');

    const foliageAttribs = [
      { name: 'aPos', size: 3 },
      { name: 'aNrm', size: 3 },
      { name: 'aParam', size: 4 },
      { name: 'aCell', size: 2 },
      { name: 'aMat', size: 1 },
    ];
    this.needleBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.snowBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.trunkBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.driftBatch = new InstancedQuads(gl, this.foliage.program, foliageAttribs);
    this.ornamentBatch = new InstancedQuads(gl, this.ornaments.program, [
      { name: 'aPos', size: 3 },
      { name: 'aColor', size: 3 },
      { name: 'aParam', size: 4 },
    ]);
    this.bulbBatch = new InstancedQuads(gl, this.bulbProg.program, [
      { name: 'aPos', size: 3 },
      { name: 'aColor', size: 3 },
      { name: 'aParam', size: 4 },
      { name: 'aSpin', size: 1 },
    ]);
    this.ribbonBatch = new InstancedQuads(gl, this.ribbonProg.program, [
      { name: 'aPos', size: 3 },
      { name: 'aParam', size: 4 },
      { name: 'aShape', size: 4 },
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

    const needles = new InstanceWriter(13, 7000);
    const snow = new InstanceWriter(13, 1200);
    const trunk = new InstanceWriter(13, 12);

    // --- trunk ------------------------------------------------------------
    // Barely visible under the canopy, but its absence is noticeable: the
    // tree would appear to hover.
    for (let i = 0; i < 4; i++) {
      const t = i / 4;
      const barkCell = CELL_BARK + (i % 2);
      trunk.push(
        (rand() - 0.5) * radius * 0.04, trunkTop * (0.2 + t * 0.45), (rand() - 0.5) * radius * 0.08,
        0, 0.25, 1,
        radius * 0.13, rand() * 6.28, 0.02, 0,
        barkCell % ATLAS_COLS, Math.floor(barkCell / ATLAS_COLS),
        2 // material: bark
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

          const cell = Math.floor(rand() * CELL_SPRIG);
          needles.push(
            bx, by, bz,
            nx / nl, ny / nl, nz / nl,
            size, rand() * TAU, windAmount, rot,
            cell % ATLAS_COLS, Math.floor(cell / ATLAS_COLS),
            0 // material: needle
          );

          // Snow settles on sprigs that face upward and are not buried
          // deep inside the canopy.
          if (ny / nl > 0.42 && u > 0.3 && rand() > 1 - 0.4 * this.opts.snowAmount) {
            const snowCell = CELL_SPRIG + Math.floor(rand() * CELL_SNOWY);
            snow.push(
              bx, by + size * 0.06, bz + size * 0.02,
              nx / nl * 0.4, 0.9, nz / nl * 0.4,
              size * 1.02, rand() * TAU, windAmount, rot,
              snowCell % ATLAS_COLS, Math.floor(snowCell / ATLAS_COLS),
              1 // material: settled snow
            );
          }
        }
      }
    }

    this.needleBatch.upload(needles.data, needles.count, gl.STATIC_DRAW);
    this.snowBatch.upload(snow.data, snow.count, gl.STATIC_DRAW);
    this.trunkBatch.upload(trunk.data, trunk.count, gl.STATIC_DRAW);
    this.instanceCount = needles.count + snow.count + trunk.count;

    // --- snow bank --------------------------------------------------------
    // A tree standing on nothing floats, and a contact shadow alone only
    // says "something is above the ground here". A drift piled against the
    // trunk is what actually plants it, and it is where the lowest boughs
    // disappear into rather than ending in mid-air.
    const drift = new InstanceWriter(13, 24);
    const driftCount = Math.round(16 * Math.min(1.6, this.opts.snowAmount));
    for (let i = 0; i < driftCount; i++) {
      const a = (i / driftCount) * TAU + rand() * 0.6;
      const spread = radius * (0.2 + rand() * 0.75);
      drift.push(
        Math.cos(a) * spread, radius * (-0.02 + rand() * 0.04), Math.sin(a) * spread * 0.7,
        0, 1, 0.15, // a drift faces the sky
        radius * (0.16 + rand() * 0.16), rand() * TAU, 0, (rand() - 0.5) * 0.5,
        CELL_DRIFT % ATLAS_COLS, Math.floor(CELL_DRIFT / ATLAS_COLS),
        1 // material: snow
      );
    }
    this.driftBatch.upload(drift.data, drift.count, gl.STATIC_DRAW);
    this.driftCount = drift.count;
    // --- baubles ----------------------------------------------------------
    const ornamentCount = Math.max(0, Math.round(this.opts.ornamentCount));
    const orn = new InstanceWriter(10, Math.max(1, ornamentCount));
    for (let i = 0; i < ornamentCount; i++) {
      const f = 0.08 + rand() * 0.82;
      const y = trunkTop + (foliageTop - trunkTop) * f;
      const r = radius * (1 - f) ** 0.78 * (0.84 + rand() * 0.26);
      const a = rand() * TAU;
      const col = hexToRgb(this.opts.ornamentColors[Math.floor(rand() * this.opts.ornamentColors.length)]);
      orn.push(
        Math.cos(a) * r, y, Math.sin(a) * r,
        col[0], col[1], col[2],
        radius * (0.035 + rand() * 0.026), rand() > 0.75 ? 1 : 0,
        // A bauble hangs on the outer half of a branch, so it gets most
        // of that branch's lever arm, plus its own phase.
        0.55 + f * 0.5, rand() * TAU
      );
    }
    this.ornamentBatch.upload(orn.data, orn.count, gl.STATIC_DRAW);

    // --- ribbon -----------------------------------------------------------
    this.ribbonCount = 0;
    if (this.opts.ribbon) {
      const turns = Math.max(1, Math.min(9, this.opts.ribbonTurns));
      // One segment every few degrees: enough that consecutive quads
      // overlap into a continuous band at any size, still one draw call.
      const segments = Math.round(turns * 96);
      const band = new InstanceWriter(11, segments);
      const bandWidth = radius * 0.032 * this.opts.ribbonWidth;
      const point = (t) => {
        const f = 0.06 + t * 0.86;
        const ang = t * TAU * turns + 0.7;
        // Tucked just inside the canopy's own radius: a band sitting
        // proudly outside it reads as a hoop hung around the tree rather
        // than a ribbon threaded into the branches.
        const rr = radius * (1 - f) ** 0.78 * 0.94;
        return {
          x: Math.cos(ang) * rr,
          y: trunkTop + (foliageTop - trunkTop) * f,
          z: Math.sin(ang) * rr,
          ang,
        };
      };
      for (let i = 0; i < segments; i++) {
        const t = i / segments;
        const p = point(t);
        const q = point(Math.min(1, t + 1 / segments));
        // The segment's own tangent, in screen space: a spiral changes
        // direction constantly and a fixed angle would make the band
        // shear against itself at the turns.
        const tangent = Math.atan2(q.y - p.y, q.x - p.x);
        const halfLen = Math.hypot(q.x - p.x, q.y - p.y) * 1.6 + bandWidth * 0.6;
        band.push(
          p.x, p.y, p.z,
          halfLen, bandWidth, tangent, 0.3 + t * 0.55,
          Math.sin(p.ang) > 0 ? 1 : -1, (i % 17) * 0.37, t, p.ang
        );
      }
      this.ribbonBatch.upload(band.data, band.count, gl.STATIC_DRAW);
      this.ribbonCount = band.count;
    }

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
        // The string is wired along the outer face of the branches, so a
        // bulb near the top (where the branches are short) travels less
        // in a gust than one out on a long lower bough.
        windAmount: 0.45 + (1 - f) * 0.55,
        windPhase: rand() * TAU,
      });
    }
    this.bulbData = new Float32Array(this.bulbs.length * 11);

    // --- star -------------------------------------------------------------
    this.star = this.opts.star === false
      ? null
      : { x: 0, y: foliageTop + radius * 0.07, z: 0, size: radius * 0.5 * this.opts.starSize };
    this.starRgb = null;
    // Two instances, not one: a slow flare and a faster counter-rotating
    // one. A single spinning sprite reads as a pinwheel; two turning
    // against each other read as light scattering, which is what a real
    // star filter does.
    this.starData = new Float32Array(22);

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
      const o = i * 11;
      d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.z;
      d[o + 3] = b.color[0]; d[o + 4] = b.color[1]; d[o + 5] = b.color[2];
      d[o + 6] = b.size; d[o + 7] = level;
      d[o + 8] = b.windAmount; d[o + 9] = b.windPhase;
      d[o + 10] = 0; // no spin on a bulb
    }
    // The star pulses far more slowly than the string, so it reads as a
    // different fixture rather than the brightest bulb.
    this.starLevel = (0.5 + 0.2 * Math.sin(time * 0.55) + 0.05 * Math.sin(time * 3.3)) *
      this.opts.lightIntensity;
    if (!this.star) return;
    const s = this.starData;
    const col = this.starRgb ?? (this.starRgb = hexToRgb(this.opts.starColor));
    for (let k = 0; k < 2; k++) {
      const o = k * 11;
      s[o] = this.star.x; s[o + 1] = this.star.y; s[o + 2] = this.star.z;
      s[o + 3] = col[0]; s[o + 4] = col[1]; s[o + 5] = col[2];
      // The counter-rotating flare is smaller and dimmer: it is the
      // secondary scatter, not a second star.
      s[o + 6] = this.star.size * (k === 0 ? 1 : 0.64);
      s[o + 7] = this.starLevel * (k === 0 ? 1 : 0.55);
      s[o + 8] = 0; s[o + 9] = 0; // the topper is rigid; no wind
      s[o + 10] = k === 0 ? time * 0.06 : -time * 0.135 + 0.6;
    }
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
        hexToRgb(this.opts.starColor), (this.starLevel ?? 0.8) * 2.4, this.radius * 1.5
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

    // Every program that moves with the air reads the SAME three numbers,
    // straight off the shared field — that identity is the whole reason a
    // bauble and the branch it hangs from arrive in a gust together.
    const w = ctx.wind?.uniforms(this.opts.sway) ?? { gust: 1, phase: ctx.time, direction: 0 };
    const setWind = (u) => {
      if (u.uWindGust) gl.uniform1f(u.uWindGust, w.gust);
      if (u.uWindPhase) gl.uniform1f(u.uWindPhase, w.phase);
      if (u.uWindDir) gl.uniform1f(u.uWindDir, w.direction);
      if (u.uWind) gl.uniform1f(u.uWind, this.opts.wind);
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
    setWind(fu);
    gl.uniform1f(fu.uTime, ctx.time);
    gl.uniform1f(fu.uRadius, this.radius);
    gl.uniform1f(fu.uFrost, this.opts.frost);
    gl.uniform2f(fu.uAtlasCells, ATLAS_COLS, ATLAS_ROWS);
    gl.uniform3fv(fu.uDarkGreen, hexToRgb(this.opts.needleDark));
    gl.uniform3fv(fu.uLightGreen, hexToRgb(this.opts.needleLight));
    gl.uniform3fv(fu.uTrunkColor, hexToRgb(this.opts.trunkColor));
    gl.uniform3fv(fu.uSnowTint, hexToRgb(this.opts.snowTint));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(fu.uAtlas, 0);
    ctx.rig.upload(gl, fu);
    Blend.over(gl);
    gl.uniform1f(fu.uAlphaCut, 0.36);
    this.trunkBatch.draw();
    this.needleBatch.draw();
    this.snowBatch.draw();

    // The bank is blended, not alpha-tested, and does not write depth: it
    // is a soft thing sitting under everything else, so it must neither
    // show a cut-out edge nor occlude the boughs settling into it.
    if (this.driftCount > 0) {
      gl.uniform1f(fu.uAlphaCut, 0.004);
      gl.depthMask(false);
      this.driftBatch.draw();
      gl.depthMask(true);
      ctx.draws += 1;
    }

    // --- ribbon ----------------------------------------------------------
    if (this.ribbonCount > 0) {
      gl.useProgram(this.ribbonProg.program);
      const ru = this.ribbonProg.uniforms;
      setShared(ru);
      setWind(ru);
      gl.uniform1f(ru.uTime, ctx.time);
      gl.uniform3fv(ru.uColor, hexToRgb(this.opts.ribbonColor));
      gl.uniform1f(ru.uGlitter, this.opts.ribbonGlitter);
      ctx.rig.upload(gl, ru);
      this.ribbonBatch.draw();
      ctx.draws += 1;
    }

    // --- baubles ---------------------------------------------------------
    gl.useProgram(this.ornaments.program);
    const ou = this.ornaments.uniforms;
    setShared(ou);
    setWind(ou);
    gl.uniform1f(ou.uGloss, this.opts.ornamentGloss);
    ctx.rig.upload(gl, ou);
    this.ornamentBatch.draw();

    // --- bulbs and star: additive, depth-tested but not depth-written ----
    // Tested so a bulb on the far side is hidden by the branches in front
    // of it; not written so two overlapping glows still add.
    gl.useProgram(this.bulbProg.program);
    const bu = this.bulbProg.uniforms;
    setShared(bu);
    setWind(bu);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.uniform1i(bu.uGlow, 0);
    gl.depthMask(false);
    Blend.add(gl);
    this.bulbBatch.upload(this.bulbData, this.bulbs.length);
    this.bulbBatch.draw();
    // The star is the same program with its own sprite and two instances,
    // drawn without the depth test so it always crowns the tree.
    if (this.star) {
      gl.disable(gl.DEPTH_TEST);
      gl.bindTexture(gl.TEXTURE_2D, this.starTex);
      this.bulbBatch.upload(this.starData, 2);
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
    for (const b of [this.needleBatch, this.snowBatch, this.trunkBatch, this.driftBatch,
      this.ornamentBatch, this.bulbBatch, this.ribbonBatch, this.shadowBatch]) b?.dispose();
    for (const p of [this.foliage, this.ornaments, this.bulbProg, this.ribbonProg,
      this.shadowProg]) {
      if (p) gl.deleteProgram(p.program);
    }
    gl.deleteTexture(this.atlasTex);
    gl.deleteTexture(this.glowTex);
    gl.deleteTexture(this.starTex);
    this.ready = false;
  }
}
