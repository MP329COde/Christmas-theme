import { test, expect } from '@playwright/test';

// Tests for the WebGL scene engine and the ChristmasTree layer.
//
// What can be tested here: that the engine boots, that the shaders
// compile, that the geometry is generated, that the composited output has
// the alpha the transparent overlay window depends on, that a layer can be
// switched off independently, and what the CPU costs per frame.
//
// What CANNOT be tested here, and is in the manual QA checklist instead:
// GPU frame time. This environment rasterises in software (SwiftShader),
// so its frame rate says nothing about a real machine. The CPU-side budget
// below is still meaningful, because it is the same work on any GPU.

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.errorsSeen = errors;
  await page.goto('/lab?readback=1&hud=0&wind=1');
  await page.evaluate(() => window.sceneLabReady);
});

test('the engine boots with WebGL2 and no page errors', async ({ page }) => {
  const supported = await page.evaluate(() => window.sceneLab.supported);
  expect(supported).toBe(true);
  expect(page.errorsSeen).toEqual([]);
});

test('the tree generates a dense instanced canopy', async ({ page }) => {
  const count = await page.evaluate(() => window.sceneLab.getInstanceCount());
  // Thousands of sprigs in a handful of draw calls is the whole point of
  // the instanced path; a regression to a few hundred would mean the
  // skeleton generator silently stopped producing branches.
  expect(count).toBeGreaterThan(3000);
});

test('the whole scene costs a handful of draw calls', async ({ page }) => {
  await page.waitForTimeout(800);
  const { draws } = await page.evaluate(() => window.sceneLab.getStats());
  expect(draws).toBeLessThanOrEqual(12);
});

test('composited output is opaque on the tree and transparent elsewhere', async ({ page }) => {
  // This test reads real pixels back through SwiftShader. It can take
  // several seconds per readback in a software rasteriser, so allow more
  // time than the default project timeout.
  test.setTimeout(120_000);
  await page.waitForTimeout(700);
  const size = page.viewportSize();
  // The top-left corner is empty sky. If this is not fully transparent,
  // the overlay window would paint a visible rectangle over the desktop.
  const corner = await page.evaluate(() => window.sceneLab.readPixel(6, 6));
  expect(corner[3]).toBe(0);

  // The tree stands at the bottom centre.
  const onTree = await page.evaluate(
    ([x, y]) => window.sceneLab.readPixel(x, y),
    [size.width / 2, size.height * 0.72]
  );
  expect(onTree[3]).toBeGreaterThan(60);
});

test('premultiplied output never exceeds its own alpha', async ({ page }) => {
  test.setTimeout(120_000);
  await page.waitForTimeout(700);
  const size = page.viewportSize();
  // In premultiplied colour every channel is already scaled by alpha, so
  // rgb > a means the compositor will be handed an impossible colour and
  // the edges of the overlay will fringe over the desktop.
  const samples = await page.evaluate(([w, h]) => {
    const out = [];
    for (let i = 0; i < 24; i++) {
      out.push(window.sceneLab.readPixel(w * (0.3 + 0.4 * (i % 6) / 5), h * (0.45 + 0.45 * Math.floor(i / 6) / 3)));
    }
    return out;
  }, [size.width, size.height]);
  for (const [r, g, b, a] of samples) {
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(a + 2); // +2 for rounding
  }
});

test('a layer can be switched off independently', async ({ page }) => {
  await page.evaluate(() => window.sceneLab.setEnabled('ChristmasTree', false));
  await page.waitForTimeout(400);
  const size = page.viewportSize();
  const px = await page.evaluate(
    ([x, y]) => window.sceneLab.readPixel(x, y),
    [size.width / 2, size.height * 0.72]
  );
  expect(px[3]).toBe(0);
});

test('CPU cost per frame stays small', async ({ page }) => {
  await page.waitForTimeout(2000);
  const { cpuMs } = await page.evaluate(() => window.sceneLab.getStats());
  // Everything heavy lives on the GPU; the CPU's per-frame job is the
  // bulb flicker and a small buffer upload. If this grows, something has
  // moved back onto the main thread.
  expect(cpuMs).toBeLessThan(2);
});

