// Thin IPC bridge. Falls back to localStorage + fetch when not running
// inside Tauri, so the same UI code is servable as a plain static page
// for Playwright tests (see docs/ARCHITECTURE.md, section 5).

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

const BUILTIN_THEMES = [
  'classic-red',
  'frosty-blue',
  'minimal-white',
  'midnight-gold',
  'candy-cane',
  'gingerbread',
  'arctic-aurora',
  'santa-classic',
];

const DEFAULT_SETTINGS = {
  themeId: 'classic-red',
  snowDensity: 120,
  dockDecoration: true,
  taskbarDecoration: true,
  treesDecoration: true,
  garlandsDecoration: true,
  fireplaceDecoration: true,
  snowWind: 0.3,
  snowAccumulate: true,
  maxSnowHeight: 60,
  flakeScale: 1,
  garlandStyle: 'multicolor',
  treeLights: true,
  stockings: true,
  mantelGarland: true,
  decorScale: 1,
  lightAnimation: 'twinkle',
  lightIntensity: 1,
  aurora: true,
  stars: true,
  icicles: true,
  snowGlitter: true,
  // A permanent background wallpaper has no need of matching the
  // display's full refresh rate; 30fps is the default so a fresh install
  // never runs the overlay unconditionally uncapped (see shared/perf.js
  // for the rest of the performance budget this is part of).
  fpsLimit: 30,
  renderer: 'auto',
  soundVolume: 0.4,
  autostart: false,
  // Per-screen composition and saved presets. Null here rather than a
  // built-in default, so the renderer can tell "never configured" (use the
  // stock composition) from "configured to be empty".
  scene: null,
  presets: null,
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

/// Where the Dock/taskbar strip was found, or why it wasn't. The settings
/// window shows this next to the toggle so "it's on but nothing happens"
/// is always explained rather than silent.
export async function dockStatus() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('dock_status');
  }
  return { strips: [], reason: 'Dock/taskbar decoration only runs in the desktop app.' };
}

/// The connected displays, so the per-screen editor can name them. Outside
/// Tauri there is exactly one notional screen, which is what keeps the
/// settings UI testable as a plain page.
export async function listScreens() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('list_screens');
  }
  return [{
    index: 0, label: 'overlay-0', name: 'Preview display',
    x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: true,
    virtualOriginX: 0, virtualOriginY: 0,
  }];
}

/// Background images are stored per screen in their own files, never
/// inside settings.json: a 4K photo as a data URL is megabytes, and
/// putting it in the settings payload would mean rewriting and
/// re-broadcasting it on every slider change.
export async function saveBackground(key, dataUrl) {
  if (isTauri) {
    return window.__TAURI__.core.invoke('save_background', { key, dataUrl });
  }
  if (dataUrl) localStorage.setItem(`christmas-bg-${key}`, dataUrl);
  else localStorage.removeItem(`christmas-bg-${key}`);
}

export async function loadBackground(key) {
  if (isTauri) {
    return window.__TAURI__.core.invoke('load_background', { key });
  }
  return localStorage.getItem(`christmas-bg-${key}`);
}

export function onBackgroundChanged(callback) {
  if (!isTauri) return () => {};
  let unlisten = () => {};
  window.__TAURI__.event
    .listen('background-changed', (event) => callback(event.payload))
    .then((fn) => { unlisten = fn; });
  return () => unlisten();
}

export async function disableEverything() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('disable_everything');
  }
  localStorage.removeItem('christmas-theme-settings');
}

// Lets the overlay window(s) react live when settings are saved from the
// settings window, instead of only picking up changes on next launch.
// The backend (main.rs) emits 'settings-changed' with { settings, theme }
// right after save_settings persists. No equivalent exists outside Tauri
// since there's only one page/window when testing standalone.
export function onSettingsChanged(callback) {
  if (!isTauri) {
    return () => {};
  }
  let unlisten = () => {};
  window.__TAURI__.event
    .listen('settings-changed', (event) => callback(event.payload))
    .then((fn) => {
      unlisten = fn;
    });
  return () => unlisten();
}

// The overlay publishes its measured frame rate / frame cost so the
// settings window can display it. Broadcast straight over the Tauri event
// bus rather than through a Rust command: it fires twice a second and has
// no business touching the backend.
export function publishStats(stats) {
  if (!isTauri) return;
  try {
    window.__TAURI__.event.emit('overlay-stats', stats);
  } catch {
    /* the overlay must never break because stats couldn't be sent */
  }
}

/// Settings-window side of the above.
export function onStats(callback) {
  if (!isTauri) return () => {};
  let unlisten = () => {};
  window.__TAURI__.event
    .listen('overlay-stats', (event) => callback(event.payload))
    .then((fn) => { unlisten = fn; });
  return () => unlisten();
}

export { DEFAULT_SETTINGS };
