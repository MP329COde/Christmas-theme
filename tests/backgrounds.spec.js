import { test, expect } from '@playwright/test';

async function openRenderer(page) {
  await page.goto('/overlay?renderer=canvas');
  await page.evaluate(async () => {
    await window.snowOverlayReady;
    window.snowOverlay.stop();
    window.backgroundModule = await import('/overlay/background.js');
  });
}

test('still, zero movement and reduced motion freeze every scenic layer including flakes', async ({ page }) => {
  await openRenderer(page);
  const result = await page.evaluate(() => {
    const renderer = window.backgroundModule.createWinterBackgroundRenderer();
    const canvas = document.createElement('canvas');
    canvas.width = 480; canvas.height = 320;
    const c = canvas.getContext('2d');
    const draw = (time, cfg, reduced) => {
      c.clearRect(0, 0, 480, 320);
      renderer.draw(c, 480, 320, time, cfg, {}, reduced);
      return canvas.toDataURL();
    };
    const results = [];
    for (const background of ['animated-forest', 'alpine-lake']) {
      for (const [overrides, reduced] of [
        [{ backgroundAnimation: 'none' }, false],
        [{ backgroundMotion: 0 }, false],
        [{ backgroundAnimation: 'kenburns' }, true],
      ]) {
        const cfg = { background, ...overrides };
        results.push(draw(0, cfg, reduced) === draw(60, cfg, reduced));
      }
      results.push(draw(0, { background }, false) !== draw(60, { background }, false));
    }
    return results;
  });
  expect(result).toEqual(Array(8).fill(true));
});

test('the production overlay responds to a changed reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('christmas-theme-settings', JSON.stringify({
      snowDensity: 0, snowAccumulate: false,
      scene: { screens: { 0: {
        background: 'animated-forest', trees: [], fireplaces: [], aurora: false, stars: false,
        icicles: false, snowGlitter: false, garland: { enabled: false },
      } } },
    }));
  });
  await page.goto('/overlay?renderer=canvas');
  await page.evaluate(() => window.snowOverlayReady);
  await page.waitForTimeout(150);
  const frame = () => page.evaluate(() => document.getElementById('snow').toDataURL());
  const first = await frame();
  await page.waitForTimeout(180);
  expect(await frame()).toBe(first);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(180);
  expect(await frame()).not.toBe(first);
});

