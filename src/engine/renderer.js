// Frame loop, render targets and the post chain.
//
// SCENE SPACE. Everything a layer places — geometry, particles, lights —
// is expressed in scene pixels: x to the right, **y upward from the bottom
// of the frame**, z toward the viewer. One consistent space means a layer
// can position a light without knowing the resolution, the device pixel
// ratio or where the camera is, and the same number means the same thing
// in every shader.
//
// THE POST CHAIN is not decoration. Lights are the subject of this app,
// and a light only reads as a light when it blooms — the bright core
// bleeding into its surroundings is most of what the eye uses to judge
// "that is emitting" rather than "that is a pale shape". It is rendered
// once for the whole frame rather than faked per element, so every light
// in every layer gets the same treatment for the same cost.

import { createGL, Blend } from './gl.js';
import { ShaderPass, RenderTarget } from './pass.js';
import { LightRig } from './lighting.js';
import { Camera } from './camera.js';

const BRIGHT_PASS = /* glsl */ `
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec4 c = texture(uScene, vUV);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee: a hard threshold makes bloom pop on and off as something
  // crosses it, which is very visible on a flickering flame.
  float w = clamp((lum - uThreshold + uKnee) / max(2.0 * uKnee, 1e-4), 0.0, 1.0);
  w = w * w * (lum > uThreshold - uKnee ? 1.0 : 0.0);
  outColor = vec4(c.rgb * w, c.a * w);
}`;

