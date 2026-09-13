// Full-screen shader passes and the render targets they read and write.
//
// A pass is how anything that has to look at the whole frame gets done:
// the bright-pass and blur of the bloom chain, the atmospheric haze, the
// final tonemap. The geometry is a single oversized triangle rather than
// two triangles: it covers the viewport with no diagonal seam, so the GPU
// never shades the same pixel twice along the quad's split.

import { createProgram } from './gl.js';
import { COLOR } from './noise.glsl.js';

const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUV;
void main() {
  // Vertex 0,1,2 -> (-1,-1), (3,-1), (-1,3): one triangle covering the
  // clip volume, with UVs derived from the same numbers.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class ShaderPass {
  constructor(gl, fragmentSource, label = 'pass') {
    this.gl = gl;
    const built = createProgram(
      gl,
      FULLSCREEN_VS,
      `#version 300 es\nprecision highp float;\n${COLOR}\nin vec2 vUV;\nout vec4 outColor;\n${fragmentSource}`,
      label
    );
    this.program = built.program;
    this.uniforms = built.uniforms;
    this.vao = gl.createVertexArray(); // required: a VAO must be bound to draw
  }

  use() {
    this.gl.useProgram(this.program);
    this.gl.bindVertexArray(this.vao);
    return this.uniforms;
  }

  draw() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    this.gl.bindVertexArray(null);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}

/// A colour target, optionally with a depth buffer. Half-float where the
/// driver supports it so highlights can exceed 1.0 and the bloom chain has
/// something to work with; 8-bit otherwise, which still runs, just flatter.
export class RenderTarget {
  constructor(gl, width, height, { depth = false, float = true, filter } = {}) {
    this.gl = gl;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.float = float;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const internal = float ? gl.RGBA16F : gl.RGBA8;
    const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, gl.RGBA, type, null);
    const f = filter ?? gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);

    if (depth) {
      this.depthBuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.width, this.height);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer
      );
    }
    this.complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  bindTexture(unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    return unit;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.fbo);
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer);
  }
}
