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

test('tree snow can be adjusted independently and persists', async ({ page }) => {
  await page.locator('[data-testid="tree-0-snow"]').fill('175');
  await page.waitForTimeout(300);
  const snow = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].trees[0].snow);
  expect(snow).toBe(1.75);
});

test('holiday decorations can be added, configured, and removed', async ({ page }) => {
  await expect(page.locator('[data-testid="decoration-card-0"]')).toHaveCount(0);
  await page.click('[data-testid="decoration-add"]');
  await expect(page.locator('[data-testid="decoration-card-0"]')).toBeVisible();
  await page.selectOption('[data-testid="decoration-0-type"]', 'snowman');
  await page.locator('[data-testid="decoration-0-x"]').fill('35');
  await page.locator('[data-testid="decoration-0-scale"]').fill('150');
  await page.waitForTimeout(300);
  const decoration = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].decorations[0]);
  expect(decoration).toMatchObject({ type: 'snowman', x: 0.35, scale: 1.5, y: 0.84 });
  await page.click('[data-testid="decoration-remove-0"]');
  await expect(page.locator('[data-testid="decoration-card-0"]')).toHaveCount(0);
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

test('custom aurora colours are saved per screen', async ({ page }) => {
  await page.selectOption('[data-testid="aurora-palette"]', 'custom');
  await page.waitForTimeout(150);
  await page.locator('[data-testid="aurora-color-0"]').fill('#ff0000');
  await page.locator('[data-testid="aurora-haze-0"]').fill('#220000');
  await page.waitForTimeout(300);
  const custom = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].auroraCustomColors);
  expect(custom.colors[0]).toBe('#ff0000');
  expect(custom.haze[0]).toBe('#220000');
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

test('background panel identifies its renderer separately from WebGL scene layers', async ({ page }) => {
  await page.selectOption('[data-testid="background-mode"]', 'animated-forest');
  await expect(page.locator('[data-testid="background-renderer-info"]'))
    .toContainText('Backgrounds use the Canvas 2D renderer');
  await expect(page.locator('[data-testid="background-renderer-info"]'))
    .toContainText('WebGL');
});

test('animated forest background exposes opacity and motion controls', async ({ page }) => {
  await page.selectOption('[data-testid="background-mode"]', 'animated-forest');
  await expect(page.locator('[data-testid="background-opacity"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-animation"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-motion"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-file"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  const background = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].background);
  expect(background).toBe('animated-forest');
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

test('background movement stays available and resets to still mode', async ({ page }) => {
  await page.selectOption('[data-testid="background-mode"]', 'image');
  await expect(page.locator('[data-testid="background-motion"]')).toBeVisible();
  await page.selectOption('[data-testid="background-animation"]', 'none');
  await expect(page.locator('[data-testid="background-motion"]')).toBeVisible();
  await expect(page.locator('[data-testid="background-motion"]')).toHaveValue('0');
  await page.waitForTimeout(300);
  const background = await page.evaluate(() => {
    const screen = JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'];
    return { animation: screen.backgroundAnimation, motion: screen.backgroundMotion };
  });
  expect(background).toEqual({ animation: 'none', motion: 0 });
});

test('scenic palette, fog and moon controls persist without changing another screen', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('christmas-theme-settings', JSON.stringify({
      scene: { screens: { default: { background: 'alpine-lake', backgroundFog: 0.25 },
        1: { background: 'animated-forest', backgroundPalette: 'glacier', backgroundMoon: 0 } } },
    }));
  });
  await page.reload();
  await page.evaluate(() => window.settingsReady);
  await expect(page.locator('[data-testid="background-mode"]')).toHaveValue('alpine-lake');
  await page.selectOption('[data-testid="background-palette"]', 'custom');
  await page.locator('[data-testid="background-sky"]').fill('#182338');
  await page.locator('[data-testid="background-horizon"]').fill('#6b819b');
  await page.locator('[data-testid="background-snow"]').fill('#d9e8f5');
  await page.locator('[data-testid="background-fog"]').fill('80');
  await page.locator('[data-testid="background-moon"]').fill('140');
  await page.locator('[data-testid="background-moon-x"]').fill('32');
  await page.locator('[data-testid="background-moon-y"]').fill('25');
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens);
  expect(stored['0']).toMatchObject({
    background: 'alpine-lake', backgroundPalette: 'custom', backgroundSky: '#182338',
    backgroundHorizon: '#6b819b', backgroundSnow: '#d9e8f5', backgroundFog: 0.8,
    backgroundMoon: 1.4, backgroundMoonX: 0.32, backgroundMoonY: 0.25,
  });
  expect(stored['1']).toEqual({ background: 'animated-forest', backgroundPalette: 'glacier', backgroundMoon: 0 });
  expect(stored.default).toEqual({ background: 'alpine-lake', backgroundFog: 0.25 });
  await page.reload();
  await page.evaluate(() => window.settingsReady);
  await expect(page.locator('[data-testid="background-palette"]')).toHaveValue('custom');
  await expect(page.locator('[data-testid="background-sky"]')).toHaveValue('#182338');
  await expect(page.locator('[data-testid="background-fog"]')).toHaveValue('80');
  await expect(page.locator('[data-testid="background-moon-x"]')).toHaveValue('32');
});