for (const viewport of [{ width: 420, height: 900 }, { width: 2400, height: 650 }]) {
  test(`scenic presets cover and remain detailed at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openRenderer(page);
    const result = await page.evaluate(({ width, height }) => {
      const renderer = window.backgroundModule.createWinterBackgroundRenderer();
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const c = canvas.getContext('2d');
      return ['animated-forest', 'alpine-lake'].map((background) => {
        renderer.draw(c, width, height, 30, { background });
        const data = c.getImageData(0, 0, width, height).data;
        let transparent = 0;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] !== 255) transparent++;
          if (i % 80 === 0) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        }
        const original = canvas.toDataURL();
        renderer.draw(c, width, height, 30, { background, backgroundPalette: 'twilight', backgroundFog: 0.9 });
        return { transparent, colors: colors.size, customDiffers: original !== canvas.toDataURL() };
      });
    }, viewport);
    for (const scene of result) {
      expect(scene.transparent).toBe(0);
      expect(scene.colors).toBeGreaterThan(200);
      expect(scene.customDiffers).toBe(true);
    }
  });
}

test('cover and stretch image animation never reveal edges at any pan phase', async ({ page }) => {
  await openRenderer(page);
  const uncovered = await page.evaluate(() => {
    const { imagePlacement } = window.backgroundModule;
    const failures = [];
    for (const [w, h] of [[420, 900], [2400, 650], [800, 800]]) {
      for (const [iw, ih] of [[1600, 900], [900, 1600], [800, 800]]) {
        for (const backgroundFit of ['cover', 'stretch']) {
          for (const backgroundAnimation of ['drift', 'kenburns']) {
            for (const backgroundMotion of [0, 0.1, 1, 2]) {
              for (let t = 0; t < 300; t += 2) {
                const p = imagePlacement(w, h, iw, ih, { backgroundFit, backgroundAnimation, backgroundMotion }, t);
                if (p.x > 0.001 || p.y > 0.001 || p.x + p.width < w - 0.001 || p.y + p.height < h - 0.001) failures.push(p);
              }
            }
          }
        }
      }
    }
    return failures.length;
  });
  expect(uncovered).toBe(0);
});

test('image pixels cover the canvas and reduced motion freezes image placement', async ({ page }) => {
  await openRenderer(page);
  const result = await page.evaluate(async () => {
    const { drawImageBackground } = window.backgroundModule;
    const image = new Image();
    image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="70"><rect width="40" height="70" fill="#264860"/><path d="M0 0L40 70" stroke="white" stroke-width="10"/></svg>');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 640;
    const c = canvas.getContext('2d');
    const result = [];
    for (const backgroundFit of ['cover', 'stretch', 'tile']) {
      const cfg = { backgroundFit, backgroundMotion: 2 };
      const draw = (t, reduced = false) => {
        c.clearRect(0, 0, 320, 640);
        drawImageBackground(c, image, 320, 640, cfg, t, reduced);
        return canvas.toDataURL();
      };
      draw(14);
      const data = c.getImageData(0, 0, 320, 640).data;
      result.push({ covered: data.every((v, i) => i % 4 !== 3 || v === 255),
        frozen: draw(0, true) === draw(40, true) });
    }
    return result;
  });
  expect(result).toEqual(Array(3).fill({ covered: true, frozen: true }));
});

test('background snow lighting follows only actual fireplace locations and contribution', async ({ page }) => {
  await openRenderer(page);
  const result = await page.evaluate(() => {
    const renderer = window.backgroundModule.createWinterBackgroundRenderer();
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 450;
    const c = canvas.getContext('2d');
    const cfg = { background: 'animated-forest', backgroundAnimation: 'none', fireplaces: [] };
    const draw = (fireplaces, contribution = 1) => {
      c.clearRect(0, 0, 800, 450);
      renderer.draw(c, 800, 450, 0, { ...cfg, fireplaces, look: { fireplaceContribution: contribution } });
      return c.getImageData(0, 0, 800, 450).data;
    };
    const base = draw([]);
    const off = draw([{ x: 0.2 }], 0);
    const left = draw([{ x: 0.2 }]);
    const right = draw([{ x: 0.8 }]);
    const both = draw([{ x: 0.2 }, { x: 0.8 }]);
    const delta = (frame, x) => frame[(430 * 800 + x) * 4] - base[(430 * 800 + x) * 4];
    return { off: off.every((v, i) => v === base[i]),
      left: [delta(left, 160), delta(left, 640)],
      right: [delta(right, 160), delta(right, 640)],
      both: [delta(both, 160), delta(both, 640)] };
  });
  expect(result.off).toBe(true);
  expect(result.left[0]).toBeGreaterThan(5);
  expect(result.left[1]).toBe(0);
  expect(result.right[0]).toBe(0);
  expect(result.right[1]).toBeGreaterThan(5);
  expect(result.both.every((v) => v > 5)).toBe(true);
});

test('static landscape bakes are reused and resolution is bounded', async ({ page }) => {
  await openRenderer(page);
  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const c = canvas.getContext('2d');
    const original = document.createElement.bind(document);
    const created = [];
    document.createElement = (...args) => {
      const result = original(...args);
      if (args[0] === 'canvas') created.push(result);
      return result;
    };
    try {
      const renderer = window.backgroundModule.createWinterBackgroundRenderer();
      const cfg = { background: 'animated-forest' };
      renderer.draw(c, 7680, 2160, 0, cfg);
      const firstCount = created.length;
      for (let t = 1; t < 30; t++) renderer.draw(c, 7680, 2160, t, {
        ...cfg, backgroundOpacity: t / 30, backgroundMotion: t / 20, fireplaces: [{ x: t / 30 }],
      });
      const afterFrames = created.length;
      renderer.draw(c, 7680, 2160, 0, { ...cfg, backgroundFog: 0.9 });
      return { firstCount, afterFrames, afterEdit: created.length,
        maxPixels: Math.max(...created.map((cv) => cv.width * cv.height)) };
    } finally { document.createElement = original; }
  });
  expect(result.firstCount).toBe(5);
  expect(result.afterFrames).toBe(5);
  expect(result.afterEdit).toBe(10);
  expect(result.maxPixels).toBeLessThan(1303000);
});

test('image loader rejects stale reads and decodes, caches updates, and handles errors', async ({ page }) => {
  await openRenderer(page);
  const result = await page.evaluate(async () => {
    const loads = [], decodes = [];
    const loader = window.backgroundModule.createBackgroundImageLoader(
      (key) => new Promise((resolve) => loads.push({ key, resolve })),
      (url) => new Promise((resolve, reject) => decodes.push({ url, resolve, reject })),
    );
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
    const a = loader.select('a');
    const b = loader.select('b');
    loads[1].resolve('blue'); await flush();
    decodes[0].resolve({ color: 'blue' }); await b;
    loads[0].resolve('red'); await a;
    const staleRead = loader.image.color;
    await loader.select('b');
    const sameReads = loads.length;
    const update = loader.select('b', true);
    loads[2].resolve('blue'); await update;
    const cachedDecodes = decodes.length;
    const c = loader.select('c');
    loads[3].resolve('green'); await flush();
    await loader.select(null);
    decodes[1].resolve({ color: 'green' }); await c;
    const cleared = loader.image;
    const failure = loader.select('bad');
    loads[4].resolve('invalid'); await flush();
    decodes[2].reject(new Error('decode failed')); await failure;
    return { staleRead, sameReads, cachedDecodes, cleared, failed: loader.image };
  });
  expect(result).toEqual({ staleRead: 'blue', sameReads: 2, cachedDecodes: 1, cleared: null, failed: null });
});

test('inherited and copied backgrounds retain identity without leaking per-screen edits', async ({ page }) => {
  await openRenderer(page);
  const result = await page.evaluate(async () => {
    const { screenConfig } = await import('/shared/scene.js');
    const scene = { screens: { default: {
      background: 'image', backgroundPalette: 'twilight', backgroundFog: 0.7,
    } } };
    const inherited = screenConfig(scene, 1);
    scene.screens['1'] = { ...inherited, backgroundFog: 0.1 };
    const own = screenConfig(scene, 1);
    const other = screenConfig(scene, 2);
    scene.screens['2'] = { ...own };
    const copied = screenConfig(scene, 2);
    const legacy = screenConfig({ screens: { 2: { background: 'image' } } }, 2);
    return { own: [own.backgroundImageKey, own.backgroundFog],
      other: [other.backgroundImageKey, other.backgroundFog],
      copied: copied.backgroundImageKey, legacy: legacy.backgroundImageKey };
  });
  expect(result).toEqual({
    own: ['screen-default', 0.1], other: ['screen-default', 0.7],
    copied: 'screen-default', legacy: 'screen-2',
  });
});
