// The production bridge between the scene composition and the WebGL engine.
//
// The engine renders the trees and — once adopted — the aurora; the
// Canvas 2D renderer keeps the stars, snow, garlands and fireplaces.
// That split is deliberate rather than a staging post: the tree needed a
// GPU for volume, self-occlusion, per-needle lighting and vertex-stage
// wind; the aurora benefits from the GPU for the bloom pipeline
// (BRIGHT_PASS/BLUR_PASS) a real light source deserves. A snowfield of
// soft sprites and a baked fireplace were never the problem — porting
// those too would cost a rewrite and buy nothing visible.
//
// Everything here is failure-tolerant by design. A missing WebGL2, a
// blocklisted driver, a shader that will not compile on some GPU: all of
// them end with `start()`/`sync()` returning false, and the overlay then
// draws BOTH the trees and the aurora in Canvas 2D exactly as before —
// one scene, one first-frame gate, so a failure anywhere in it falls all
// the way back rather than adopting half a scene. The user sees a
// slightly simpler picture, never a black rectangle over their desktop.

import { Renderer } from '../engine/renderer.js';
import { Scene } from '../engine/scene.js';
import { ChristmasTree } from '../layers/ChristmasTree.js';
import { NorthernLights } from '../layers/NorthernLights.js';
import {
  TREE_STYLES, resolvePalette, resolveNeedles, resolveFrost, defaultLook, resolveCameraMotionProfile,
} from '../shared/scene.js';

/// Maps one scene tree spec onto the layer's options. The scene is the
/// only source of truth: the same spec drives the Canvas 2D tree, so
/// switching renderer changes the fidelity and nothing else.
function layerOptionsFor(tree, index, themeColors, look = {}) {
  const style = TREE_STYLES[tree.style] ?? TREE_STYLES.nordmann;
  const palette = resolvePalette(tree.lights);
  const needles = resolveNeedles(tree);
  return {
    id: `tree-${tree.id ?? index}`,
    z: 0.5 + index * 0.001, // stable draw order, no two layers equal
    anchor: [tree.x ?? 0.5, 0.0],
    // The Canvas 2D tree is sized as a fraction of the window; matching
    // that here keeps a composition looking the same in both renderers.
    heightFraction: Math.max(0.15, Math.min(1.1, 0.62 * (tree.scale ?? 1))),
    seed: tree.seed ?? 1337,
    flip: !!tree.flip,
    styleWidth: style.width,
    styleDensity: style.density,
    snowAmount: (tree.snow ?? 1) * (style.snow ?? 1),
    frost: resolveFrost(tree),
    sway: tree.sway ?? 1,
    star: tree.star !== false,
    starSize: tree.starSize ?? 1,
    starColor: tree.starColor ?? '#fff0c2',
    ribbon: tree.ribbon !== false,
    ribbonColor: tree.ribbonColor ?? themeColors.primary,
    ribbonWidth: tree.ribbonWidth ?? 1,
    ribbonTurns: tree.ribbonTurns ?? 4,
    lightsOn: tree.lightsOn !== false,
    bulbCount: Math.round(96 * (tree.lights?.size ? 1 : 1)),
    bulbColors: palette,
    bulbSize: tree.lights?.size ?? 1,
    lightMode: tree.lights?.mode ?? 'twinkle',
    lightSpeed: tree.lights?.speed ?? 1,
    lightIntensity: tree.lights?.intensity ?? 1,
    ornamentCount: Math.round(38 * (tree.ornaments ?? 1)),
    ornamentGloss: tree.ornamentGloss ?? 1,
    ornamentColors: [
      themeColors.primary, themeColors.accent, '#e9edf2', '#8fb7d8',
      themeColors.primary,
    ],
    shadowStrength: look.shadowStrength ?? 1,
    shadowSoftness: look.shadowSoftness ?? 1,
    needleDark: needles.dark,
    needleLight: needles.light,
    wind: 1,
  };
}

