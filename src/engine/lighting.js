// The shared light rig.
//
// This is the piece that fixes the single biggest reason the old renderer
// looked artificial: there was no lighting model at all. Every element
// baked its own fixed shading, so the fire did not light the tree, the
// tree's own bulbs did not light its branches, and the scene read as a
// collection of objects rather than one lit space.
//
// Here every layer CONTRIBUTES lights each frame and every layer's shader
// CONSUMES the same list. A bulb that flickers therefore changes the
// brightness of the needles around it, and the fire genuinely spills warm
// light onto whatever is near it, because it is the same number going into
// both shaders.
//
// Positions are in scene space (units, not pixels) so a layer does not
// have to know the current resolution or camera to place a light.

export const MAX_LIGHTS = 24;

export class LightRig {
  constructor() {
    this.positions = new Float32Array(MAX_LIGHTS * 3);
    this.colors = new Float32Array(MAX_LIGHTS * 3); // linear, premultiplied by intensity
    this.radii = new Float32Array(MAX_LIGHTS);
    this.count = 0;
    this.ambientSky = [0.055, 0.082, 0.145];
    this.ambientGround = [0.016, 0.019, 0.028];
  }

  clear() {
    this.count = 0;
  }

  /// color is sRGB 0..1; intensity scales it in linear space. radius is the
  /// distance at which the light has fallen to roughly a quarter of its
  /// peak — an inverse-square falloff with a softening term, which behaves
  /// like a real lamp without dividing by zero at the source.
  add(x, y, z, color, intensity, radius) {
    if (this.count >= MAX_LIGHTS) return false;
    const i = this.count;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    // sRGB -> linear here, once per light per frame, instead of per
    // fragment: summing lights in gamma space makes every overlap too
    // bright and washes the colour out.
    this.colors[i * 3] = srgbToLinear(color[0]) * intensity;
    this.colors[i * 3 + 1] = srgbToLinear(color[1]) * intensity;
    this.colors[i * 3 + 2] = srgbToLinear(color[2]) * intensity;
    this.radii[i] = radius;
    this.count++;
    return true;
  }

  /// Uploads the rig to whichever program is currently bound.
  upload(gl, uniforms) {
    if (uniforms.uLightCount) gl.uniform1i(uniforms.uLightCount, this.count);
    if (this.count > 0) {
      if (uniforms.uLightPos) {
        gl.uniform3fv(uniforms.uLightPos, this.positions.subarray(0, this.count * 3));
      }
      if (uniforms.uLightColor) {
        gl.uniform3fv(uniforms.uLightColor, this.colors.subarray(0, this.count * 3));
      }
      if (uniforms.uLightRadius) {
        gl.uniform1fv(uniforms.uLightRadius, this.radii.subarray(0, this.count));
      }
    }
    if (uniforms.uAmbientSky) gl.uniform3fv(uniforms.uAmbientSky, this.ambientSky);
    if (uniforms.uAmbientGround) gl.uniform3fv(uniforms.uAmbientGround, this.ambientGround);
  }
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/// The GLSL half of the rig. Included by every layer shader that wants to
/// be lit, so there is exactly one lighting equation in the project.
export const LIGHTING_GLSL = /* glsl */ `
const int MAX_LIGHTS = ${MAX_LIGHTS};
uniform int  uLightCount;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;

/// Hemispherical ambient: sky colour from above, bounced ground colour
/// from below. Cheap, and it already reads as "outdoors at night" in a way
/// a single flat ambient term never does.
vec3 ambientTerm(vec3 n) {
  return mix(uAmbientGround, uAmbientSky, n.y * 0.5 + 0.5);
}

/// Wrapped diffuse ("half-lambert"). Foliage scatters light through itself,
/// so a needle facing 90 degrees away from a lamp is not black — clamping
/// a plain N.L to zero is what makes CG plants look like cardboard.
/// The translucency argument adds light coming THROUGH the surface from behind,
/// which is what makes a lit tree glow from within, not only on its face.
vec3 lightTerm(vec3 p, vec3 n, vec3 viewDir, float translucency) {
  vec3 total = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLightPos[i] - p;
    float dist2 = dot(d, d);
    vec3 l = d * inversesqrt(max(dist2, 1e-4));
    float r = uLightRadius[i];
    // Inverse-square with a softening term, then a smooth cutoff at the
    // radius so a light never leaves a visible circular edge.
    float atten = 1.0 / (1.0 + dist2 / max(r * r * 0.25, 1e-4));
    atten *= smoothstep(1.0, 0.25, sqrt(dist2) / r);
    float wrapped = dot(n, l) * 0.5 + 0.5;
    float back = pow(max(dot(viewDir, -l), 0.0), 3.0) * translucency;
    total += uLightColor[i] * atten * (wrapped * wrapped + back);
  }
  return total;
}

/// Blinn-Phong specular against the same rig. Used by anything with a
/// smooth surface — glass baubles above all, where the little moving
/// highlight of a nearby bulb is most of what says "this is glass" rather
/// than "this is a coloured circle".
vec3 specularTerm(vec3 p, vec3 n, vec3 viewDir, float shininess, float strength) {
  vec3 total = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLightPos[i] - p;
    float dist2 = dot(d, d);
    vec3 l = d * inversesqrt(max(dist2, 1e-4));
    float r = uLightRadius[i];
    float atten = 1.0 / (1.0 + dist2 / max(r * r * 0.25, 1e-4));
    vec3 h = normalize(l + viewDir);
    total += uLightColor[i] * atten * pow(max(dot(n, h), 0.0), shininess) * strength;
  }
  return total;
}
`;
