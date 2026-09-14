import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Cleared ONCE, not through addInitScript: an init script runs on every
  // navigation, so it also wiped the storage a reload test was checking.
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.settingsReady);
});

test('opens on the scene tab with a screen picker', async ({ page }) => {
  await expect(page.locator('h1')).toHaveText('🎄 Christmas Theme');
  await expect(page.locator('[data-testid="tab-scene"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="screen-chip-0"]')).toBeVisible();
});

test('tabs switch panels', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await expect(page.locator('[data-testid="panel-snow"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-scene"]')).toBeHidden();
  await page.click('[data-testid="tab-system"]');
  await expect(page.locator('[data-testid="panel-system"]')).toBeVisible();
});

test('the layout map shows a draggable marker per element', async ({ page }) => {
  await expect(page.locator('[data-testid="layout-map"]')).toBeVisible();
  await expect(page.locator('[data-testid="marker-tree-0"]')).toBeVisible();
  await expect(page.locator('[data-testid="marker-tree-1"]')).toBeVisible();
  await expect(page.locator('[data-testid="marker-fireplace-0"]')).toBeVisible();
});

test('trees can be added and removed', async ({ page }) => {
  await expect(page.locator('[data-testid="tree-card-0"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-card-2"]')).toHaveCount(0);
  await page.click('[data-testid="tree-add"]');
  await expect(page.locator('[data-testid="tree-card-2"]')).toBeVisible();
  await page.click('[data-testid="tree-remove-2"]');
  await expect(page.locator('[data-testid="tree-card-2"]')).toHaveCount(0);
});

test('a second fireplace can be added', async ({ page }) => {
  await page.click('[data-testid="fireplace-add"]');
  await expect(page.locator('[data-testid="fireplace-card-1"]')).toBeVisible();
});

test('a fireplace defaults to the rustic style and can be switched to modern', async ({ page }) => {
  await expect(page.locator('[data-testid="fire-0-style"]')).toHaveValue('rustic');
  await page.selectOption('[data-testid="fire-0-style"]', 'modern');
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].fireplaces[0].fireplaceStyle);
  expect(stored).toBe('modern');
});

test('a theme with its own fireplaceStyle seeds new fireplaces with it', async ({ page }) => {
  // minimal-white.json declares "fireplaceStyle": "modern".
  await page.click('[data-testid="tab-lights"]');
  await page.selectOption('[data-testid="theme-select"]', 'minimal-white');
  await page.click('[data-testid="tab-scene"]');
  await page.click('[data-testid="fireplace-add"]');
  await expect(page.locator('[data-testid="fire-1-style"]')).toHaveValue('modern');
  // The existing (first) fireplace must NOT have been changed retroactively.
  await expect(page.locator('[data-testid="fire-0-style"]')).toHaveValue('rustic');
});

test('a tree position slider moves the element and persists', async ({ page }) => {
  await page.locator('[data-testid="tree-0-x"]').fill('42');
  await expect(page.locator('#tree-0-x-value')).toHaveText('42%');
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].trees[0].x);
  expect(stored).toBeCloseTo(0.42, 3);
});

test('each tree carries its own light palette and mode', async ({ page }) => {
  await page.selectOption('[data-testid="tree-0-palette"]', 'red-blue');
  await page.selectOption('[data-testid="tree-0-mode"]', 'chase');
  await page.waitForTimeout(300);
  const lights = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].trees[0].lights);
  expect(lights.palette).toBe('red-blue');
  expect(lights.mode).toBe('chase');
});

test('custom colours appear when the custom palette is chosen', async ({ page }) => {
  await expect(page.locator('[data-testid="garland-color-0"]')).toHaveCount(0);
  await page.selectOption('[data-testid="garland-palette"]', 'custom');
  await expect(page.locator('[data-testid="garland-color-0"]')).toBeVisible();
  await page.click('[data-testid="garland-color-add"]');
  await expect(page.locator('[data-testid="garland-color-3"]')).toBeVisible();
});

test('tree species can be changed', async ({ page }) => {
  await page.selectOption('[data-testid="tree-0-style"]', 'spruce');
  await page.waitForTimeout(300);
  const style = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].trees[0].style);
  expect(style).toBe('spruce');
});

