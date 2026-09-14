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
import { Wind } from './wind.js';

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
uniform float uSaturation;
uniform vec2 uInvResolution;
void main() {
  vec4 scene = texture(uScene, vUV);
  vec4 bloom = texture(uBloom, vUV) * uBloomStrength;
  vec3 lit = (scene.rgb + bloom.rgb) * uExposure;
  lit = tonemap(lit);
  // Saturation is applied AFTER the tonemap, where the values are the
  // ones the eye will actually see: pushing it before the curve just
  // moves highlights around and desaturates them again on the way out.
  float luma = dot(lit, vec3(0.2126, 0.7152, 0.0722));
  lit = mix(vec3(luma), lit, uSaturation);
  // An ordered dither of well under one 8-bit step. Night skies and the
  // wide soft falloff of a bloom are exactly the content that bands on
  // an 8-bit surface, and a sub-LSB dither is what removes the rings
  // without being visible as noise.
  vec2 px = vUV / max(uInvResolution, vec2(1e-6));
  float dither = fract(sin(dot(floor(px), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  lit += dither * (0.6 / 255.0);
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
    this.wind = new Wind(options.wind);
    this.rig = new LightRig();
    this.scene = null;

    // A software rasteriser runs this correctly but slowly, so it gets the
    // cheap tier by default rather than a bloom chain it cannot afford.
    this.quality = options.quality ?? (this.caps.software ? 'low' : 'high');
    // A software rasteriser can take hundreds of milliseconds per frame.
    // Left uncapped it does not merely run slowly — it saturates the main
    // thread and starves everything else on the page, including the
    // Canvas 2D renderer drawing the rest of the scene. Capping it is both
    // the correct behaviour for a machine with no usable GPU (a wallpaper
    // animation has no business eating a core) and what makes the engine
    // observable at all in a container with no GPU.
    this.maxDpr = options.maxDpr ?? (this.caps.software ? 1 : 1.75);
    this.fpsLimit = options.fpsLimit ?? (this.caps.software ? 20 : 0);
    // The internal render resolution as a fraction of the canvas's own
    // (already DPR-clamped) size: the scene and bloom targets are drawn
    // at `canvasSize * renderScale`, then the composite pass — sampling
    // them through a LINEAR filter — upscales to the full canvas when it
    // writes the final frame. This is the automatic-degrade knob for the
    // GPU path (see shared/perf.js): stepping it down trades resolution,
    // not frame rate, for headroom, which reads as a slightly softer
    // scene rather than stutter. 1 = full resolution, unchanged from
    // before this existed.
    this.renderScale = Math.min(1, Math.max(0.35, options.renderScale ?? 1));
    this.bloomStrength = options.bloomStrength ?? 0.85;
    this.exposure = options.exposure ?? 1.0;
    this.saturation = options.saturation ?? 1.0;
    this.ambientWarmth = 1;
    this.fireplaceContribution = 1;
    this.fireplaces = [];

    this.time = 0;
    this.lastFrameAt = 0;
    this.lastTick = 0;
    // The smoothed frame interval the simulation is advanced by. Vsync
    // delivers rAF timestamps that jitter by a millisecond or two even
    // when nothing is dropping frames, and feeding that raw jitter into
    // a position integrator is precisely what reads as micro-stutter on
    // a slow, smooth motion like a drifting camera or a swaying branch.
    this.smoothDt = 1 / 60;
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
    const requested = Number(limit) || 0;
    // A user cap can only ever lower the software ceiling, never raise it.
    this.fpsLimit = this.caps.software
      ? (requested > 0 ? Math.min(requested, 20) : 20)
      : requested;
    // Re-phase rather than carry a stale deadline: without this, raising
    // the cap mid-session waits out the OLD period once before the first
    // faster frame, which is felt as a hitch exactly at the moment the
    // user expected things to get smoother.
    this.lastFrameAt = 0;
  }

  /// Grade controls. All three are per-frame uniforms on the composite
  /// pass, so they are free to change every frame and never trigger a
  /// resize or a reallocation — which is what makes them safe to drive
  /// straight from a settings slider.
  setGrade({ exposure, bloomStrength, saturation } = {}) {
    if (exposure !== undefined) this.exposure = Math.max(0.2, Math.min(2.5, Number(exposure) || 1));
    if (bloomStrength !== undefined) {
      this.bloomStrength = Math.max(0, Math.min(2.5, Number(bloomStrength) || 0));
    }
    if (saturation !== undefined) {
      this.saturation = Math.max(0, Math.min(2, Number(saturation) || 1));
    }
  }

  /// Lighting rig controls are uniforms and a small fixed light list, so
  /// they remain safe to adjust continuously from the settings window.
  setLightingRig({ ambientWarmth, fireplaceContribution, fireplaces } = {}) {
    if (ambientWarmth !== undefined) this.ambientWarmth = Math.max(0, Math.min(2, Number(ambientWarmth) || 0));
    if (fireplaceContribution !== undefined) {
      this.fireplaceContribution = Math.max(0, Math.min(2, Number(fireplaceContribution) || 0));
    }
    if (fireplaces !== undefined) this.fireplaces = fireplaces ?? [];
  }

  setWind(opts) {
    this.wind.set(opts);
  }

  setCameraMotion(amount) {
    this.camera.setMotion(amount);
  }

  /// Called by the automatic quality governor, never directly by user
  /// settings — this is the "reduce internal resolution" lever from the
  /// perf budget, distinct from the DPR cap and the fps cap. A no-op
  /// resize is skipped so a governor sampling every frame doesn't
  /// reallocate render targets it isn't actually changing.
  setRenderScale(scale) {
    const clamped = Math.min(1, Math.max(0.35, Number(scale) || 1));
    if (clamped === this.renderScale) return;
    this.renderScale = clamped;
    this.resize();
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

    // Scene/bloom render targets are sized off the RENDER scale, not the
    // canvas: they can be smaller than the final framebuffer. The final
    // composite pass (below, in frame()) still draws at the full w/h —
    // it's a linear-filtered upscale of these, not a smaller picture.
    const iw = Math.max(1, Math.round(w * this.renderScale));
    const ih = Math.max(1, Math.round(h * this.renderScale));
    this.internalWidth = iw;
    this.internalHeight = ih;

    for (const t of [this.sceneTarget, this.bloomA, this.bloomB]) t?.dispose();
    const float = this.quality !== 'low' && this.caps.floatRenderTargets;
    this.sceneTarget = new RenderTarget(gl, iw, ih, { depth: true, float });
    if (this.quality === 'low') {
      this.bloomA = null;
      this.bloomB = null;
    } else {
      // Quarter resolution: bloom is a low-frequency signal by definition,
      // so blurring it at full resolution is four times the bandwidth for
      // a result nobody can distinguish.
      const bw = Math.max(1, iw >> 2);
      const bh = Math.max(1, ih >> 2);
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
      if (this.fpsLimit > 0) {
        const period = 1000 / this.fpsLimit;
        // Advance the DEADLINE by exactly one period rather than resetting
        // it to `now`. Snapping to `now` quantises every frame up to the
        // next display refresh and then starts the next period from there,
        // so a 30 fps cap on a 120 Hz panel drifts to ~26 and the interval
        // alternates 33/42 ms — visible as a limp in any steady motion.
        // Half a refresh of tolerance lets a frame that arrives a hair
        // early still count, instead of being pushed a whole refresh late.
        if (now < this.lastFrameAt + period - 1.0) return;
        this.lastFrameAt = this.lastFrameAt + period;
        // If we fell more than a period behind (a stall, a hidden window,
        // a cap that just changed) the deadline is stale and catching it
        // up would burst several frames back to back. Re-phase to now.
        if (now - this.lastFrameAt > period) this.lastFrameAt = now;
      }
      // Clamped: a hidden window or a sleeping display produces a dt of
      // seconds, which would teleport every particle in one step.
      const raw = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
      this.lastTick = now;
      // Smoothed for the simulation, but only while the interval is
      // stable: a genuine change of pace (the cap moved, the machine is
      // struggling) must be followed immediately, or the scene would run
      // in slow motion for a second every time the frame rate changes.
      this.smoothDt = Math.abs(raw - this.smoothDt) > this.smoothDt * 0.5
        ? raw
        : this.smoothDt + (raw - this.smoothDt) * 0.2;
      const dt = this.smoothDt;
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

    this.camera.update(this.time, dt);
    this.wind.update(dt, this.time);
    this.rig.clear();
    const warmth = this.ambientWarmth;
    this.rig.ambientSky = [0.04 + 0.015 * warmth, 0.06 + 0.022 * warmth, 0.16 - 0.015 * warmth];
    this.rig.ambientGround = [0.012 + 0.004 * warmth, 0.014 + 0.005 * warmth, 0.034 - 0.006 * warmth];

    const ctx = {
      gl,
      renderer: this,
      camera: this.camera,
      wind: this.wind,
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
    for (const fireplace of this.fireplaces) {
      this.rig.add(
        (fireplace.x ?? 0.5) * this.width, this.height * 0.16, 0.5,
        [1, 0.28, 0.07], 2.4 * this.fireplaceContribution, Math.min(this.width, this.height) * 0.42
      );
    }

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
    gl.uniform1f(u.uSaturation, this.saturation);
    gl.uniform2f(u.uInvResolution, 1 / this.width, 1 / this.height);
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
