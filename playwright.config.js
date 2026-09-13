import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  snapshotDir: './tests/screenshots',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/dev-server.js',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      // Everything that is not the WebGL engine: the settings UI, the
      // Canvas 2D overlay and the dock strip. Deliberately WITHOUT the
      // SwiftShader flags below — forcing software GL in this container
      // stops requestAnimationFrame from being driven at all, which
      // silently froze the Canvas 2D render loop and made its frame-rate
      // test measure zero.
      name: 'chromium',
      testIgnore: /engine\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : undefined,
      },
    },
    {
      // The WebGL scene engine needs a GL implementation, which headless
      // Chromium has none of by default in a container. ANGLE over
      // SwiftShader renders correctly but in software, so this project
      // asserts on output pixels and CPU cost only — never on frame rate.
      name: 'chromium-gl',
      testMatch: /engine\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(process.env.PW_CHROMIUM_PATH
            ? { executablePath: process.env.PW_CHROMIUM_PATH }
            : {}),
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
});
