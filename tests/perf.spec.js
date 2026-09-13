import { test, expect } from '@playwright/test';

// Tests for the automatic quality governor (src/shared/perf.js), wired
// into the overlay by src/overlay/snow.js. Real degrade only triggers
// after several seconds of sustained overage/underage — far too slow to
// literally wait out in a test — so these drive the governor directly
// via `__simulateFrameCost`, a test-only hook that feeds synthetic frame
// costs at synthetic timestamps. That exercises the exact same code path
// production frames use (`quality.sample(ms, now)`), just without
// needing the page to actually be slow or waiting real wall-clock time.

test.beforeEach(async ({ page }) => {
  await page.goto('/overlay');
  await page.evaluate(() => window.snowOverlayReady);
});

test('sustained overage degrades quality, then recovers once load clears', async ({ page }) => {
  const result = await page.evaluate(() => {
    const overlay = window.snowOverlay;
    const start = overlay.getQualityTier();

    // A single slow frame must NOT degrade anything — only sustained
    // overage should. Feed one very expensive frame, then immediately
    // check nothing moved.
    overlay.__simulateFrameCost(200, performance.now());
    const afterOneSpike = overlay.getQualityTier();

    // Now feed sustained expensive frames (at a synthetic 60fps clock)
    // for long enough to walk ALL THE WAY DOWN to the lowest tier — each
    // step-down re-arms its own 3s sustain timer, so reaching the bottom
    // tier deterministically needs (tierCount - 1) * 3s+ of overage,
    // not just one threshold crossing.
    let now = performance.now();
    for (let i = 0; i < 650; i++) {
      now += 16.7;
      overlay.__simulateFrameCost(200, now);
    }
    const afterSustained = overlay.getQualityTier();

    // And now feed enough cheap frames to walk all the way back up —
    // recovery re-arms a 6s timer per step, so this needs proportionally
    // longer than the descent.
    for (let i = 0; i < 1300; i++) {
      now += 16.7;
      overlay.__simulateFrameCost(0.1, now);
    }
    const afterRecovery = overlay.getQualityTier();

    return {
      start: start.label,
      afterOneSpike: afterOneSpike.label,
      afterSustained: afterSustained.label,
      afterRecovery: afterRecovery.label,
    };
  });

  expect(result.start).toBe('full');
  // One isolated spike changes nothing — this is the hysteresis the spec
  // requires ("pas au premier pic isolé").
  expect(result.afterOneSpike).toBe('full');
  // Sustained overage long enough to walk all the way down must reach
  // the lowest tier.
  expect(result.afterSustained).toBe('minimum');
  // And sustained relief long enough must walk all the way back to full.
  expect(result.afterRecovery).toBe('full');
});

test('a degraded tier measurably reduces star and aurora density', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const mod = await import('/overlay/lights.js');
    const W = 1200;
    const H = 800;

    function countAlpha(detail) {
      mod.invalidateLights();
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      mod.drawSky(ctx, W, H, 3.0, {
        stars: true, aurora: true, auroraDetail: detail, starDetail: detail,
      });
      const data = ctx.getImageData(0, 0, W, H).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
      return lit;
    }

    return { full: countAlpha(1), minimum: countAlpha(0.3) };
  });

  // A lower detail level must draw visibly less: fewer lit pixels overall
  // (fewer/thinner aurora rays, fewer stars kept past the thinning cutoff).
  expect(result.minimum).toBeLessThan(result.full);
});

test('a struggling window pulls a sibling window down with it (shared quality channel)', async ({ browser }) => {
  // Two independent pages sharing the same origin — same as two overlay
  // windows on two monitors — communicating over the 'christmas-overlay
  // -quality' BroadcastChannel that shared/perf.js opens.
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await pageA.goto('/overlay');
    await pageA.evaluate(() => window.snowOverlayReady);
    await pageB.goto('/overlay');
    await pageB.evaluate(() => window.snowOverlayReady);

    // Drive page A into a degraded tier via sustained overage.
    await pageA.evaluate(() => {
      let now = performance.now();
      for (let i = 0; i < 260; i++) {
        now += 16.7;
        window.snowOverlay.__simulateFrameCost(200, now);
      }
    });
    const tierA = await pageA.evaluate(() => window.snowOverlay.getQualityTier().label);
    expect(tierA).not.toBe('full');

    // Page B never ran a single slow frame itself, but a message on the
    // shared channel should have arrived and pulled its EFFECTIVE tier
    // down to match — give the BroadcastChannel a brief moment to
    // deliver, then feed one cheap sample so the governor re-evaluates
    // (sample() is also where the peer tier is applied).
    await pageB.waitForTimeout(200);
    const tierB = await pageB.evaluate(() => {
      window.snowOverlay.__simulateFrameCost(0.1, performance.now());
      return window.snowOverlay.getQualityTier().label;
    });
    expect(tierB).not.toBe('full');
  } finally {
    await context.close();
  }
});
