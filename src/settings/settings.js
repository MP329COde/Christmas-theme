import {
  listThemes, getSettings, saveSettings, disableEverything, onStats, dockStatus,
} from '../shared/bridge.js';

const themeSelect = document.getElementById('theme-select');
const densityInput = document.getElementById('snow-density');
const densityValue = document.getElementById('snow-density-value');
const windInput = document.getElementById('snow-wind');
const windValue = document.getElementById('snow-wind-value');
const flakeScaleInput = document.getElementById('flake-scale');
const flakeScaleValue = document.getElementById('flake-scale-value');
const accumulateToggle = document.getElementById('accumulate-toggle');
const maxSnowInput = document.getElementById('max-snow-height');
const maxSnowValue = document.getElementById('max-snow-height-value');
const dockToggle = document.getElementById('dock-toggle');
const dockStatusEl = document.getElementById('dock-status');
const lightAnimationSelect = document.getElementById('light-animation');
const lightIntensityInput = document.getElementById('light-intensity');
const lightIntensityValue = document.getElementById('light-intensity-value');
const auroraToggle = document.getElementById('aurora-toggle');
const starsToggle = document.getElementById('stars-toggle');
const iciclesToggle = document.getElementById('icicles-toggle');
const glitterToggle = document.getElementById('glitter-toggle');
const treesToggle = document.getElementById('trees-toggle');
const garlandsToggle = document.getElementById('garlands-toggle');
const garlandStyleSelect = document.getElementById('garland-style');
const treeLightsToggle = document.getElementById('tree-lights-toggle');
const fireplaceToggle = document.getElementById('fireplace-toggle');
const stockingsToggle = document.getElementById('stockings-toggle');
const mantelGarlandToggle = document.getElementById('mantel-garland-toggle');
const decorScaleInput = document.getElementById('decor-scale');
const decorScaleValue = document.getElementById('decor-scale-value');
const fpsLimitSelect = document.getElementById('fps-limit');
const fpsReadout = document.getElementById('fps-readout');
const volumeInput = document.getElementById('volume');
const volumeValue = document.getElementById('volume-value');
const autostartToggle = document.getElementById('autostart-toggle');
const disableBtn = document.getElementById('disable-btn');
const status = document.getElementById('status');

let themes = [];
let settings;

function applyThemeColors(theme) {
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--primary', theme.colors.primary);
  root.style.setProperty('--secondary', theme.colors.secondary);
  root.style.setProperty('--accent', theme.colors.accent);
  root.style.setProperty('--background', theme.colors.background);
}

function currentTheme() {
  return themes.find((t) => t.id === themeSelect.value);
}

/// Keeps the slider's filled-track CSS variable in sync with its value —
/// a range input can't express "how far along am I" to CSS on its own.
function syncRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max === min ? 0 : ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function setStatus(text) {
  status.textContent = text;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => (status.textContent = ''), 1500);
}

async function persist() {
  settings = {
    themeId: themeSelect.value,
    snowDensity: Number(densityInput.value),
    snowWind: Number(windInput.value) / 100,
    snowAccumulate: accumulateToggle.checked,
    maxSnowHeight: Number(maxSnowInput.value),
    flakeScale: Number(flakeScaleInput.value) / 100,
    dockDecoration: dockToggle.checked,
    taskbarDecoration: dockToggle.checked,
    treesDecoration: treesToggle.checked,
    garlandsDecoration: garlandsToggle.checked,
    garlandStyle: garlandStyleSelect.value,
    treeLights: treeLightsToggle.checked,
    fireplaceDecoration: fireplaceToggle.checked,
    stockings: stockingsToggle.checked,
    mantelGarland: mantelGarlandToggle.checked,
    decorScale: Number(decorScaleInput.value) / 100,
    lightAnimation: lightAnimationSelect.value,
    lightIntensity: Number(lightIntensityInput.value) / 100,
    aurora: auroraToggle.checked,
    stars: starsToggle.checked,
    icicles: iciclesToggle.checked,
    snowGlitter: glitterToggle.checked,
    fpsLimit: Number(fpsLimitSelect.value),
    soundVolume: Number(volumeInput.value) / 100,
    autostart: autostartToggle.checked,
  };
  await saveSettings(settings);
  setStatus('Saved');
}