const BLUR_PASS = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uDirection; // texel-sized step, horizontal or vertical
void main() {
  // 9-tap gaussian folded into 5 bilinear samples.
  vec4 sum = texture(uSource, vUV) * 0.227027;
  vec2 o1 = uDirection * 1.3846153846;
  vec2 o2 = uDirection * 3.2307692308;
  sum += (texture(uSource, vUV + o1) + texture(uSource, vUV - o1)) * 0.3162162162;
  sum += (texture(uSource, vUV + o2) + texture(uSource, vUV - o2)) * 0.0702702703;
  outColor = sum;
}`;

const COMPOSITE_PASS = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
void main() {
  vec4 scene = texture(uScene, vUV);
  vec4 bloom = texture(uBloom, vUV) * uBloomStrength;
  vec3 lit = (scene.rgb + bloom.rgb) * uExposure;
  lit = tonemap(lit);
  // Alpha carries through so the window stays transparent where nothing
  // was drawn; bloom contributes opacity, because light spilling in front
  // of the desktop should actually cover it.
  float a = clamp(scene.a + bloom.a * uBloomStrength, 0.0, 1.0);
  // Output stays premultiplied: that is what the compositor expects, and
  // it is what makes a half-lit edge blend correctly over the wallpaper.
  outColor = vec4(toSRGB(lit) * a, a);
}`;

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    // glOverrides exists for the test harness: `preserveDrawingBuffer`
    // keeps the composited frame readable after the draw call, which is
    // the only way a test can assert on the ACTUAL output pixels —
    // including the alpha channel the transparent overlay window depends
    // on. It costs a copy per frame, so it is never on in the app.
    const created = createGL(canvas, options.glOverrides);
    if (!created) {
      this.supported = false;
      return;
    }
    this.supported = true;
    this.gl = created.gl;
    this.caps = created.caps;

    this.camera = new Camera(options.camera);
    this.rig = new LightRig();
    this.scene = null;

    // A software rasteriser runs this correctly but slowly, so it gets the
    // cheap tier by default rather than a bloom chain it cannot afford.
    this.quality = options.quality ?? (this.caps.software ? 'low' : 'high');
    this.maxDpr = options.maxDpr ?? 1.75;
    this.fpsLimit = options.fpsLimit ?? 0;
    this.bloomStrength = options.bloomStrength ?? 0.85;
    this.exposure = options.exposure ?? 1.0;

    this.time = 0;
    this.lastFrameAt = 0;
    this.lastTick = 0;
    this.running = false;
    this.rafId = null;
    this._stats = { fps: 0, cpuMs: 0, frames: 0, accum: 0, since: 0, draws: 0 };

    this.bright = new ShaderPass(this.gl, BRIGHT_PASS, 'bright');
    this.blur = new ShaderPass(this.gl, BLUR_PASS, 'blur');
    this.composite = new ShaderPass(this.gl, COMPOSITE_PASS, 'composite');

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  get stats() {
    return {
      fps: this._stats.fps,
      cpuMs: this._stats.cpuMs,
      draws: this._stats.draws,
      renderer: this.caps?.renderer ?? 'none',
      quality: this.quality,
    };
  }

  setQuality(quality) {
    if (quality === this.quality) return;
    this.quality = quality;
    this.resize();
  }

  setFpsLimit(limit) {
    this.fpsLimit = Number(limit) || 0;
  }

  resize() {
    const gl = this.gl;
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${window.innerWidth}px`;
      this.canvas.style.height = `${window.innerHeight}px`;
    }
    this.width = w;
    this.height = h;
    this.dpr = dpr;

    for (const t of [this.sceneTarget, this.bloomA, this.bloomB]) t?.dispose();
    const float = this.quality !== 'low' && this.caps.floatRenderTargets;
    this.sceneTarget = new RenderTarget(gl, w, h, { depth: true, float });
    if (this.quality === 'low') {
      this.bloomA = null;
      this.bloomB = null;
    } else {
      // Quarter resolution: bloom is a low-frequency signal by definition,
      // so blurring it at full resolution is four times the bandwidth for
      // a result nobody can distinguish.
      const bw = Math.max(1, w >> 2);
      const bh = Math.max(1, h >> 2);
      this.bloomA = new RenderTarget(gl, bw, bh, { float });
      this.bloomB = new RenderTarget(gl, bw, bh, { float });
    }
    this.scene?.resize?.(this);
  }

  async setScene(scene) {
    this.scene?.dispose();
    this.scene = scene;
    await scene.init(this);
  }

  start() {
    if (this.running || !this.supported) return;
    this.running = true;
    this.lastTick = performance.now();
    const tick = (now) => {
      this.rafId = requestAnimationFrame(tick);
      if (!this.running) return;
      if (this.fpsLimit > 0 && now - this.lastFrameAt < 1000 / this.fpsLimit - 0.5) return;
      this.lastFrameAt = now;
      // Clamped: a hidden window or a sleeping display produces a dt of
      // seconds, which would teleport every particle in one step.
      const dt = Math.min(0.05, (now - this.lastTick) / 1000);
      this.lastTick = now;
      this.time += dt;
      this.frame(dt, now);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  frame(dt, now) {
    const gl = this.gl;
    const t0 = performance.now();

    this.camera.update(this.time);
    this.rig.clear();

    const ctx = {
      gl,
      renderer: this,
      camera: this.camera,
      rig: this.rig,
      time: this.time,
      dt,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      draws: 0,
    };

    this.scene?.update(dt, this.time, ctx);
    this.scene?.contributeLights(this.rig, this.time);

    // --- scene pass ---------------------------------------------------
    this.sceneTarget.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    Blend.over(gl);
    this.scene?.render(ctx);

    // --- bloom --------------------------------------------------------
    gl.disable(gl.DEPTH_TEST);
    Blend.none(gl);
    if (this.bloomA) {
      this.bloomA.bind();
      let u = this.bright.use();
      gl.uniform1i(u.uScene, this.sceneTarget.bindTexture(0));
      gl.uniform1f(u.uThreshold, 0.62);
      gl.uniform1f(u.uKnee, 0.28);
      this.bright.draw();

      // Two separable passes at increasing radius approximate a much wider
      // kernel than either alone, for four texture fetches each.
      for (let i = 0; i < 2; i++) {
        const radius = 1 + i * 2;
        this.bloomB.bind();
        u = this.blur.use();
        gl.uniform1i(u.uSource, this.bloomA.bindTexture(0));
        gl.uniform2f(u.uDirection, radius / this.bloomA.width, 0);
        this.blur.draw();

        this.bloomA.bind();
        u = this.blur.use();
        gl.uniform1i(u.uSource, this.bloomB.bindTexture(0));
        gl.uniform2f(u.uDirection, 0, radius / this.bloomB.height);
        this.blur.draw();
      }
    }

    // --- composite to the visible framebuffer --------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.composite.use();
    gl.uniform1i(u.uScene, this.sceneTarget.bindTexture(0));
    gl.uniform1i(u.uBloom, this.bloomA ? this.bloomA.bindTexture(1) : this.sceneTarget.bindTexture(1));
    gl.uniform1f(u.uBloomStrength, this.bloomA ? this.bloomStrength : 0);
    gl.uniform1f(u.uExposure, this.exposure);
    this.composite.draw();

    // --- stats ---------------------------------------------------------
    const s = this._stats;
    s.frames++;
    s.accum += performance.now() - t0;
    s.draws = ctx.draws;
    if (s.since === 0) s.since = now;
    else if (now - s.since >= 500) {
      s.fps = Math.round((s.frames * 1000) / (now - s.since));
      s.cpuMs = Math.round((s.accum / s.frames) * 100) / 100;
      s.frames = 0;
      s.accum = 0;
      s.since = now;
      this.onStats?.(this.stats);
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.scene?.dispose();
    this.sceneTarget?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.bright?.dispose();
    this.blur?.dispose();
    this.composite?.dispose();
  }
}
