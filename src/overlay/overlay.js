// Overlay bootstrap: decides which renderer draws the trees, and keeps
// the two in step.
//
// The rule it enforces is the one that matters for something that sits
// over somebody's desktop all day: the WebGL path is only adopted once it
// has DEMONSTRABLY produced a frame. Creating a context succeeds on
// plenty of machines where the first real draw then fails — a blocklisted
// driver, a shader the compiler rejects, a webview that will not
// composite a transparent GL surface. Adopting on "the context exists"
// is how an app ends up showing a black rectangle instead of a desktop.
//
// So: start the engine hidden, let it render, read a pixel back, and only
// then hand it the trees and reveal its canvas. Otherwise the Canvas 2D
// renderer keeps them and nothing about the overlay changes.

import './snow.js';
import { GlTrees } from './gl-trees.js';
import { getSettings } from '../shared/bridge.js';

const glCanvas = document.getElementById('snow-gl');
const overlay = window.snowOverlay;

/// Reads the engine's own canvas to confirm it actually drew something.
/// `preserveDrawingBuffer` is off in production, so this asks the layer
/// for its instance count instead — cheap, and it fails exactly when the
/// geometry or the shaders did.
function producedGeometry(gl) {
  const layers = gl.scene?.layers ?? [];
  if (!layers.length) return false;
  return layers.every((l) => l.ready && (l.instanceCount ?? 0) > 0);
}

async function boot() {
  // `renderer` is a user preference: 'auto' adopts the engine only on a
  // real GPU, 'webgl' forces it even on a software rasteriser, 'canvas'
  // never uses it. The query parameter overrides it, which is how the
  // test harness drives both paths on one machine.
  await window.snowOverlayReady;
  const params = new URLSearchParams(location.search);
  const stored = await getSettings().catch(() => ({}));
  const preference = params.get('renderer') ?? stored?.renderer ?? 'auto';

  const settings = { fpsLimit: stored?.fpsLimit ?? 0 };
  const glTrees = new GlTrees(glCanvas);

  if (preference === 'canvas') {
    window.overlayRenderer = { mode: 'canvas2d', reason: 'renderer set to Canvas 2D' };
    return;
  }

  // The engine and the Canvas 2D renderer read the SAME composition, so
  // switching between them changes fidelity and nothing else.
  let latestScene = null;
  let latestTheme = { primary: '#c0392b', secondary: '#1e7d32', accent: '#f1c40f' };
  let adopted = false;

  overlay.onSceneChanged((sceneCfg, appSettings) => {
    latestScene = sceneCfg;
    if (appSettings?.themeColors) latestTheme = appSettings.themeColors;
    if (appSettings?.fpsLimit !== undefined) {
      settings.fpsLimit = appSettings.fpsLimit;
      glTrees.setFpsLimit(appSettings.fpsLimit);
    }
    if (adopted) glTrees.sync(sceneCfg, latestTheme);
  });

  if (!glTrees.start({
    fpsLimit: settings.fpsLimit,
    allowSoftware: preference === 'webgl',
  })) {
    window.overlayRenderer = { mode: 'canvas2d', reason: glTrees.reason ?? 'WebGL2 unavailable' };
    return;
  }

  const built = await glTrees.sync(latestScene ?? { trees: [] }, latestTheme);
  if (!built || !producedGeometry(glTrees)) {
    glTrees.dispose();
    window.overlayRenderer = { mode: 'canvas2d', reason: 'engine produced no geometry' };
    return;
  }

  glTrees.run();
  // One frame's grace before believing it: setScene resolves before the
  // first draw, and a driver that is going to fail tends to do it there.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (glTrees.failed) {
    glTrees.dispose();
    window.overlayRenderer = { mode: 'canvas2d', reason: 'first frame failed' };
    return;
  }

  adopted = true;
  overlay.setTreeRenderer('gl');
  // The aurora is adopted together with the trees — one Scene, one
  // first-frame gate (see gl-trees.js's header) — so if we got this far,
  // whatever aurora layer that scene has (if any: gl-trees.js only adds
  // one when the composition actually has the aurora on) is already
  // live. Canvas 2D's own aurora draw checks this same flag and skips
  // itself accordingly, so this is safe to set unconditionally.
  overlay.setAuroraRenderer('gl');
  glCanvas.hidden = false;
  window.overlayRenderer = {
    mode: 'webgl',
    renderer: glTrees.stats?.renderer,
    quality: glTrees.stats?.quality,
  };
  window.overlayGlTrees = glTrees;

  // Automatic quality degrade (src/shared/perf.js) already runs inside
  // snow.js, sampling the Canvas 2D layers' own cost — this is what
  // forwards its GPU-facing half to the engine, so a sustained overage
  // drops the trees' internal render resolution AND the aurora's ray
  // count too, not just the Canvas 2D sky and snow. Subscribing fires
  // immediately with the tier already in effect, so a governor that
  // degraded before adoption finished isn't silently ignored.
  overlay.onQualityTierChanged((tierCfg) => {
    glTrees.setRenderScale(tierCfg.glRenderScale ?? 1);
    glTrees.setAuroraDetail(tierCfg.auroraDetail ?? 1);
  });
}

// Exposed so tests can await the decision rather than racing it.
window.overlayReady = boot().catch((err) => {
  console.warn('Overlay bootstrap failed; Canvas 2D renderer remains active:', err);
  window.overlayRenderer = { mode: 'canvas2d', reason: String(err) };
});
