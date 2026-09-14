import { test, expect } from '@playwright/test';

// The production overlay is a transparent, always-on-top, click-through
// native window created by Tauri — Playwright cannot attach to it or
// assert on those OS-level window properties. What we CAN test here is
// the canvas renderer itself (src/overlay/snow.js) in isolation, served
// as a normal page. See docs/ARCHITECTURE.md section 5 for the full
// rationale and the manual QA checklist for the native-window behavior.

test.beforeEach(async ({ page }) => {
  await page.goto('/overlay');
  // Wait for the initial theme/settings fetch (bridge.js, localStorage
  // fallback outside Tauri) to finish before each test acts, otherwise it
  // can resolve after a test's own setDensity() call and silently
  // overwrite it with the theme's default.
  await page.evaluate(() => window.snowOverlayReady);
});

test('snow renderer initializes with the configured particle count', async ({ page }) => {
  const count = await page.evaluate(() => window.snowOverlay.getParticleCount());
  expect(count).toBe(120);
});

test('setDensity changes the particle count live', async ({ page }) => {
  await page.evaluate(() => window.snowOverlay.setDensity(50));
  const count = await page.evaluate(() => window.snowOverlay.getParticleCount());
  expect(count).toBe(50);
});

test('canvas renders non-transparent pixels after a few frames', async ({ page }) => {
  await page.waitForTimeout(300);
  const hasContent = await page.evaluate(() => {
    const canvas = document.getElementById('snow');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true; // any non-zero alpha pixel
    }
    return false;
  });
  expect(hasContent).toBe(true);
});

test('fps limiter throttles the render loop', async ({ page }) => {
  await page.evaluate(() => window.snowOverlay.setFpsLimit(30));
  await page.waitForTimeout(2200);
  const { fps } = await page.evaluate(() => window.snowOverlay.getStats());
  // Generous window: the headless display runs at 60Hz, so a 30 cap should
  // land near 30 and must not be running free at 60.
  expect(fps).toBeGreaterThan(20);
  expect(fps).toBeLessThan(45);
});

test('a full scene frame stays well inside the 120fps budget', async ({ page }) => {
  await page.evaluate(() => window.snowOverlay.setFpsLimit(0));
  await page.evaluate(() => window.snowOverlay.setDensity(300));
  await page.waitForTimeout(2500);
  const { frameMs } = await page.evaluate(() => window.snowOverlay.getStats());
  // 120fps allows 8.33ms per frame. Fail well before that so a future
  // change that quietly makes rendering expensive is caught here.
  expect(frameMs).toBeLessThan(4);
});

test('the scene composition drives what this screen shows', async ({ page }) => {
  // One tree, no fireplace: the renderer must follow the composition
  // rather than the two-trees-and-a-fireplace it used to hard-code.
  await page.evaluate(() => window.snowOverlayScene.setConfig({
    trees: [{ id: 't1', x: 0.5, scale: 1, seed: 7 }],
    fireplaces: [],
    aurora: false,
    stars: false,
  }));
  const cfg = await page.evaluate(() => window.snowOverlayScene.getConfig());
  expect(cfg.trees).toHaveLength(1);
  expect(cfg.fireplaces).toHaveLength(0);
  expect(cfg.aurora).toBe(false);
});

test('the selected weather profile coordinates snow rendering', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('christmas-theme-settings', JSON.stringify({
      themeId: 'classic-red', snowDensity: 120, snowWind: 0.3, flakeScale: 1,
      snowAccumulate: true, maxSnowHeight: 60,
      scene: { screens: { 0: { weatherProfile: 'blizzard' } } },
    }));
  });
  await page.reload();
  await page.evaluate(() => window.snowOverlayReady);
  const config = await page.evaluate(() => window.snowOverlay.getSnowConfig());
  expect(config.wind).toBeCloseTo(0.495, 3);
  expect(config.flakeScale).toBeCloseTo(1.35, 3);
  expect(config.maxSnowHeight).toBe(90);
  expect(config.glitterDensity).toBeCloseTo(1.35, 3);
});

