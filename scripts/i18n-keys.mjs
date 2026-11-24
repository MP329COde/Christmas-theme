// Recense toutes les chaînes traduisibles de l'interface (clé = texte
// français). Utilisé par tests/i18n.spec.js pour vérifier qu'aucune langue
// n'a de trou, et en ligne de commande pour lister ce qui manque :
//
//     node scripts/i18n-keys.mjs          # toutes les clés
//     node scripts/i18n-keys.mjs en       # clés absentes de src/i18n/en.js
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unescape = (s) => s.replace(/\\(.)/g, '$1');
const STR = "'((?:[^'\\\\]|\\\\.)*)'";

export async function collectKeys() {
  const keys = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim()) keys.add(s); };

  const js = await readFile(path.join(root, 'src/settings/settings.js'), 'utf8');
  const patterns = [
    new RegExp(`\\bt\\(${STR}`, 'g'),
    new RegExp(`\\blabel: ${STR}`, 'g'),
    new RegExp(`\\bsetStatus\\(${STR}`, 'g'),
    new RegExp(`\\bsection\\([^,]+, ${STR}`, 'g'),
    // Paires [valeur, 'Libellé'] des listes d'options et suites de libellés
    // dans les ternaires t(cond ? 'A' : 'B').
    new RegExp(`\\['[^']*', ${STR}`, 'g'),
    new RegExp(`[?:] ${STR}`, 'g'),
    // Troisième élément des listes : l'infobulle d'un choix.
    new RegExp(`\\['[^']*', '(?:[^'\\\\]|\\\\.)*', ${STR}`, 'g'),
  ];
  for (const re of patterns) {
    for (const m of js.matchAll(re)) {
      const text = unescape(m[1]);
      // Les identifiants (minuscule ASCII, couleur, sélecteur) ne sont pas des libellés.
      if (/^[a-z#.\[\d-]/.test(text) && !/\s/.test(text)) continue;
      if (/^(#|rgba?\(|\$\{|[a-z]+-[a-z-]+$)/.test(text) || text.length < 2) continue;
      // Ni lettre (pictogramme seul, ratio) ni majuscule/ponctuation (classes CSS) : pas un libellé.
      if (!/\p{L}/u.test(text) || /^[ a-z-]+$/.test(text)) continue;
      add(text);
    }
  }

  const scene = await import(pathToFileURL(path.join(root, 'src/shared/scene.js')).href);
  for (const table of [scene.LIGHT_PALETTE_LABELS, scene.LIGHT_MODE_LABELS, scene.AURORA_PALETTE_LABELS, scene.BULB_SHAPES]) {
    Object.values(table).forEach(add);
  }
  for (const table of [scene.BACKGROUND_PALETTES, scene.WEATHER_PROFILES, scene.CAMERA_MOTION_PROFILES,
    scene.TREE_STYLES, scene.HOLIDAY_DECORATION_TYPES, scene.GARLAND_STYLES, scene.ANIMATED_BACKGROUNDS,
    scene.DISPLAY_MODES, scene.PERFORMANCE_PROFILES, scene.SCENE_MODES]) {
    for (const entry of Object.values(table)) { add(entry.label); add(entry.hint); }
  }

  for (const file of await readdir(path.join(root, 'themes'))) {
    if (file.endsWith('.json')) add(JSON.parse(await readFile(path.join(root, 'themes', file), 'utf8')).name);
  }

  const html = await readFile(path.join(root, 'src/settings/index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n>([^<]+)</g)) add(m[1].trim());
  for (const m of html.matchAll(/(?:title|aria-label)="([^"]+)"[^>]*data-i18n-(?:title|aria)/g)) add(m[1]);

  // Chaînes produites ailleurs (Rust, pont IPC) mais affichées par l'interface.
  const rust = await readFile(path.join(root, 'src-tauri/src/decoration.rs'), 'utf8');
  for (const m of rust.matchAll(/^\s+"((?:[^"\\]|\\\n\s*|\\.)*)"$/gm)) {
    const text = m[1].replace(/\\\n\s*/g, '');
    if (/[.!]$/.test(text) && text.includes(' ')) add(text);
  }
  const bridge = await readFile(path.join(root, 'src/shared/bridge.js'), 'utf8');
  for (const m of bridge.matchAll(/reason: "([^"]+)"/g)) add(m[1]);
  add('Écran de prévisualisation');
  // Libellés en minuscules insérés dans une phrase (bord d'écran, palier de qualité).
  for (const word of ['bas', 'haut', 'gauche', 'droite', 'complète', 'réduite', 'basse', 'minimale']) add(word);
  return [...keys].sort((a, b) => a.localeCompare(b, 'fr'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = await collectKeys();
  const lang = process.argv[2];
  if (!lang) {
    console.log(JSON.stringify(keys, null, 1));
  } else {
    const dict = (await import(pathToFileURL(path.join(root, `src/i18n/${lang}.js`)).href)).default;
    const missing = keys.filter((k) => !(k in dict));
    console.log(JSON.stringify(missing, null, 1));
    console.error(`${missing.length} clé(s) manquante(s) sur ${keys.length}`);
  }
}
