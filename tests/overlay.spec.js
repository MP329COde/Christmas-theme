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