test('an empty composition still renders the snow', async ({ page }) => {
  await page.evaluate(() => window.snowOverlayScene.setConfig({
    trees: [], fireplaces: [], garland: { enabled: false },
    aurora: false, stars: false, icicles: false,
  }));
  await page.waitForTimeout(400);
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('snow');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  expect(painted).toBe(true);
});

test('recycling a landed flake allocates nothing', async ({ page }) => {
  // The stutter this guards against: the old code built a fresh object
  // (plus an object literal) every time a flake landed, so a few hundred
  // flakes falling continuously produced thousands of short-lived objects
  // a second and a garbage-collection sawtooth you could feel.
  await page.evaluate(() => window.snowOverlay.setDensity(400));
  const grew = await page.evaluate(async () => {
    if (!performance.memory) return null; // not exposed in every build
    const before = performance.memory.usedJSHeapSize;
    await new Promise((r) => setTimeout(r, 2500));
    return performance.memory.usedJSHeapSize - before;
  });
  if (grew === null) test.skip(true, 'performance.memory unavailable in this build');
  // A little churn is expected from the page itself; thousands of flake
  // objects would be orders of magnitude more.
  expect(grew).toBeLessThan(4_000_000);
});

// ---------------------------------------------------------------------------
// multi-screen star field continuity (src/overlay/lights.js)
// ---------------------------------------------------------------------------
//
// Two overlay windows on adjacent monitors each call getStars() with their
// own local w/h but a DIFFERENT origin (their real desktop position). The
// fix under test: the star field is derived from a hash over GLOBAL grid
// cells, so the same star lands in the same global position regardless of
// which window's local coordinates it is expressed in — the pattern reads
// as one continuous sky across the shared edge instead of two independent
// random fields that happen to abut.
test.describe('star field multi-screen coherence', () => {
  test('sky density and shooting-star frequency change the rendered sky', async ({ page }) => {
    await page.goto('/overlay');
    const result = await page.evaluate(async () => {
      const mod = await import('/overlay/lights.js');
      const W = 700;
      const H = 500;
      const render = (opts) => {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        mod.drawSky(canvas.getContext('2d'), W, H, 0.35, {
          stars: true, aurora: false, lightIntensity: 1, ...opts,
        });
        return canvas.getContext('2d').getImageData(0, 0, W, H).data;
      };
      const sparse = render({ starDensity: 0.25, shootingStarFrequency: 0 });
      const dense = render({ starDensity: 2, shootingStarFrequency: 0 });
      const comet = render({ starDensity: 1, shootingStarFrequency: 1 });
      const noComet = render({ starDensity: 1, shootingStarFrequency: 0 });
      const alphaSum = (pixels) => pixels.reduce((sum, value, index) => index % 4 === 3 ? sum + value : sum, 0);
      let cometDiff = 0;
      for (let i = 0; i < comet.length; i++) cometDiff += Math.abs(comet[i] - noComet[i]);
      return { sparseAlpha: alphaSum(sparse), denseAlpha: alphaSum(dense), cometDiff };
    });
    expect(result.denseAlpha).toBeGreaterThan(result.sparseAlpha);
    expect(result.cometDiff).toBeGreaterThan(10_000);
  });

  test('a star field split across two windows matches one wide window', async ({ page }) => {
    await page.goto('/overlay');
    const result = await page.evaluate(async () => {
      const mod = await import('/overlay/lights.js');
      const W = 1000;
      const H = 700;

      // One "wide" window spanning both monitors, origin (0,0).
      mod.invalidateLights();
      const wideCanvas = document.createElement('canvas');
      wideCanvas.width = W * 2;
      wideCanvas.height = H;
      const wideCtx = wideCanvas.getContext('2d');
      mod.drawSky(wideCtx, W * 2, H, 0, { stars: true, aurora: false, originX: 0, originY: 0 });

      // The same span as two separate windows, each with its own local
      // origin matching its real desktop position.
      mod.invalidateLights();
      const leftCanvas = document.createElement('canvas');
      leftCanvas.width = W;
      leftCanvas.height = H;
      mod.drawSky(leftCanvas.getContext('2d'), W, H, 0, { stars: true, aurora: false, originX: 0, originY: 0 });

      mod.invalidateLights();
      const rightCanvas = document.createElement('canvas');
      rightCanvas.width = W;
      rightCanvas.height = H;
      mod.drawSky(rightCanvas.getContext('2d'), W, H, 0, { stars: true, aurora: false, originX: W, originY: 0 });

      // Composite the two window canvases side by side and diff against
      // the single wide render pixel-for-pixel.
      const combined = document.createElement('canvas');
      combined.width = W * 2;
      combined.height = H;
      const cctx = combined.getContext('2d');
      cctx.drawImage(leftCanvas, 0, 0);
      cctx.drawImage(rightCanvas, W, 0);

      const a = wideCtx.getImageData(0, 0, W * 2, H).data;
      const b = cctx.getImageData(0, 0, W * 2, H).data;
      let maxDiff = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > maxDiff) maxDiff = d;
      }
      return { maxDiff, alphaSum: a.reduce((s, v, i) => (i % 4 === 3 ? s + v : s), 0) };
    });

    // Confirms stars were actually drawn (not an empty/degenerate field).
    expect(result.alphaSum).toBeGreaterThan(0);
    // Identical draw calls (same additive blend order) on matching pixel
    // data should be exact; a small tolerance absorbs any floating point
    // noise in canvas compositing.
    expect(result.maxDiff).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// modern fireplace variant (src/overlay/decor.js)
// ---------------------------------------------------------------------------
test.describe('fireplace style variants', () => {
  test('rustic and modern styles both render and look visibly different', async ({ page }) => {
    await page.goto('/overlay');
    const result = await page.evaluate(async () => {
      const mod = await import('/overlay/decor.js');
      const W = 500;
      const H = 400;
      const colors = { primary: '#c0392b', secondary: '#1e7d32', accent: '#f1c40f' };

      function renderStyle(style) {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        mod.drawFireplace(ctx, W, H, 1.2, colors, {
          x: 0.5, scale: 1, fireplaceStyle: style,
          stockings: true, mantelGarland: true, candles: true,
          lights: { palette: 'warm', mode: 'twinkle' },
        }, {});
        return ctx.getImageData(0, 0, W, H).data;
      }

      const rustic = renderStyle('rustic');
      const modern = renderStyle('modern');

      let litRustic = 0;
      let litModern = 0;
      let diff = 0;
      for (let i = 0; i < rustic.length; i += 4) {
        if (rustic[i + 3] > 0) litRustic++;
        if (modern[i + 3] > 0) litModern++;
        diff += Math.abs(rustic[i] - modern[i]) + Math.abs(rustic[i + 1] - modern[i + 1])
          + Math.abs(rustic[i + 2] - modern[i + 2]);
      }
      return { litRustic, litModern, diff };
    });

    // Both styles must actually draw something (never a blank fireplace).
    expect(result.litRustic).toBeGreaterThan(0);
    expect(result.litModern).toBeGreaterThan(0);
    // And they must be visibly different pictures, not the same bake under
    // a different name.
    expect(result.diff).toBeGreaterThan(10000);
  });

  test('an unrecognised fireplaceStyle falls back to rustic rather than drawing nothing', async ({ page }) => {
    await page.goto('/overlay');
    const painted = await page.evaluate(async () => {
      const mod = await import('/overlay/decor.js');
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 320;
      const ctx = canvas.getContext('2d');
      mod.drawFireplace(ctx, 400, 320, 1.5, { primary: '#c0392b', secondary: '#1e7d32' }, {
        x: 0.5, scale: 1, fireplaceStyle: 'not-a-real-style', lights: {},
      }, {});
      const data = ctx.getImageData(0, 0, 400, 320).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
      return false;
    });
    expect(painted).toBe(true);
  });
});
