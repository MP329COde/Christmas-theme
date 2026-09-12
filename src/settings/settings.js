import { listThemes, getSettings, saveSettings, disableEverything } from '../shared/bridge.js';

const themeSelect = document.getElementById('theme-select');
const densityInput = document.getElementById('snow-density');
const densityValue = document.getElementById('snow-density-value');
const windInput = document.getElementById('snow-wind');
const windValue = document.getElementById('snow-wind-value');
const accumulateToggle = document.getElementById('accumulate-toggle');
const dockToggle = document.getElementById('dock-toggle');
const treesToggle = document.getElementById('trees-toggle');
const garlandsToggle = document.getElementById('garlands-toggle');
const garlandStyleSelect = document.getElementById('garland-style');
const fireplaceToggle = document.getElementById('fireplace-toggle');
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
    dockDecoration: dockToggle.checked,
    taskbarDecoration: dockToggle.checked,
    treesDecoration: treesToggle.checked,
    garlandsDecoration: garlandsToggle.checked,
    garlandStyle: garlandStyleSelect.value,
    fireplaceDecoration: fireplaceToggle.checked,
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
  dockToggle.checked = settings.dockDecoration;
  treesToggle.checked = settings.treesDecoration;
  garlandsToggle.checked = settings.garlandsDecoration;
  garlandStyleSelect.value = settings.garlandStyle;
  fireplaceToggle.checked = settings.fireplaceDecoration;
  volumeInput.value = Math.round(settings.soundVolume * 100);
  volumeValue.textContent = `${Math.round(settings.soundVolume * 100)}%`;
  autostartToggle.checked = settings.autostart;

  applyThemeColors(currentTheme());
}

themeSelect.addEventListener('change', async () => {
  applyThemeColors(currentTheme());
  await persist();
});

densityInput.addEventListener('input', () => {
  densityValue.textContent = densityInput.value;
});
densityInput.addEventListener('change', persist);

windInput.addEventListener('input', () => {
  windValue.textContent = `${windInput.value}%`;
});
windInput.addEventListener('change', persist);

accumulateToggle.addEventListener('change', persist);
dockToggle.addEventListener('change', persist);
treesToggle.addEventListener('change', persist);
garlandsToggle.addEventListener('change', persist);
garlandStyleSelect.addEventListener('change', persist);
fireplaceToggle.addEventListener('change', persist);

volumeInput.addEventListener('input', () => {
  volumeValue.textContent = `${volumeInput.value}%`;
});
volumeInput.addEventListener('change', persist);

autostartToggle.addEventListener('change', persist);

disableBtn.addEventListener('click', async () => {
  await disableEverything();
  setStatus('Everything disabled');
});

init();
