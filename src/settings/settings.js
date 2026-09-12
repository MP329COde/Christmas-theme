import { listThemes, getSettings, saveSettings, disableEverything } from '../shared/bridge.js';

const themeSelect = document.getElementById('theme-select');
const densityInput = document.getElementById('snow-density');
const densityValue = document.getElementById('snow-density-value');
const dockToggle = document.getElementById('dock-toggle');
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
    dockDecoration: dockToggle.checked,
    taskbarDecoration: dockToggle.checked,
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
  dockToggle.checked = settings.dockDecoration;
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

dockToggle.addEventListener('change', persist);

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
