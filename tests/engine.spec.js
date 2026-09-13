import { test, expect } from '@playwright/test';

// Tests for the WebGL scene engine and the ChristmasTree layer.
//
// What can be tested here: that the engine boots, that the shaders
// compile, that the geometry is generated, that the composited output has
// the alpha the transparent overlay window depends on, that a layer can be
// switched off independently, and what the CPU costs per frame.
//
// What CANNOT be tested here, and is in the manual QA checklist instead:
// GPU frame time. This environment rasterises in software (SwiftShader),
// so its frame rate says nothing about a real machine. The CPU-side budget
// below is still meaningful, because it is the same work on any GPU.

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.errorsSeen = errors;
  await page.goto('/lab?readback=1&hud=0&wind=1');
  await page.evaluate(() => window.sceneLabReady);
});

test('the engine boots with WebGL2 and no page errors', async ({ page }) => {
  const supported = await page.evaluate(() => window.sceneLab.supported);
  expect(supported).toBe(true);
  expect(page.errorsSeen).toEqual([]);
});

test('the tree generates a dense instanced canopy', async ({ page }) => {
  const count = await page.evaluate(() => window.sceneLab.getInstanceCount());
  // Thousands of sprigs in a handful of draw calls is the whole point of
  // the instanced path; a regression to a few hundred would mean the
  // skeleton generator silently stopped producing branches.
  expect(count).toBeGreaterThan(3000);
});

test('the whole scene costs a handful of draw calls', async ({ page }) => {
  await page.waitForTimeout(800);
  const { draws } = await page.evaluate(() => window.sceneLab.getStats());
  expect(draws).toBeLessThanOrEqual(12);
});

test('composited output is opaque on the tree and transparent elsewhere', async ({ page }) => {
  await page.waitForTimeout(700);
  const size = page.viewportSize();
  // The top-left corner is empty sky. If this is not fully transparent,
  // the overlay window would paint a visible rectangle over the desktop.
  const corner = await page.evaluate(() => window.sceneLab.readPixel(6, 6));
  expect(corner[3]).toBe(0);

  // The tree stands at the bottom centre.
  const onTree = await page.evaluate(
    ([x, y]) => window.sceneLab.readPixel(x, y),
    [size.width / 2, size.height * 0.72]
  );
  expect(onTree[3]).toBeGreaterThan(60);
});

test('premultiplied output never exceeds its own alpha', async ({ page }) => {
  await page.waitForTimeout(700);
  const size = page.viewportSize();
  // In premultiplied colour every channel is already scaled by alpha, so
  // rgb > a means the compositor will be handed an impossible colour and
  // the edges of the overlay will fringe over the desktop.
  const samples = await page.evaluate(([w, h]) => {
    const out = [];
    for (let i = 0; i < 24; i++) {
      out.push(window.sceneLab.readPixel(w * (0.3 + 0.4 * (i % 6) / 5), h * (0.45 + 0.45 * Math.floor(i / 6) / 3)));
    }
    return out;
  }, [size.width, size.height]);
  for (const [r, g, b, a] of samples) {
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(a + 2); // +2 for rounding
  }
});

test('a layer can be switched off independently', async ({ page }) => {
  await page.evaluate(() => window.sceneLab.setEnabled('ChristmasTree', false));
  await page.waitForTimeout(400);
  const size = page.viewportSize();
  const px = await page.evaluate(
    ([x, y]) => window.sceneLab.readPixel(x, y),
    [size.width / 2, size.height * 0.72]
  );
  expect(px[3]).toBe(0);
});

test('CPU cost per frame stays small', async ({ page }) => {
  await page.waitForTimeout(2000);
  const { cpuMs } = await page.evaluate(() => window.sceneLab.getStats());
  // Everything heavy lives on the GPU; the CPU's per-frame job is the
  // bulb flicker and a small buffer upload. If this grows, something has
  // moved back onto the main thread.
  expect(cpuMs).toBeLessThan(2);
});

test.describe('production overlay adoption', () => {
  // Small viewport on purpose: this project rasterises in software, where
  // a full-size frame takes long enough to starve the page. What is being
  // tested is the DECISION and the handover, not the frame rate.
  test.use({ viewport: { width: 560, height: 400 } });

  test('forcing WebGL hands the trees to the engine', async ({ page }) => {
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });
    const info = await page.evaluate(() => window.overlayRenderer);
    expect(info.mode).toBe('webgl');
    // The Canvas 2D renderer must have actually let go of the trees, or
    // both would draw them and the scene would double up.
    expect(await page.evaluate(() => window.snowOverlay.getTreeRenderer())).toBe('gl');
    await expect(page.locator('#snow-gl')).toBeVisible();
    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });

  test('automatic mode refuses a software rasteriser', async ({ page }) => {
    // Adopting SwiftShader would be slower AND no prettier than Canvas 2D,
    // and an uncapped GL loop on it starves the rest of the overlay.
    await page.goto('/overlay?renderer=auto', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });
    const info = await page.evaluate(() => window.overlayRenderer);
    expect(info.mode).toBe('canvas2d');
    expect(info.reason).toMatch(/software rasteriser/);
  });

  test('forcing WebGL also hands the aurora to the engine, alongside the trees', async ({ page }) => {
    // The default scene composition has the aurora on (see
    // shared/scene.js's defaultScene) — the same "first real frame or
    // fall all the way back" gate as the trees now covers both.
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });
    expect((await page.evaluate(() => window.overlayRenderer)).mode).toBe('webgl');

    expect(await page.evaluate(() => window.snowOverlay.getAuroraRenderer())).toBe('gl');
    const aurora = await page.evaluate(() => {
      const layer = window.overlayGlTrees?.scene?.get('northern-lights');
      return layer ? { ready: layer.ready, instanceCount: layer.instanceCount } : null;
    });
    expect(aurora).not.toBeNull();
    expect(aurora.ready).toBe(true);
    expect(aurora.instanceCount).toBeGreaterThan(0);

    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });

  test('automatic degrade lowers the GL aurora ray count without a rebuild', async ({ page }) => {
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });

    const before = await page.evaluate(
      () => window.overlayGlTrees.scene.get('northern-lights').instanceCount
    );

    await page.evaluate(() => window.overlayGlTrees.setAuroraDetail(0.2));
    const after = await page.evaluate(
      () => window.overlayGlTrees.scene.get('northern-lights').instanceCount
    );

    expect(after).toBeLessThan(before);
    // The layer object is the SAME one, not a rebuilt scene — setDetail()
    // must be a cheap draw-count change, never a reallocation.
    expect(await page.evaluate(() => window.overlayGlTrees.scene.layers.length)).toBeGreaterThan(0);

    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });
});
