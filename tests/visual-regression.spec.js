import { test, expect } from '@playwright/test';

// Screenshot / visual regression tests for the settings window in
// several states. Run `npm run test:update-baselines` after a deliberate
// visual change to regenerate the reference images.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="theme-select"] option');
});

test('default theme baseline', async ({ page }) => {
  await expect(page).toHaveScreenshot('settings-default-theme.png');
});

test('frosty-blue theme baseline', async ({ page }) => {
  await page.selectOption('[data-testid="theme-select"]', 'frosty-blue');
  await expect(page).toHaveScreenshot('settings-frosty-blue-theme.png');
});

test('max snow density baseline', async ({ page }) => {
  await page.locator('[data-testid="snow-density"]').fill('300');
  await expect(page).toHaveScreenshot('settings-snow-max.png');
});

test('min snow density baseline', async ({ page }) => {
  await page.locator('[data-testid="snow-density"]').fill('0');
  await expect(page).toHaveScreenshot('settings-snow-min.png');
});
