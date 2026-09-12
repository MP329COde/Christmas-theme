// Thin IPC bridge. Falls back to localStorage + fetch when not running
// inside Tauri, so the same UI code is servable as a plain static page
// for Playwright tests (see docs/ARCHITECTURE.md, section 5).

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

const BUILTIN_THEMES = ['classic-red', 'frosty-blue', 'minimal-white'];

const DEFAULT_SETTINGS = {
  themeId: 'classic-red',
  snowDensity: 120,
  dockDecoration: true,
  taskbarDecoration: true,
  soundVolume: 0.4,
  autostart: false,
};

export async function listThemes() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('list_themes');
  }
  const themes = [];
  for (const id of BUILTIN_THEMES) {
    const res = await fetch(`/themes/${id}.json`);
    themes.push(await res.json());
  }
  return themes;
}

export async function getSettings() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('get_settings');
  }
  const raw = localStorage.getItem('christmas-theme-settings');
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings) {
  if (isTauri) {
    return window.__TAURI__.core.invoke('save_settings', { settings });
  }
  localStorage.setItem('christmas-theme-settings', JSON.stringify(settings));
}

export async function disableEverything() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('disable_everything');
  }
  localStorage.removeItem('christmas-theme-settings');
}

export { DEFAULT_SETTINGS };
