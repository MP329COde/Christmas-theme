// Shared GLSL chunks. Kept in one place so every layer's shaders draw
// their randomness from the same functions — using a different noise per
// effect is a reliable way to make a scene look like several unrelated
// effects stacked up.

/// Ashima-style simplex noise (public domain), 3D. Used for wind fields,
/// aurora curtains, smoke advection and any per-fragment surface break-up.
export const SIMPLEX3 = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/// Fractal sum. Detail at several scales at once is the difference between
/// a surface and a gradient.
export const FBM = /* glsl */ `
float fbm(vec3 p, int octaves, float lacunarity, float gain){
  float a = 0.5, sum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += a * snoise(p);
    p *= lacunarity;
    a *= gain;
  }
  return sum;
}
`;

/// Divergence-free 2D flow, sampled from the curl of a noise field. This
/// is what makes smoke and airborne particles swirl instead of drifting in
/// straight lines: a curl field has no sources or sinks, so particles
/// following it circulate the way air actually does.
export const CURL2 = /* glsl */ `
vec2 curl2(vec3 p){
  const float e = 0.1;
  float n1 = snoise(vec3(p.x, p.y + e, p.z));
  float n2 = snoise(vec3(p.x, p.y - e, p.z));
  float n3 = snoise(vec3(p.x + e, p.y, p.z));
  float n4 = snoise(vec3(p.x - e, p.y, p.z));
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}
`;

/// Cheap per-instance hash, for giving every instance its own constants
/// without an extra vertex attribute.
export const HASH = /* glsl */ `
float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec3 hash31(float p){
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
`;

/// sRGB <-> linear. Lighting has to be summed in linear space or every
/// overlap of two lights comes out too bright and chalky.
export const COLOR = /* glsl */ `
vec3 toLinear(vec3 c){ return pow(c, vec3(2.2)); }
vec3 toSRGB(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
/// Filmic-ish rolloff: keeps a bright bulb from clipping to a flat white
/// disc, which is the usual giveaway of an unmanaged HDR highlight.
vec3 tonemap(vec3 c){ return c / (c + vec3(0.85)) * 1.85; }
`;