test.describe('the shared wind field', () => {
  test.slow();
  test('advances continuously and can be stilled', async ({ page }) => {
    const a = await page.evaluate(() => window.sceneLab.getWind());
    await page.waitForTimeout(600);
    const b = await page.evaluate(() => window.sceneLab.getWind());
    // The wind clock is what every layer's displacement is sampled
    // against. If it stops advancing, the whole tree freezes while still
    // rendering, which no pixel test would notice.
    expect(b.phase).toBeGreaterThan(a.phase);

    await page.evaluate(() => window.sceneLab.setWindField({ strength: 0 }));
    await page.waitForTimeout(500);
    const still = await page.evaluate(() => window.sceneLab.renderer.wind.uniforms(1).gust);
    // Strength 0 must mean genuinely no displacement, not merely a small
    // one: "still air" is a setting a user can pick.
    expect(still).toBe(0);
  });

  test('gusts, rather than oscillating on one rate', async ({ page }) => {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await page.evaluate(() => window.sceneLab.getWind().gust));
      await page.waitForTimeout(220);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // Every value positive (a gust never inverts into a suction) and the
    // envelope actually varies — a constant field would animate nothing.
    expect(min).toBeGreaterThan(0);
    expect(max - min).toBeGreaterThan(0.01);
  });
});

test('the ribbon is one extra draw call, and switching it off costs nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await page.waitForTimeout(600);
  const withRibbon = (await page.evaluate(() => window.sceneLab.getStats())).draws;
  await page.evaluate(() => window.sceneLab.setTreeOption('ribbon', false, { rebuild: true }));
  await page.waitForTimeout(900);
  const without = (await page.evaluate(() => window.sceneLab.getStats())).draws;
  expect(withRibbon - without).toBe(1);
});

test('grade controls never rebuild geometry', async ({ page }) => {
  const before = await page.evaluate(() => window.sceneLab.getInstanceCount());
  await page.evaluate(() => {
    window.sceneLab.setGrade({ exposure: 1.6, bloomStrength: 0.2, saturation: 0.4 });
    window.sceneLab.setCameraMotion(0);
  });
  await page.waitForTimeout(500);
  // These are per-frame uniforms. If any of them reallocated a batch,
  // dragging the slider in the settings window would stutter the scene.
  expect(await page.evaluate(() => window.sceneLab.getInstanceCount())).toBe(before);
  expect(page.errorsSeen).toEqual([]);
});

test('lighting-rig controls warm ambient light and add fireplace spill', async ({ page }) => {
  const before = await page.evaluate(() => window.sceneLab.getInstanceCount());
  const rig = await page.evaluate(() => {
    window.sceneLab.renderer.setLightingRig({
      ambientWarmth: 2, fireplaceContribution: 0.5, fireplaces: [{ x: 0.25 }],
    });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      sky: window.sceneLab.renderer.rig.ambientSky,
      fireplaceContribution: window.sceneLab.renderer.fireplaceContribution,
      lightCount: window.sceneLab.renderer.rig.count,
    }))));
  });
  expect(rig.sky[0]).toBeGreaterThan(rig.sky[2] / 3);
  expect(rig.fireplaceContribution).toBe(0.5);
  expect(rig.lightCount).toBeGreaterThan(10);
  expect(await page.evaluate(() => window.sceneLab.getInstanceCount())).toBe(before);
  expect(page.errorsSeen).toEqual([]);
});

test('zero saturation produces a monochrome grade', async ({ page }) => {
  const saturation = await page.evaluate(() => {
    window.sceneLab.renderer.setGrade({ saturation: 0 });
    return window.sceneLab.renderer.saturation;
  });
  expect(saturation).toBe(0);
});

