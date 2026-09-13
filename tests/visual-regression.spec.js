import { test, expect } from '@playwright/test';

// Screenshot / visual regression baselines for the settings window.
// Run `npm run test:update-baselines` after a deliberate visual change.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.settingsReady);
});

test('scene tab baseline', async ({ page }) => {
  await expect(page).toHaveScreenshot('settings-scene.png');
});

test('scene tab with a custom palette open', async ({ page }) => {
  await page.selectOption('[data-testid="garland-palette"]', 'custom');
  await expect(page).toHaveScreenshot('settings-custom-palette.png');
});

test('snow tab baseline', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await expect(page).toHaveScreenshot('settings-snow.png');
});

test('max snow density baseline', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.locator('[data-testid="snow-density"]').fill('600');
  await expect(page).toHaveScreenshot('settings-snow-max.png');
});

test('min snow density baseline', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.locator('[data-testid="snow-density"]').fill('0');
  await expect(page).toHaveScreenshot('settings-snow-min.png');
});

test('lights tab baseline', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await expect(page).toHaveScreenshot('settings-lights.png');
});

test('system tab baseline', async ({ page }) => {
  await page.click('[data-testid="tab-system"]');
  await expect(page).toHaveScreenshot('settings-system.png');
});

test('frosty-blue theme baseline', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await page.selectOption('[data-testid="theme-select"]', 'frosty-blue');
  await expect(page).toHaveScreenshot('settings-frosty-blue-theme.png');
});
