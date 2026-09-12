import { test, expect } from '@playwright/test';

// The dock/taskbar decoration is a native strip window positioned by Rust
// from the monitor work area (src-tauri/src/decoration.rs). Playwright
// cannot attach to that native window or assert on where the real Dock
// is, so what is tested here is the renderer it hosts, driven through the
// same geometry contract the Rust side sends over the `dock-geometry`
// event. See docs/ARCHITECTURE.md section 4 for the split.

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 90 });
  await page.goto('/dock');
  await page.evaluate(() => window.dockDecorationReady);
});

test('renders a garland with bulbs across the strip', async ({ page }) => {
  await page.waitForTimeout(200);
  const bulbs = await page.evaluate(() => window.dockDecoration.getBulbCount());
  expect(bulbs).toBeGreaterThan(5);
});

test('draws visible pixels in the strip', async ({ page }) => {
  await page.waitForTimeout(300);
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('dock');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 12) opaque++;
    return opaque;
  });
  expect(painted).toBeGreaterThan(500);
});

test('accepts every dock edge without throwing', async ({ page }) => {
  for (const edge of ['bottom', 'top', 'left', 'right']) {
    await page.evaluate((e) => window.dockDecoration.setGeometry({ edge: e }), edge);
    await page.waitForTimeout(120);
    const geom = await page.evaluate(() => window.dockDecoration.getGeometry());
    expect(geom.edge).toBe(edge);
  }
  const errors = await page.evaluate(() => window.__errors ?? []);
  expect(errors).toEqual([]);
});

test('turning the decoration off clears the strip', async ({ page }) => {
  await page.evaluate(() => window.dockDecoration.setOptions({ enabled: false }));
  await page.waitForTimeout(200);
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('dock');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  expect(painted).toBe(false);
});