test('removing an inherited image only clears this screen, not the default image', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('christmas-bg-screen-default', 'shared-image');
    localStorage.setItem('christmas-theme-settings', JSON.stringify({
      scene: { screens: { default: { background: 'image' } } },
    }));
  });
  await page.reload();
  await page.evaluate(() => window.settingsReady);
  await page.click('[data-testid="background-clear"]');
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0']?.backgroundImageKey,
  )).toBe('screen-0');
  expect(await page.evaluate(() => localStorage.getItem('christmas-bg-screen-default'))).toBe('shared-image');
});

for (const action of ['remove', 'replace']) {
  test(`${action} an image preserves copied screens and saved presets`, async ({ page }) => {
    await page.evaluate(() => {
      const image = { background: 'image', backgroundImageKey: 'screen-0' };
      localStorage.setItem('christmas-bg-screen-0', 'shared-image');
      localStorage.setItem('christmas-bg-screen-0-1', 'preset-image');
      localStorage.setItem('christmas-theme-settings', JSON.stringify({
        scene: { screens: { 0: image, 1: image, default: image } },
        presets: [{ id: 'saved', name: 'Saved', settings: {
          scene: { screens: { 0: { ...image, backgroundImageKey: 'screen-0-1' } } },
        } }],
      }));
    });
    await page.reload();
    await page.evaluate(() => window.settingsReady);
    if (action === 'remove') {
      await page.click('[data-testid="background-clear"]');
    } else {
      await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
        name: 'background.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>'),
      });
    }
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens['0'].backgroundImageKey,
    )).toBe('screen-0-2');
    const result = await page.evaluate(() => ({
      shared: localStorage.getItem('christmas-bg-screen-0'),
      preset: localStorage.getItem('christmas-bg-screen-0-1'),
      own: localStorage.getItem('christmas-bg-screen-0-2'),
      screens: JSON.parse(localStorage.getItem('christmas-theme-settings')).scene.screens,
    }));
    expect(result.shared).toBe('shared-image');
    expect(result.preset).toBe('preset-image');
    expect(result.screens['1'].backgroundImageKey).toBe('screen-0');
    expect(result.screens.default.backgroundImageKey).toBe('screen-0');
    if (action === 'remove') expect(result.own).toBeNull();
    else expect(result.own).toMatch(/^data:image\/svg\+xml;base64,/);
    await page.click('[data-testid="background-clear"]');
    await expect(page.locator('[data-testid="status"]')).toHaveText('Background removed');
    expect(await page.evaluate(() => localStorage.getItem('christmas-bg-screen-0-2'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('christmas-bg-screen-0'))).toBe('shared-image');
  });
}

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
