import { test, expect } from '@playwright/test';

// Screenshot / visual regression baselines for the settings window.
// Run `npm run test:update-baselines` after a deliberate visual change.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.settingsReady);
});

const expectScreenshot = (page, name) =>
  expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.01 });

test('scene tab baseline', async ({ page }) => {
  await expectScreenshot(page, 'settings-scene.png');
});

test('scene tab with a custom palette open', async ({ page }) => {
  await page.selectOption('[data-testid="garland-palette"]', 'custom');
  await expectScreenshot(page, 'settings-custom-palette.png');
});

test('snow tab baseline', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await expectScreenshot(page, 'settings-snow.png');
});

test('max snow density baseline', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.locator('[data-testid="snow-density"]').fill('600');
  await expectScreenshot(page, 'settings-snow-max.png');
});

test('min snow density baseline', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.locator('[data-testid="snow-density"]').fill('0');
  await expectScreenshot(page, 'settings-snow-min.png');
});

test('lights tab baseline', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await expectScreenshot(page, 'settings-lights.png');
});

test('system tab baseline', async ({ page }) => {
  await page.click('[data-testid="tab-system"]');
  await expectScreenshot(page, 'settings-system.png');
});

test('frosty-blue theme baseline', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await page.selectOption('[data-testid="theme-select"]', 'frosty-blue');
  await expectScreenshot(page, 'settings-frosty-blue-theme.png');
});