test('sky toggles default on and respond', async ({ page }) => {
  for (const id of ['aurora-toggle', 'stars-toggle', 'icicles-toggle', 'glitter-toggle']) {
    const toggle = page.locator(`[data-testid="${id}"]`);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(page.locator(`[data-testid="${id}"]`)).not.toBeChecked();
  }
});

test('an aurora palette is saved per screen', async ({ page }) => {
  await page.selectOption('[data-testid="aurora-palette"]', 'arctic');
  await page.waitForTimeout(300);
  const palette = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].auroraPalette);
  expect(palette).toBe('arctic');
});

test('background image controls appear only in image mode', async ({ page }) => {
  await expect(page.locator('[data-testid="background-file"]')).toHaveCount(0);
  await page.selectOption('[data-testid="background-mode"]', 'image');
  await expect(page.locator('[data-testid="background-fit"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-opacity"]')).toBeVisible();
});

test('snow density persists across a reload', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.locator('[data-testid="snow-density"]').fill('300');
  await expect(page.locator('#snow-density-value')).toHaveText('300');
  await page.waitForTimeout(300);
  await page.reload();
  await page.evaluate(() => window.settingsReady);
  await page.click('[data-testid="tab-snow"]');
  await expect(page.locator('[data-testid="snow-density"]')).toHaveValue('300');
});

test('a screen can override the global snow density', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.click('[data-testid="snow-density-override"]');
  await expect(page.locator('[data-testid="screen-snow-density"]')).toBeVisible();
  await page.locator('[data-testid="screen-snow-density"]').fill('500');
  await page.waitForTimeout(300);
  const density = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].snowDensity);
  expect(density).toBe(500);
});

test('master light controls live on the lights tab', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await expect(page.locator('[data-testid="light-animation"]')).toHaveValue('twinkle');
  await page.selectOption('[data-testid="light-animation"]', 'chase');
  await expect(page.locator('[data-testid="light-animation"]')).toHaveValue('chase');
  await expect(page.locator('[data-testid="theme-select"]')).toHaveValue('classic-red');
});

test('changing the theme updates the window colours', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await page.selectOption('[data-testid="theme-select"]', 'frosty-blue');
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim());
  expect(bg).toBe('#081a2e');
});

test('presets can be saved and re-applied', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.locator('[data-testid="snow-density"]').fill('500');
  await page.waitForTimeout(250);

  page.once('dialog', (d) => d.accept('Blizzard'));
  await page.click('[data-testid="preset-save"]');
  await expect(page.locator('[data-testid="preset-select"] option')).toHaveCount(2);

  await page.locator('[data-testid="snow-density"]').fill('50');
  await page.waitForTimeout(250);

  const id = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).presets[0].id);
  await page.selectOption('[data-testid="preset-select"]', id);
  await page.waitForTimeout(300);
  await expect(page.locator('[data-testid="snow-density"]')).toHaveValue('500');
});

test('a preset never carries autostart or the dock toggle', async ({ page }) => {
  page.once('dialog', (d) => d.accept('Look'));
  await page.click('[data-testid="preset-save"]');
  await page.click('[data-testid="tab-system"]');
  await page.click('[data-testid="autostart-toggle"]');
  await page.waitForTimeout(250);

  const id = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).presets[0].id);
  await page.selectOption('[data-testid="preset-select"]', id);
  await page.waitForTimeout(300);
  // The preset was saved with autostart off, but applying it must not
  // reach out and change a machine-level setting the user just set.
  await page.click('[data-testid="tab-system"]');
  await expect(page.locator('[data-testid="autostart-toggle"]')).toBeChecked();
});

test('dock status line explains what was detected', async ({ page }) => {
  await page.click('[data-testid="tab-system"]');
  await expect(page.locator('[data-testid="dock-status"]'))
    .toHaveText(/desktop app|Detected on|No Dock/);
});

test('disable everything reports back', async ({ page }) => {
  await page.click('[data-testid="disable-all"]');
  await expect(page.locator('[data-testid="status"]')).toHaveText('Everything disabled');
});