export class GlTrees {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.signature = '';
    this.failed = false;
    this.reason = null;
    // The automatic quality governor's current level for the aurora ray
    // count (see src/shared/perf.js): kept here, not just on the layer,
    // because `sync()` below rebuilds the Scene (and therefore a fresh
    // NorthernLights instance) whenever the composition changes — this
    // is what gets re-applied to that fresh instance so a mid-session
    // composition change doesn't silently reset the aurora back to full
    // detail while the machine is still under load.
    this.auroraDetail = 1;
  }

  get supported() {
    return !!this.renderer?.supported;
  }

  /// Brings the engine up. Returns false — without throwing — for every
  /// reason it might not be usable, because the caller's response to all
  /// of them is the same: keep the Canvas 2D trees.
  start(options = {}) {
    if (this.failed) return false;
    try {
      this.renderer = new Renderer(this.canvas, {
        fpsLimit: options.fpsLimit ?? 0,
        quality: options.quality,
      });
      if (!this.renderer.supported) {
        this.failed = true;
        this.reason = 'WebGL2 unavailable';
        return false;
      }
      // A SOFTWARE RASTERISER IS NOT AN UPGRADE.
      //
      // SwiftShader, llvmpipe and friends will happily hand out a WebGL2
      // context and then take hundreds of milliseconds per frame — slower
      // than the Canvas 2D tree AND, with the bloom chain off, no better
      // looking. Worse, an uncapped GL loop on a software rasteriser
      // saturates the main thread and starves the Canvas 2D renderer
      // drawing the rest of the scene, so adopting it makes the WHOLE
      // overlay worse, not just the trees.
      //
      // So the default is: hardware GPU or nothing. `allowSoftware` exists
      // for the lab and the test harness, which need to exercise the
      // engine on machines that have no GPU at all.
      if (this.renderer.caps.software && !options.allowSoftware) {
        this.failed = true;
        this.reason = `software rasteriser (${this.renderer.caps.renderer})`;
        this.renderer.dispose();
        this.renderer = null;
        return false;
      }
      this.scene = new Scene('OverlayTrees');
      return true;
    } catch (err) {
      console.warn('WebGL tree renderer could not start; keeping Canvas 2D:', err);
      this.failed = true;
      this.reason = String(err?.message ?? err);
      return false;
    }
  }

  /// Rebuilds the layer set when the composition changes. Cheap to call:
  /// it compares a signature first and does nothing if nothing that
  /// matters changed, so it can be wired straight to every settings save.
  async sync(sceneCfg, themeColors) {
    if (!this.renderer?.supported || this.failed) return false;
    // The grade, the weather and the camera are per-frame uniforms, so
    // they are applied on EVERY sync, before the signature check bails
    // out: dragging an exposure slider must take effect immediately and
    // must never rebuild the layer set to do it.
    this.applyLook(sceneCfg.look, sceneCfg.fireplaces);

    const trees = sceneCfg.trees ?? [];
    const aurora = !!sceneCfg.aurora;
    const auroraGain = sceneCfg.auroraIntensity ?? 1;
    const auroraPalette = sceneCfg.auroraPalette ?? 'classic';
    const signature = JSON.stringify(trees) + JSON.stringify(themeColors)
      + `|aurora:${aurora}:${auroraGain}:${auroraPalette}`;
    if (signature === this.signature) return true;
    this.signature = signature;

    try {
      const scene = new Scene('OverlayTrees');
      trees.forEach((tree, i) => {
        scene.add(new ChristmasTree(layerOptionsFor(tree, i, themeColors, sceneCfg.look)));
      });
      if (aurora) {
        const lights = new NorthernLights({ gain: auroraGain, palette: auroraPalette });
        // Re-apply whatever detail level the governor last decided —
        // otherwise a composition change mid-session (adding a tree,
        // changing a colour) would silently undo a degrade that is still
        // warranted.
        lights.setDetail(this.auroraDetail);
        scene.add(lights);
      }
      await this.renderer.setScene(scene);
      this.scene = scene;
      return true;
    } catch (err) {
      // A shader that fails to compile fails here, on a real GPU we have
      // never seen. Fall back rather than leave the overlay broken.
      console.warn('WebGL tree scene failed to build; falling back to Canvas 2D:', err);
      this.failed = true;
      this.stop();
      return false;
    }
  }

  setFpsLimit(limit) {
    this.renderer?.setFpsLimit(limit);
  }

  /// Applies the scene's global look. Cheap enough to call every frame;
  /// in practice it is called on every settings save.
  applyLook(look, fireplaces) {
    if (!this.renderer) return;
    const l = { ...defaultLook(), ...(look ?? {}) };
    this.renderer.setGrade({
      exposure: l.exposure,
      bloomStrength: l.bloom,
      saturation: l.saturation,
    });
    this.renderer.setLightingRig({
      ambientWarmth: l.ambientWarmth,
      fireplaceContribution: l.fireplaceContribution,
      fireplaces,
    });
    this.renderer.setWind({
      strength: l.windStrength,
      gustiness: l.windGustiness,
      direction: l.windDirection,
    });
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.renderer.setCameraMotion(l.cameraMotion * resolveCameraMotionProfile(l.cameraMotionProfile, reducedMotion));
  }

  /// The GPU half of the automatic quality governor (src/shared/perf.js):
  /// a lower internal render resolution under sustained load, upscaled
  /// back to the window's full size by the existing composite pass. A
  /// no-op before `start()` has actually created a renderer — harmless,
  /// since the governor re-applies its current tier once adoption
  /// finishes.
  setRenderScale(scale) {
    this.renderer?.setRenderScale(scale);
  }

  /// The other GPU half of the governor: how many of the aurora's rays to
  /// actually draw (see NorthernLights' module header for why this is
  /// safe to change every frame — it's a draw count, not a rebuild).
  /// Stored even when the layer doesn't currently exist (aurora off, or
  /// the engine hasn't adopted yet) so it applies the moment it does.
  setAuroraDetail(fraction) {
    this.auroraDetail = Math.max(0, Math.min(1, Number(fraction) || 0));
    this.scene?.get('northern-lights')?.setDetail(this.auroraDetail);
  }

  run() {
    this.renderer?.start();
  }

  stop() {
    this.renderer?.stop();
  }

  get stats() {
    return this.renderer?.stats ?? null;
  }

  dispose() {
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
  }
}
