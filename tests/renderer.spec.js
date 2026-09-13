import { test, expect } from '@playwright/test';

// Which renderer the production overlay adopts, and why.
//
// This project runs WITHOUT a GL implementation, so it exercises the path
// that matters most: the overlay must come up on Canvas 2D and say
// precisely why, never silently show nothing. The forced-WebGL case is in
// the chromium-gl project, which has one.

test('the overlay reports which renderer it adopted', async ({ page }) => {
  await page.goto('/overlay', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.overlayRenderer, null, { polling: 200, timeout: 30000 });
  const info = await page.evaluate(() => window.overlayRenderer);
  expect(['webgl', 'canvas2d']).toContain(info.mode);
  // Whatever it chose, it has to be able to say why — "the toggle is on
  // but nothing happens" is the failure mode this whole project keeps
  // running into.
  if (info.mode === 'canvas2d') expect(info.reason).toBeTruthy();
});

test('renderer=canvas keeps the Canvas 2D trees', async ({ page }) => {
  await page.goto('/overlay?renderer=canvas', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.overlayRenderer, null, { polling: 200, timeout: 30000 });
  const info = await page.evaluate(() => window.overlayRenderer);
  expect(info.mode).toBe('canvas2d');
  expect(await page.evaluate(() => window.snowOverlay.getTreeRenderer())).toBe('2d');
});

test('the fallback still draws a complete scene', async ({ page }) => {
  await page.goto('/overlay?renderer=canvas', { waitUntil: 'commit' });
  await page.evaluate(() => window.snowOverlayReady);
  await page.waitForTimeout(600);
  // Both Canvas 2D layers must carry content: the back one (sky, far snow
  // and — in fallback — the trees) and the front one (garland, fireplace,
  // near snow).
  const painted = await page.evaluate(() => {
    const count = (id) => {
      const canvas = document.getElementById(id);
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
      return n;
    };
    return { back: count('snow'), front: count('snow-front') };
  });
  expect(painted.back).toBeGreaterThan(1000);
  expect(painted.front).toBeGreaterThan(1000);
});

test('the GL canvas stays hidden while the fallback is active', async ({ page }) => {
  await page.goto('/overlay?renderer=canvas', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.overlayRenderer, null, { polling: 200, timeout: 30000 });
  await expect(page.locator('#snow-gl')).toBeHidden();
});