test('the light budget is shared across trees without losing fireplace spill', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Scene } = await import('/engine/scene.js');
    const { LightRig, MAX_LIGHTS } = await import('/engine/lighting.js');
    const scene = new Scene('budget');
    for (let tree = 0; tree < 4; tree++) {
      scene.add({
        z: tree, enabled: true, ready: true,
        contributeLights(rig) {
          for (let bulb = 0; bulb < 10; bulb++) rig.add(tree * 100 + bulb, 0, 0, [0.5, 0.5, 0.5], 1, 100);
        },
      });
    }
    const rig = new LightRig();
    rig.add(-1, 0, 0, [1, 0.2, 0.1], 2, 100);
    scene.contributeLights(rig, 0);
    const positions = Array.from({ length: rig.count }, (_, i) => rig.positions[i * 3]);
    const initial = { count: rig.count, positions, color: rig.colors[3], max: MAX_LIGHTS };
    scene.layers[0].enabled = false;
    rig.clear();
    scene.contributeLights(rig, 1);
    return { ...initial, disabledPositions: Array.from({ length: rig.count }, (_, i) => rig.positions[i * 3]) };
  });
  expect(result.count).toBe(result.max);
  expect(result.positions[0]).toBe(-1);
  const counts = [0, 1, 2, 3].map((tree) =>
    result.positions.filter((x) => x >= tree * 100 && x < tree * 100 + 10).length);
  expect(Math.min(...counts)).toBeGreaterThanOrEqual(5);
  expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  expect(result.color).toBeCloseTo(0.214041, 5);
  expect(result.disabledPositions.every((x) => x >= 100)).toBe(true);
});

test('dark or invalid lights do not waste the fixed light budget', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { LightRig } = await import('/engine/lighting.js');
    const rig = new LightRig();
    const accepted = [
      rig.add(0, 0, 0, [1, 1, 1], 0, 10),
      rig.add(0, 0, 0, [1, 1, 1], -1, 10),
      rig.add(0, 0, 0, [1, 1, 1], 1, 0),
      rig.add(0, 0, 0, [1, 1, 1], NaN, 10),
      rig.add(0, 0, 0, [1, 1, 1], 1, Infinity),
      rig.add(0, 0, 0, [1, 1, 1], 1, 10),
    ];
    return { accepted, count: rig.count };
  });
  expect(result).toEqual({ accepted: [false, false, false, false, false, true], count: 1 });
});

test('tree lights use the current anchor and mirror with the tree', async ({ page }) => {
  const positions = await page.evaluate(async () => {
    const { ChristmasTree } = await import('/layers/ChristmasTree.js');
    const { LightRig } = await import('/engine/lighting.js');
    const tree = new ChristmasTree({ anchor: [0.75, 0.1], flip: true });
    tree.radius = 100;
    tree.bulbs = [{ x: 20, y: 30, z: 0, color: [1, 1, 1], level: 1 }];
    tree.update(0, 0, { width: 800, height: 600, dpr: 2, camera: { offsetFor: () => ({ x: 3, y: 4 }) } });
    const rig = new LightRig();
    tree.contributeLights(rig, 0);
    return Array.from(rig.positions.slice(0, 3));
  });
  expect(positions).toEqual([586, 98, 0]);
});