async function init() {
  themes = await listThemes();
  for (const theme of themes) {
    const opt = document.createElement('option');
    opt.value = theme.id;
    opt.textContent = theme.name;
    themeSelect.appendChild(opt);
  }

  settings = await getSettings();
  themeSelect.value = settings.themeId;
  densityInput.value = settings.snowDensity;
  densityValue.textContent = settings.snowDensity;
  windInput.value = Math.round(settings.snowWind * 100);
  windValue.textContent = `${Math.round(settings.snowWind * 100)}%`;
  accumulateToggle.checked = settings.snowAccumulate;
  maxSnowInput.value = settings.maxSnowHeight;
  maxSnowValue.textContent = `${settings.maxSnowHeight} px`;
  flakeScaleInput.value = Math.round(settings.flakeScale * 100);
  flakeScaleValue.textContent = `${Math.round(settings.flakeScale * 100)}%`;
  dockToggle.checked = settings.dockDecoration;
  treesToggle.checked = settings.treesDecoration;
  garlandsToggle.checked = settings.garlandsDecoration;
  garlandStyleSelect.value = settings.garlandStyle;
  treeLightsToggle.checked = settings.treeLights;
  fireplaceToggle.checked = settings.fireplaceDecoration;
  stockingsToggle.checked = settings.stockings;
  mantelGarlandToggle.checked = settings.mantelGarland;
  decorScaleInput.value = Math.round(settings.decorScale * 100);
  decorScaleValue.textContent = `${Math.round(settings.decorScale * 100)}%`;
  lightAnimationSelect.value = settings.lightAnimation;
  lightIntensityInput.value = Math.round(settings.lightIntensity * 100);
  lightIntensityValue.textContent = `${Math.round(settings.lightIntensity * 100)}%`;
  auroraToggle.checked = settings.aurora;
  starsToggle.checked = settings.stars;
  iciclesToggle.checked = settings.icicles;
  glitterToggle.checked = settings.snowGlitter;
  fpsLimitSelect.value = String(settings.fpsLimit);
  volumeInput.value = Math.round(settings.soundVolume * 100);
  volumeValue.textContent = `${Math.round(settings.soundVolume * 100)}%`;
  autostartToggle.checked = settings.autostart;

  for (const slider of [densityInput, windInput, volumeInput, maxSnowInput,
    flakeScaleInput, decorScaleInput, lightIntensityInput]) syncRangeFill(slider);
  applyThemeColors(currentTheme());
  refreshDockStatus();
}

/// Reports what the Dock/taskbar detection actually found. A toggle that
/// silently does nothing (auto-hidden Dock, no shell bar) is exactly the
/// failure mode this app had before, so it is spelled out here instead.
async function refreshDockStatus() {
  try {
    const { strips, reason } = await dockStatus();
    if (strips?.length) {
      const where = strips.map((s) => `${s.edge} (${s.barThickness}px)`).join(', ');
      dockStatusEl.textContent = `Detected on ${strips.length} screen(s): ${where}`;
    } else {
      dockStatusEl.textContent = reason ?? 'No Dock / taskbar strip detected.';
    }
  } catch {
    dockStatusEl.textContent = 'Dock / taskbar status unavailable.';
  }
}

themeSelect.addEventListener('change', async () => {
  applyThemeColors(currentTheme());
  await persist();
});

densityInput.addEventListener('input', () => {
  densityValue.textContent = densityInput.value;
  syncRangeFill(densityInput);
});
densityInput.addEventListener('change', persist);

windInput.addEventListener('input', () => {
  windValue.textContent = `${windInput.value}%`;
  syncRangeFill(windInput);
});
windInput.addEventListener('change', persist);

maxSnowInput.addEventListener('input', () => {
  maxSnowValue.textContent = `${maxSnowInput.value} px`;
  syncRangeFill(maxSnowInput);
});
maxSnowInput.addEventListener('change', persist);

flakeScaleInput.addEventListener('input', () => {
  flakeScaleValue.textContent = `${flakeScaleInput.value}%`;
  syncRangeFill(flakeScaleInput);
});
flakeScaleInput.addEventListener('change', persist);

decorScaleInput.addEventListener('input', () => {
  decorScaleValue.textContent = `${decorScaleInput.value}%`;
  syncRangeFill(decorScaleInput);
});
decorScaleInput.addEventListener('change', persist);

lightIntensityInput.addEventListener('input', () => {
  lightIntensityValue.textContent = `${lightIntensityInput.value}%`;
  syncRangeFill(lightIntensityInput);
});
lightIntensityInput.addEventListener('change', persist);

lightAnimationSelect.addEventListener('change', persist);
auroraToggle.addEventListener('change', persist);
starsToggle.addEventListener('change', persist);
iciclesToggle.addEventListener('change', persist);
glitterToggle.addEventListener('change', persist);

accumulateToggle.addEventListener('change', persist);
treeLightsToggle.addEventListener('change', persist);
stockingsToggle.addEventListener('change', persist);
mantelGarlandToggle.addEventListener('change', persist);
fpsLimitSelect.addEventListener('change', persist);
dockToggle.addEventListener('change', async () => {
  await persist();
  refreshDockStatus();
});
treesToggle.addEventListener('change', persist);
garlandsToggle.addEventListener('change', persist);
garlandStyleSelect.addEventListener('change', persist);
fireplaceToggle.addEventListener('change', persist);

volumeInput.addEventListener('input', () => {
  volumeValue.textContent = `${volumeInput.value}%`;
  syncRangeFill(volumeInput);
});
volumeInput.addEventListener('change', persist);

autostartToggle.addEventListener('change', persist);

disableBtn.addEventListener('click', async () => {
  await disableEverything();
  setStatus('Everything disabled');
});

// Live frame-rate readout straight from the overlay, so the cap setting
// and the 120fps target are something you can see rather than take on
// trust. Only ever arrives when running inside Tauri.
onStats(({ fps, frameMs, particles }) => {
  fpsReadout.textContent = `${fps} fps · ${frameMs} ms/frame · ${particles} flakes`;
});

init();
