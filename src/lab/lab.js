// Scene lab: a standalone harness for developing and testing one layer at
// a time, outside the Tauri shell.
//
// It exists because the production overlay is a native transparent window
// Playwright cannot attach to, while everything interesting — the
// geometry, the lighting, the animation, the frame cost — lives in code
// that runs perfectly well as an ordinary page. This is the same split the
// Canvas 2D renderer already used, kept deliberately, so the new engine is
// testable from day one instead of only observable by running the app.
//
// Query parameters:
//   ?bg=none      transparent background, to inspect premultiplied output
//   ?quality=low  force the no-bloom tier (what a software GPU gets)
//   ?fps=60       cap the frame rate
//   ?wind=0       freeze the wind, for stable screenshots
//   ?hud=0        hide the readout, for screenshots
//   ?readback=1   keep the drawing buffer, so tests can read real pixels

import { Renderer } from '../engine/renderer.js';
import { Scene } from '../engine/scene.js';
import { ChristmasTree } from '../layers/ChristmasTree.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('scene');
const hud = document.getElementById('hud');

if (params.get('bg') === 'none') document.body.classList.remove('wallpaper');
if (params.get('hud') === '0') hud.classList.add('hidden');

const renderer = new Renderer(canvas, {
  quality: params.get('quality') ?? undefined,
  fpsLimit: Number(params.get('fps')) || 0,
  glOverrides: params.get('readback') === '1' ? { preserveDrawingBuffer: true } : undefined,
});

if (!renderer.supported) {
  hud.textContent = 'WebGL2 unavailable — the app would fall back to the Canvas 2D renderer here.';
  window.sceneLab = { supported: false };
} else {
  const scene = new Scene('WinterNightScene');
  const tree = new ChristmasTree({
    heightFraction: 0.72,
    anchor: [0.5, 0.03],
    wind: params.has('wind') ? Number(params.get('wind')) : 1,
  });
  scene.add(tree);

  renderer.onStats = (s) => {
    if (hud.classList.contains('hidden')) return;
    hud.textContent =
      `${s.fps} fps · ${s.cpuMs} ms CPU/frame\n` +
      `quality ${s.quality} · ${s.draws} draws\n` +
      `${tree.instanceCount ?? 0} sprig instances\n` +
      `${s.renderer}`;
  };

  // Exposed for Playwright and for poking at the scene from a console.
  window.sceneLab = {
    supported: true,
    renderer,
    scene,
    tree,
    getStats: () => renderer.stats,
    setEnabled: (id, on) => scene.setEnabled(id, on),
    setFpsLimit: (n) => renderer.setFpsLimit(n),
    setWind: (w) => { tree.opts.wind = w; },
    getInstanceCount: () => tree.instanceCount ?? 0,
    /// Reads one composited pixel, alpha included. Coordinates are in CSS
    /// pixels from the TOP-left, like the DOM; WebGL reads from the
    /// bottom, so the y flip happens here rather than in every test.
    /// Requires ?readback=1.
    readPixel(x, y) {
      const gl = renderer.gl;
      const px = Math.round(x * renderer.dpr);
      const py = Math.round(renderer.height - y * renderer.dpr);
      const out = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return Array.from(out);
    },
  };

  window.sceneLabReady = (async () => {
    await renderer.setScene(scene);
    renderer.start();
    hud.textContent = 'running…';
  })().catch((err) => {
    // A shader that fails to compile must say so loudly here rather than
    // leaving a blank canvas to puzzle over.
    hud.textContent = `FAILED: ${err.message}`;
    console.error(err);
    throw err;
  });
}