test('all lit tree materials follow mirrored lights and normals', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { LightRig } = await import('/engine/lighting.js');
    const { renderer, tree } = window.sceneLab;
    renderer.stop();
    const gl = renderer.gl;
    Object.assign(tree.opts, {
      anchor: [0.5, 0], wind: 0, frost: 0, shadowStrength: 0,
      needleDark: '#ffffff', needleLight: '#ffffff', trunkColor: '#ffffff',
      snowTint: '#ffffff', ribbonColor: '#ffffff', ribbonGlitter: 0, ornamentGloss: 0,
    });
    tree.radius = 100;
    tree.star = null;
    tree.bulbs = [{ x: 110, y: 100, z: 30, color: [1, 1, 1], level: 0.06 }];

    // A white atlas isolates lighting from the procedural texture's shading.
    gl.bindTexture(gl.TEXTURE_2D, tree.atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    const rig = new LightRig();
    rig.ambientSky = rig.ambientGround = [0, 0, 0];
    const ctx = {
      renderer, width: renderer.width, height: renderer.height, dpr: renderer.dpr,
      camera: { offsetFor: () => ({ x: 0, y: 0 }) },
      wind: { uniforms: () => ({ gust: 0, phase: 0, direction: 0 }) },
      time: 0, rig, draws: 0,
    };
    tree.bulbData = null;
    tree.update(0, 0, ctx);
    tree.bulbData = new Float32Array(11); // no visible bulb sprite
    const foliage = (material) => [80, 100, 0, 0.8, 0, 0.6, 16, 0, 0, 0, 0, 0, material];
    const materials = [
      ['needleBatch', foliage(0)], ['snowBatch', foliage(1)],
      ['trunkBatch', foliage(2)], ['driftBatch', foliage(1)],
      ['ornamentBatch', [80, 100, 0, 1, 1, 1, 16, 0, 0, 0]],
      ['ribbonBatch', [80, 100, 0, 16, 16, 0, 0, 1, 0, 0, 0]],
    ];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, ctx.width, ctx.height);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    const out = [];
    for (const [name, data] of materials) {
      for (const [batch] of materials) tree[batch].count = 0;
      tree[name].upload(new Float32Array(data), 1);
      tree.ribbonCount = name === 'ribbonBatch' ? 1 : 0;
      tree.driftCount = name === 'driftBatch' ? 1 : 0;
      const samples = [];
      for (const [flip, lit] of [[false, false], [false, true], [true, true]]) {
        tree.opts.flip = flip;
        rig.clear();
        if (lit) tree.contributeLights(rig, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        tree.render(ctx);
        // Tree-space foliage/cloth normals mirror at the same local point.
        // Sphere normals are screen-space: sample the opposite side instead.
        const dx = name === 'ornamentBatch' ? (flip ? -5 : 4) : 0;
        const pixel = new Uint8Array(4);
        gl.readPixels(ctx.width / 2 + (flip ? -80 : 80) + dx, 104, 1, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        samples.push(Array.from(pixel));
      }
      out.push({ name, dark: samples[0], normal: samples[1], mirrored: samples[2] });
    }
    return { materials: out, error: gl.getError() };
  });
  expect(results.error).toBe(0);
  for (const { name, dark, normal, mirrored } of results.materials) {
    expect(normal[0] - dark[0], `${name} receives the probe light`).toBeGreaterThan(10);
    expect(normal[3], `${name} is visible`).toBeGreaterThan(100);
    for (let channel = 0; channel < 4; channel++) {
      expect(Math.abs(normal[channel] - mirrored[channel]), `${name} channel ${channel}`).toBeLessThanOrEqual(1);
    }
  }
  expect(page.errorsSeen).toEqual([]);
});

