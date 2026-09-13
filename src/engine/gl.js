// WebGL2 context creation and capability detection.
//
// The overlay is a TRANSPARENT, click-through window composited by the OS
// over the user's desktop, so `alpha: true` is not optional here and
// `premultipliedAlpha: true` is what the whole renderer's blend modes are
// written against: every shader outputs rgb already multiplied by a, which
// is the only form that composites correctly both inside the page and out
// through the window into the desktop behind it.
//
// Everything in this module is allowed to fail and say so. If WebGL2 is
// unavailable — old driver, blocklisted GPU, a webview that refuses a
// transparent GL surface — the caller falls back to the Canvas 2D
// renderer that already ships, rather than showing a black rectangle over
// somebody's desktop.

export const GL_ATTRS = {
  alpha: true,
  premultipliedAlpha: true,
  depth: true,
  stencil: false,
  antialias: false, // we render to our own float target and resolve there
  desynchronized: true,
  powerPreference: 'low-power', // this runs all day on battery
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false,
};

/// Returns { gl, caps } or null. Never throws: a missing GPU path is a
/// normal outcome that the caller handles, not an error.
export function createGL(canvas, overrides = {}) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { ...GL_ATTRS, ...overrides });
  } catch {
    return null;
  }
  if (!gl) return null;

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const caps = {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    // Half-float render targets are what let the bloom pass keep highlight
    // energy above 1.0 instead of clipping it to white; without them we
    // drop to 8-bit targets and a flatter glow.
    floatRenderTargets: !!gl.getExtension('EXT_color_buffer_float'),
    linearFloat: !!gl.getExtension('OES_texture_float_linear'),
    // A software rasteriser reports itself here; it works, but a bloom
    // chain on it is not something to enable by default.
    software: /swiftshader|llvmpipe|software|basic render/i.test(
      (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || ''
    ),
  };
  return { gl, caps };
}

/// Compiles and links a program, returning { program, uniforms } with every
/// active uniform's location resolved up front — looking locations up per
/// frame is a per-call string hash we have no reason to pay.
export function createProgram(gl, vertexSource, fragmentSource, label = 'program') {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vertexSource);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error(`${label} vertex shader:\n${gl.getShaderInfoLog(vs)}`);
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fragmentSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error(`${label} fragment shader:\n${gl.getShaderInfoLog(fs)}`);
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`${label} link:\n${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    // Array uniforms come back as "uLightPos[0]"; store them under the
    // bare name too so callers can write uniforms.uLightPos.
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

/// Uploads a canvas as an RGBA texture. Every texture in this engine is
/// generated procedurally into a canvas at startup rather than shipped as
/// an image file — it keeps the app fully offline and MIT-clean, and it
/// means textures can be regenerated at the display's DPI.
export function textureFromCanvas(gl, canvas, { mips = true, wrap } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const clamp = wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clamp);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, clamp);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mips) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/// Blend modes, named for what they mean rather than for their factors.
/// All of them assume premultiplied source colour.
export const Blend = {
  /// Ordinary "over" compositing for premultiplied colour.
  over(gl) {
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  },
  /// Light adding to light. Alpha adds too, so a glow drawn over the
  /// transparent overlay also makes that part of the window opaque —
  /// which is what "light in front of the desktop" should look like.
  add(gl) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  },
  none(gl) {
    gl.disable(gl.BLEND);
  },
};
