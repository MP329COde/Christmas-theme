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
  await page.selectOption('[data-testid="tree-0-mode"]', 'pulse');
  await page.waitForTimeout(300);
  const lights = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].trees[0].lights);
  expect(lights.palette).toBe('red-blue');
  expect(lights.mode).toBe('pulse');
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

test('sky density and shooting-star frequency are saved per screen', async ({ page }) => {
  await page.locator('[data-testid="star-density"]').fill('150');
  await page.locator('[data-testid="shooting-star-frequency"]').fill('50');
  await page.waitForTimeout(300);
  const sky = await page.evaluate(() => {
    const screen = JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'];
    return { density: screen.starDensity, frequency: screen.shootingStarFrequency };
  });
  expect(sky.density).toBe(1.5);
  expect(sky.frequency).toBe(0.5);
});

test('a camera-motion profile is saved per screen', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await page.selectOption('[data-testid="camera-motion-profile"]', 'gentle');
  await page.waitForTimeout(300);
  const profile = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].look.cameraMotionProfile);
  expect(profile).toBe('gentle');
});

test('lighting-rig controls are saved per screen', async ({ page }) => {
  await page.click('[data-testid="tab-lights"]');
  await page.locator('[data-testid="ambient-warmth"]').fill('150');
  await page.locator('[data-testid="look-bloom"]').fill('60');
  await page.locator('[data-testid="fireplace-contribution"]').fill('40');
  await page.locator('[data-testid="look-shadow-strength"]').fill('120');
  await page.locator('[data-testid="look-shadow-softness"]').fill('135');
  await page.waitForTimeout(300);
  const look = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].look);
  expect(look).toMatchObject({
    ambientWarmth: 1.5, bloom: 0.6, fireplaceContribution: 0.4, shadowStrength: 1.2, shadowSoftness: 1.35,
  });
});

test('background image controls appear only in image mode', async ({ page }) => {
  await expect(page.locator('[data-testid="background-file"]')).toHaveCount(0);
  await page.selectOption('[data-testid="background-mode"]', 'image');
  await expect(page.locator('[data-testid="background-fit"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-opacity"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-animation"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-motion"]')).toBeVisible();
});

test('background animation controls are saved per screen', async ({ page }) => {
  await page.selectOption('[data-testid="background-mode"]', 'image');
  await page.selectOption('[data-testid="background-animation"]', 'kenburns');
  await page.locator('[data-testid="background-motion"]').fill('140');
  await page.waitForTimeout(300);
  const background = await page.evaluate(() => {
    const screen = JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'];
    return { animation: screen.backgroundAnimation, motion: screen.backgroundMotion };
  });
  expect(background).toEqual({ animation: 'kenburns', motion: 1.4 });
});

test('background movement hides when the wallpaper is set still', async ({ page }) => {
  await page.selectOption('[data-testid="background-mode"]', 'image');
  await expect(page.locator('[data-testid="background-motion"]')).toBeVisible();
  await page.selectOption('[data-testid="background-animation"]', 'none');
  await expect(page.locator('[data-testid="background-motion"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  const animation = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].backgroundAnimation);
  expect(animation).toBe('none');
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

test('a weather profile is saved per screen', async ({ page }) => {
  await page.click('[data-testid="tab-snow"]');
  await page.selectOption('[data-testid="weather-profile"]', 'blizzard');
  await page.waitForTimeout(300);
  const profile = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].weatherProfile);
  expect(profile).toBe('blizzard');
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

test('a saved preset carries a thumbnail image', async ({ page }) => {
  page.once('dialog', (d) => d.accept('Snowy'));
  await page.click('[data-testid="preset-save"]');
  await page.waitForTimeout(250);

  const thumbnail = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).presets[0].thumbnail);
  expect(thumbnail).toMatch(/^data:image\/jpeg;base64,/);

  const img = page.locator('[data-testid="preset-thumb"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', thumbnail);
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

test('the performance panel explains a degraded quality tier', async ({ page }) => {
  await page.click('[data-testid="tab-system"]');

  await page.evaluate(() => {
    window.__applyStats({
      fps: 22, frameMs: 44, particles: 120,
      qualityLabel: 'low', qualityTarget: 6.7,
      frameHistory: [40, 42, 44, 46, 48],
      renderer: 'canvas2d', rendererReason: 'software rasteriser (llvmpipe)',
    });
  });

  await expect(page.locator('[data-testid="perf-tier-explain"]'))
    .toContainText('reduced to “low”');
  await expect(page.locator('[data-testid="perf-tier-explain"]'))
    .toContainText('software rasteriser');

  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="perf-sparkline"]');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  expect(painted).toBe(true);
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