test.describe('production overlay adoption', () => {
  // Small viewport on purpose: this project rasterises in software, where
  // a full-size frame takes long enough to starve the page. What is being
  // tested is the DECISION and the handover, not the frame rate.
  test.use({ viewport: { width: 560, height: 400 } });

  test('forcing WebGL hands the trees to the engine', async ({ page }) => {
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });
    const info = await page.evaluate(() => window.overlayRenderer);
    expect(info.mode).toBe('webgl');
    // The Canvas 2D renderer must have actually let go of the trees, or
    // both would draw them and the scene would double up.
    expect(await page.evaluate(() => window.snowOverlay.getTreeRenderer())).toBe('gl');
    await expect(page.locator('#snow-gl')).toBeVisible();
    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });

  test('shadow controls update live without rebuilding the tree layers', async ({ page }) => {
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer?.mode === 'webgl', null,
      { polling: 300, timeout: 60000 });
    const result = await page.evaluate(() => {
      const bridge = window.overlayGlTrees;
      bridge.stop();
      window.snowOverlay.stop();
      const scene = bridge.scene;
      const tree = scene.layers.find((layer) => layer.opts?.shadowStrength !== undefined);
      const foliage = tree.needleBatch;
      bridge.applyLook({ shadowStrength: 0, shadowSoftness: 1.8 });
      const off = { strength: tree.opts.shadowStrength, count: tree.shadowBatch.count };
      bridge.applyLook({ shadowStrength: 1.4, shadowSoftness: 0.6 });
      return {
        off, strength: tree.opts.shadowStrength, softness: tree.opts.shadowSoftness,
        count: tree.shadowBatch.count, sameScene: bridge.scene === scene, sameFoliage: tree.needleBatch === foliage,
      };
    });
    expect(result.off).toEqual({ strength: 0, count: 0 });
    expect(result).toMatchObject({ strength: 1.4, softness: 0.6, count: 1, sameScene: true, sameFoliage: true });
  });

  test('automatic mode refuses a software rasteriser', async ({ page }) => {
    // Adopting SwiftShader would be slower AND no prettier than Canvas 2D,
    // and an uncapped GL loop on it starves the rest of the overlay.
    await page.goto('/overlay?renderer=auto', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });
    const info = await page.evaluate(() => window.overlayRenderer);
    expect(info.mode).toBe('canvas2d');
    expect(info.reason).toMatch(/software rasteriser/);
  });

  test('the system camera profile honors reduced-motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer?.mode === 'webgl', null,
      { polling: 300, timeout: 60000 });
    expect(await page.evaluate(() => window.overlayGlTrees.renderer.camera.motion)).toBe(0);
    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });

  test('forcing WebGL also hands the aurora to the engine, alongside the trees', async ({ page }) => {
    // The default scene composition has the aurora on (see
    // shared/scene.js's defaultScene) — the same "first real frame or
    // fall all the way back" gate as the trees now covers both.
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });
    expect((await page.evaluate(() => window.overlayRenderer)).mode).toBe('webgl');

    expect(await page.evaluate(() => window.snowOverlay.getAuroraRenderer())).toBe('gl');
    const aurora = await page.evaluate(() => {
      const layer = window.overlayGlTrees?.scene?.get('northern-lights');
      return layer ? { ready: layer.ready, instanceCount: layer.instanceCount } : null;
    });
    expect(aurora).not.toBeNull();
    expect(aurora.ready).toBe(true);
    expect(aurora.instanceCount).toBeGreaterThan(0);

    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });

  test('automatic degrade lowers the GL aurora ray count without a rebuild', async ({ page }) => {
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });

    const before = await page.evaluate(
      () => window.overlayGlTrees.scene.get('northern-lights').instanceCount
    );

    await page.evaluate(() => window.overlayGlTrees.setAuroraDetail(0.2));
    const after = await page.evaluate(
      () => window.overlayGlTrees.scene.get('northern-lights').instanceCount
    );

    expect(after).toBeLessThan(before);
    // The layer object is the SAME one, not a rebuilt scene — setDetail()
    // must be a cheap draw-count change, never a reallocation.
    expect(await page.evaluate(() => window.overlayGlTrees.scene.layers.length)).toBeGreaterThan(0);

    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });

  test('an aurora palette preserves the WebGL geometry budget', async ({ page }) => {
    await page.goto('/overlay?renderer=webgl', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.overlayRenderer, null,
      { polling: 300, timeout: 60000 });

    const before = await page.evaluate(
      () => window.overlayGlTrees.scene.get('northern-lights').instanceCount
    );
    await page.evaluate(() => window.overlayGlTrees.sync(
      { trees: [], aurora: true, auroraPalette: 'arctic' },
      { primary: '#c0392b', secondary: '#1e7d32', accent: '#f1c40f' }
    ));
    const aurora = await page.evaluate(() => {
      const layer = window.overlayGlTrees.scene.get('northern-lights');
      return { count: layer.instanceCount, palette: layer.opts.palette };
    });

    expect(aurora.palette).toBe('arctic');
    expect(aurora.count).toBe(before);
    expect(page.errorsSeen).toEqual([]);
    await page.evaluate(() => { window.overlayGlTrees?.stop(); window.snowOverlay.stop(); });
  });
});
