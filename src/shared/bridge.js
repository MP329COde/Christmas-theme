// Pont IPC fin. Rebondit sur localStorage + fetch quand il n'est pas dans Tauri,
// de sorte que la même interface peut être servée comme page statique simple
// pour les tests Playwright (voir docs/ARCHITECTURE.md, section 5).

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
  onboardingDone: false,
  language: 'auto',
  // Voir PERFORMANCE_PROFILES (shared/scene.js). « custom » rend la main à
  // fpsLimit / renderer / dprCap / minTier ci-dessous.
  performanceMode: 'balanced',
  dprCap: 2,
  minTier: 0,
  paused: false,
  displayMode: 'wallpaper',
  dockPlacement: 'behind',
  overlayOpacity: 1,
  sceneMode: null,
  snowColor: '#ffffff',
  snowSpeed: 1,
  flakeStyle: 'mixed', // mixed | soft | crystal
  // Décoration du Dock / de la barre des tâches.
  dockPalette: 'multicolor',
  dockGarland: true,
  dockIcicles: true,
  dockSnow: true,
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
  // Hors Tauri, les autres pages du même navigateur (aperçu) sont prévenues
  // par l'évènement « storage » ; voir onSettingsChanged.
}

/// Où la barre de Dock/tâches a été trouvée, ou pourquoi pas. Le panneau
/// de paramètres l'affiche à côté du bouton pour expliquer « activé mais
/// rien ne se passe » plutôt que de laisser un silence inexpliqué.
export async function dockStatus() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('dock_status');
  }
  return { strips: [], reason: "La décoration du Dock / de la barre des tâches ne fonctionne que dans l'application de bureau." };
}

/// Les écrans connectés, pour que l'éditeur par écran puisse les nommer.
/// Hors Tauri, un seul écran est théorique, ce qui garde l'interface
/// testable comme une page simple.
export async function listScreens() {
  if (isTauri) {
    return window.__TAURI__.core.invoke('list_screens');
  }
  return [{
    index: 0, label: 'overlay-0', name: 'Écran de prévisualisation',
    x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: true,
    virtualOriginX: 0, virtualOriginY: 0,
  }];
}

/// Les images d'arrière-plan sont stockées par écran dans leurs propres fichiers,
/// jamais dans settings.json : une photo 4K en URL de données fait des
/// mégaoctets, et l'écrire dans la charge utile des paramètres signifierait
/// la réécrire et la renvoyer à chaque changement de curseur.
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

/// Libellés traduits du menu de la barre des menus / zone de notification.
export async function setTrayLabels(labels) {
  if (isTauri) return window.__TAURI__.core.invoke('set_tray_labels', { labels });
  return undefined;
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

// Permet aux fenêtres de superposition de réagir en live quand les paramètres
// sont sauvegardés depuis la fenêtre des paramètres, au lieu d'attendre
// le prochain lancement.
// Le backend (main.rs) émet 'settings-changed' avec { settings, theme }
// juste après que save_settings a persisté. Aucun équivalent n'existe hors Tauri
// puisqu'il n'y a qu'une seule page/fenêtre lors des tests standalone.
export function onSettingsChanged(callback) {
  if (!isTauri) {
    // Aperçu dans un navigateur : une page d'aperçu ouverte à côté des
    // paramètres suit les enregistrements via l'évènement « storage ».
    const handler = async (e) => {
      if (e.key !== 'christmas-theme-settings') return;
      const settings = await getSettings();
      const themes = await listThemes();
      callback({ settings, theme: themes.find((x) => x.id === settings.themeId) ?? themes[0] });
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }
  let unlisten = () => {};
  window.__TAURI__.event
    .listen('settings-changed', (event) => callback(event.payload))
    .then((fn) => {
      unlisten = fn;
    });
  return () => unlisten();
}

// La superposition publie son taux de frames / coût par frame mesurés pour que
// la fenêtre des paramètres puisse les afficher. Diffusion directe sur le bus
// d'événements Tauri plutôt que via une commande Rust : elle se déclenche
// deux fois par seconde et n'a pas à toucher le backend.
export function publishStats(stats) {
  if (!isTauri) return;
  try {
    window.__TAURI__.event.emit('overlay-stats', stats);
  } catch {
    /* la superposition ne doit jamais échouer parce que les statistiques n'ont pas pu être envoyées */
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
