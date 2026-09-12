import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="theme-select"] option');
});

test('renders default theme settings', async ({ page }) => {
  await expect(page.locator('h1')).toHaveText('🎄 Christmas Theme');
  await expect(page.locator('[data-testid="theme-select"]')).toHaveValue('classic-red');
  await expect(page.locator('#snow-density-value')).toHaveText('120');
  await expect(page.locator('[data-testid="dock-toggle"]')).toBeChecked();
});

test('changing theme updates select value and background color', async ({ page }) => {
  await page.selectOption('[data-testid="theme-select"]', 'frosty-blue');
  await expect(page.locator('[data-testid="theme-select"]')).toHaveValue('frosty-blue');

  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
  );
  expect(bg).toBe('#081a2e');
});

test('snow density slider updates the displayed value', async ({ page }) => {
  const slider = page.locator('[data-testid="snow-density"]');
  await slider.fill('300');
  await expect(page.locator('#snow-density-value')).toHaveText('300');

  await slider.fill('0');
  await expect(page.locator('#snow-density-value')).toHaveText('0');
});

test('dock toggle responds to clicks', async ({ page }) => {
  const toggle = page.locator('[data-testid="dock-toggle"]');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});

test('volume slider updates label and persists across reload', async ({ page }) => {
  const slider = page.locator('[data-testid="volume"]');
  await slider.fill('80');
  await expect(page.locator('#volume-value')).toHaveText('80%');

  // Trigger the 'change' event (fill() only fires 'input') so settings.js persists it.
  await slider.dispatchEvent('change');
  await page.reload();
  await page.waitForSelector('[data-testid="theme-select"] option');
  await expect(page.locator('[data-testid="volume"]')).toHaveValue('80');
});

test('disable everything clears status message', async ({ page }) => {
  await page.click('[data-testid="disable-all"]');
  await expect(page.locator('[data-testid="status"]')).toHaveText('Everything disabled');
});
