// The production bridge between the scene composition and the WebGL engine.
//
// The engine renders the trees; the Canvas 2D renderer keeps the sky,
// snow, garlands and fireplaces. That split is deliberate rather than a
// staging post: the tree is the element that actually needed a GPU —
// volume, self-occlusion, per-needle lighting and vertex-stage wind are
// the things Canvas 2D structurally cannot do — while a snowfield of soft
// sprites and a baked fireplace were never the problem. Porting those too
// would cost a rewrite and buy nothing visible.
//
// Everything here is failure-tolerant by design. A missing WebGL2, a
// blocklisted driver, a shader that will not compile on some GPU: all of
// them end with `start()` returning false, and the overlay then draws its
// trees in Canvas 2D exactly as before. The user sees a slightly simpler
// tree, never a black rectangle over their desktop.

import { Renderer } from '../engine/renderer.js';
import { Scene } from '../engine/scene.js';
import { ChristmasTree } from '../layers/ChristmasTree.js';
import { TREE_STYLES, resolvePalette } from '../shared/scene.js';

/// Maps one scene tree spec onto the layer's options. The scene is the
/// only source of truth: the same spec drives the Canvas 2D tree, so
/// switching renderer changes the fidelity and nothing else.
function layerOptionsFor(tree, index, themeColors) {
  const style = TREE_STYLES[tree.style] ?? TREE_STYLES.nordmann;
  const palette = resolvePalette(tree.lights);
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
    star: tree.star !== false,
    lightsOn: tree.lightsOn !== false,
    bulbCount: Math.round(96 * (tree.lights?.size ? 1 : 1)),
    bulbColors: palette,
    bulbSize: tree.lights?.size ?? 1,
    lightMode: tree.lights?.mode ?? 'twinkle',
    lightSpeed: tree.lights?.speed ?? 1,
    lightIntensity: tree.lights?.intensity ?? 1,
    ornamentCount: Math.round(38 * (tree.ornaments ?? 1)),
    ornamentColors: [
      themeColors.primary, themeColors.accent, '#e9edf2', '#8fb7d8',
      themeColors.primary,
    ],
    needleDark: '#0c2013',
    needleLight: '#3c6b2b',
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
  /// it compares a signature first and does nothing if the trees are the
  /// same, so it can be wired straight to every settings save.
  async sync(sceneCfg, themeColors) {
    if (!this.renderer?.supported || this.failed) return false;
    const trees = sceneCfg.trees ?? [];
    const signature = JSON.stringify(trees) + JSON.stringify(themeColors);
    if (signature === this.signature) return true;
    this.signature = signature;

    try {
      const scene = new Scene('OverlayTrees');
      trees.forEach((tree, i) => {
        scene.add(new ChristmasTree(layerOptionsFor(tree, i, themeColors)));
      });
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

  /// The GPU half of the automatic quality governor (src/shared/perf.js):
  /// a lower internal render resolution under sustained load, upscaled
  /// back to the window's full size by the existing composite pass. A
  /// no-op before `start()` has actually created a renderer — harmless,
  /// since the governor re-applies its current tier once adoption
  /// finishes.
  setRenderScale(scale) {
    this.renderer?.setRenderScale(scale);
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
