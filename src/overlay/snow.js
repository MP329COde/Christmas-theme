// Lightweight snow particle renderer. No Tauri-only APIs are used in the
// render path itself, so this file is directly testable via Playwright by
// loading index.html from a plain static server (see docs/ARCHITECTURE.md,
// section 5). Loading the initial theme/settings and reacting to live
// changes (below) does use the shared bridge, which itself no-ops outside
// Tauri.

import { getSettings, listThemes, onSettingsChanged } from '../shared/bridge.js';

const canvas = document.getElementById('snow');
const ctx = canvas.getContext('2d');

let flakes = [];
let config = {
  density: 120,
  wind: 0.3,
  flakeSize: 3,
  accumulate: true,
  color: '#ffffff',
};

let accumulation = []; // per-column snow height, only used when accumulate=true
let running = true;
let rafId = null;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  accumulation = new Array(Math.ceil(canvas.width / 4)).fill(0);
}
window.addEventListener('resize', resize);
resize();

function makeFlake() {
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    r: config.flakeSize * (0.5 + Math.random()),
    speed: 0.6 + Math.random() * 1.4,
    drift: Math.random() * Math.PI * 2,
    opacity: 0.5 + Math.random() * 0.5,
  };
}

export function setDensity(density) {
  config.density = density;
  if (flakes.length < density) {
    while (flakes.length < density) flakes.push(makeFlake());
  } else {
    flakes.length = density;
  }
}

export function setConfig(partial) {
  config = { ...config, ...partial };
  setDensity(config.density);
}

export function getParticleCount() {
  return flakes.length;
}

export function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
}

export function start() {
  if (!running) {
    running = true;
    tick();
  }
}

function tick() {
  if (!running) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const f of flakes) {
    f.y += f.speed;
    f.drift += 0.01;
    f.x += Math.sin(f.drift) * config.wind;

    const col = Math.max(0, Math.min(accumulation.length - 1, Math.floor(f.x / 4)));
    const groundY = config.accumulate
      ? canvas.height - accumulation[col]
      : canvas.height;

    if (f.y > groundY) {
      if (config.accumulate && accumulation[col] < 60) {
        accumulation[col] += 0.15;
      }
      Object.assign(f, makeFlake(), { y: -10 });
    }

    ctx.globalAlpha = f.opacity;
    ctx.fillStyle = config.color;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (config.accumulate) {
    ctx.fillStyle = config.color;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    for (let i = 0; i < accumulation.length; i++) {
      ctx.lineTo(i * 4, canvas.height - accumulation[i]);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fill();
  }

  rafId = requestAnimationFrame(tick);
}

setDensity(config.density);
tick();

// Expose for Playwright / manual debugging without a module bundler step.
window.snowOverlay = { setDensity, setConfig, getParticleCount, start, stop };

// Apply the theme's snow settings, but let a user-chosen density override
// the theme's own default so the settings window's slider stays authoritative.
function applyThemeAndSettings(theme, settings) {
  if (!theme) return;
  setConfig({
    density: settings?.snowDensity ?? theme.snow.density,
    wind: theme.snow.wind,
    flakeSize: theme.snow.flakeSize,
    accumulate: theme.snow.accumulate,
  });
}

async function initFromBackend() {
  try {
    const [themes, settings] = await Promise.all([listThemes(), getSettings()]);
    const theme = themes.find((t) => t.id === settings.themeId) ?? themes[0];
    applyThemeAndSettings(theme, settings);
  } catch (err) {
    // Overlay still renders with the built-in defaults above even if the
    // initial fetch fails (e.g. standalone Playwright run), rather than
    // showing a blank screen.
    console.error('Failed to load initial theme/settings for overlay:', err);
  }
}

// Exposed so tests (and anything else driving this page from the outside)
// can await the initial theme/settings load before asserting on state or
// calling setDensity() themselves — otherwise the async fetch above could
// resolve afterwards and silently overwrite a value the caller just set.
window.snowOverlayReady = initFromBackend();

// Live updates: react immediately when the settings window saves a new
// theme or density, instead of requiring an app restart.
onSettingsChanged(({ theme, settings }) => {
  applyThemeAndSettings(theme, settings);
});
