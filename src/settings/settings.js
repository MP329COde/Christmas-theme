// Settings window.
//
// The controls are BUILT FROM THE SCENE, not written out by hand in HTML,
// because the scene is now a list: any number of trees and fireplaces per
// screen, each with its own position, size, style and light string. A
// fixed set of toggles cannot express that, which is why the old page had
// exactly two trees and one fireplace baked into the renderer.
//
// The layout map is the other half of that answer. "Où cela va-t-il"
// is a spatial question, and a number field is a poor way to ask it, so
// each element is a marker you drag along a scale model of the screen.

import {
  listThemes, getSettings, saveSettings, disableEverything, onStats, dockStatus,
  listScreens, saveBackground, loadBackground, setTrayLabels, onSettingsChanged,
} from '../shared/bridge.js';
import {
  LIGHT_PALETTES, LIGHT_MODES, LIGHT_PALETTE_LABELS, LIGHT_MODE_LABELS, AURORA_PALETTE_LABELS, TREE_STYLES, AURORA_PALETTES, BACKGROUND_PALETTES, WEATHER_PROFILES, CAMERA_MOTION_PROFILES, HOLIDAY_DECORATION_TYPES, defaultScene, defaultScreen,
  defaultTree, defaultFireplace, defaultHolidayDecoration, screenConfig, makePreset, defaultLook,
  resolveNeedles, resolveFrost,
  GARLAND_STYLES, BULB_SHAPES, ANIMATED_BACKGROUNDS, isAnimatedBackground, DISPLAY_MODES, DOCK_PLACEMENTS,
  PERFORMANCE_PROFILES, resolvePerformance, SCENE_MODES, applySceneMode,
} from '../shared/scene.js';
import { t, setLanguage, getLanguage, translateDom, LANGUAGES } from '../i18n/index.js';

const EDGE_LABELS = { bottom: 'bas', top: 'haut', left: 'gauche', right: 'droite' };
const TIER_LABELS = { full: 'complète', reduced: 'réduite', low: 'basse', minimum: 'minimale' };

const panels = {
  scene: document.getElementById('panel-scene'),
  snow: document.getElementById('panel-snow'),
  lights: document.getElementById('panel-lights'),
  perf: document.getElementById('panel-perf'),
  system: document.getElementById('panel-system'),
};
const statusEl = document.getElementById('status');

let themes = [];
let screens = [];
let settings = null;
let activeScreen = 0;
let selectedElement = null; // { kind, id } — highlighted on the layout map

// ---------------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/// A range with a live readout. `format` turns the raw value into what the
/// readout shows, so a 0–1 setting can present itself as a percentage
/// without the stored value being one.
function slider({ id, label, min, max, step, value, format = (v) => v, onInput }) {
  const out = el('span', { class: 'val', id: id ? `${id}-value` : null, text: format(value) });
  const input = el('input', {
    type: 'range', min, max, step, value,
    id, 'data-testid': id,
    oninput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format(v);
      fill(e.target);
      onInput(v);
    },
  });
  fill(input);
  return el('div', {}, el('label', { for: id }, t(label), out), input);
}

function fill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max === min ? 0 : ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function toggle({ id, label, checked, onChange }) {
  return el('div', { class: 'row' },
    el('label', { for: id, text: t(label) }),
    el('input', {
      type: 'checkbox', id, 'data-testid': id, checked,
      onchange: (e) => onChange(e.target.checked),
    })
  );
}

function dropdown({ id, label, value, options, onChange }) {
  const select = el('select', {
    id, 'data-testid': id,
    onchange: (e) => onChange(e.target.value),
  });
  // Troisième élément à vrai : libellé à ne pas traduire (nom saisi par
  // l'utilisateur, valeur numérique).
  for (const [val, text, raw] of options) {
    select.append(el('option', { value: val, selected: String(val) === String(value) }, raw ? text : t(text)));
  }
  return label ? el('div', {}, el('label', { for: id, text: t(label) }), select) : select;
}

/// A labelled colour well. Deep customisation is mostly colour, and a
/// bare colour input gives no clue what it belongs to.
function colorField({ id, label, value, onInput }) {
  return el('div', { class: 'color-field' },
    el('label', { for: id, text: t(label) }),
    el('input', {
      type: 'color', id, 'data-testid': id, value,
      oninput: (e) => onInput(e.target.value),
    }));
}

/// A collapsed group. The per-element cards now carry a lot of controls,
/// and showing all of them at once turns the panel into a wall of
/// sliders: the common half stays visible, the rest is one click away
/// and REMEMBERS being open across re-renders — every edit rebuilds the
/// panel, so without this a drawer would slam shut on every keystroke.
const openSections = new Set();
function section(key, title, ...children) {
  return el('details', {
    class: 'section', open: openSections.has(key) || undefined,
    'data-testid': `section-${key}`,
    ontoggle: (e) => {
      if (e.target.open) openSections.add(key);
      else openSections.delete(key);
    },
  }, el('summary', { text: t(title) }), ...children);
}

function setStatus(text, vars) {
  statusEl.textContent = t(text, vars);
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

let saveTimer = null;
/// Dragging a slider fires continuously; writing the file and
/// broadcasting to every overlay window on each event would be hundreds
/// of writes per gesture. Coalesced, the overlay still updates while you
/// drag, just at a sane rate.
function persist({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  const run = async () => {
    await saveSettings(settings);
    setStatus('Enregistré');
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 140);
  return Promise.resolve();
}

function scene() {
  if (!settings.scene) settings.scene = defaultScene();
  if (!settings.scene.screens) settings.scene.screens = {};
  return settings.scene;
}

/// Copied screens and saved presets can share an image. Only overwrite a
/// storage slot when no other composition still refers to it.
function writableBackgroundKey(screen) {
  const used = new Set();
  const collect = (composition, exclude) => {
    for (const index of Object.keys(composition?.screens ?? {})) {
      if (index !== exclude) used.add(screenConfig(composition, index).backgroundImageKey);
    }
  };
  collect(scene(), String(screen));
  for (const preset of presetList()) collect(preset.settings?.scene);
  const current = screenConfig(scene(), screen).backgroundImageKey;
  if (current && !used.has(current)) return current;
  const base = `screen-${screen}`;
  let key = base;
  for (let suffix = 1; used.has(key); suffix++) key = `${base}-${suffix}`;
  return key;
}

/// The stored config for the active screen. Reading goes through
/// screenConfig so defaults are filled in; writing materialises an entry
/// for this screen, which is what makes a per-screen edit stop inheriting.
function currentScreen() {
  return screenConfig(scene(), activeScreen);
}

function editScreen(mutate) {
  const key = String(activeScreen);
  const next = screenConfig(scene(), activeScreen);
  mutate(next);
  scene().screens[key] = next;
  persist();
  renderScene();
}

// ---------------------------------------------------------------------------
// mode simple / avancé
// ---------------------------------------------------------------------------

/// Par défaut, la fenêtre n'expose que l'essentiel : où, quoi, quelle taille,
/// quelles couleurs. Tout le reste (curseurs de rendu, palettes
/// personnalisées, finitions) apparaît avec le mode avancé, mémorisé
/// d'une session à l'autre.
const ADVANCED_KEY = 'christmas-advanced';
let advanced = false;
try { advanced = localStorage.getItem(ADVANCED_KEY) === '1'; } catch { /* stockage indisponible */ }
document.body.classList.toggle('advanced', advanced);

/// Renvoie les nœuds seulement en mode avancé ; une liste vide sinon.
const adv = (...nodes) => (advanced ? nodes : []);

function setAdvanced(value) {
  advanced = value;
  try { localStorage.setItem(ADVANCED_KEY, value ? '1' : '0'); } catch { /* ignoré */ }
  document.body.classList.toggle('advanced', value);
  const sw = document.getElementById('advanced-toggle');
  if (sw) sw.checked = value;
  renderAll();
  refreshDockStatus();
}

/// Interrupteur compact en forme de pastille, pour les options à cocher
/// d'un élément (bas de Noël, bougies…) : plusieurs tiennent sur une ligne.
function chip({ id, label, checked, onChange }) {
  return el('label', { class: 'chip', for: id },
    el('input', {
      type: 'checkbox', id, 'data-testid': id, checked,
      onchange: (e) => onChange(e.target.checked),
    }),
    el('span', { text: t(label) }));
}

/// Choix exclusif présenté en boutons (ex. quantité de neige).
function segmented({ id, label, value, options, onChange }) {
  return el('div', {},
    el('label', { class: 'small', text: t(label) }),
    el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t(label), 'data-testid': id },
      options.map(([val, text, hint]) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(val === value),
        'data-testid': `${id}-${val}`, title: hint ? t(hint) : null,
        onclick: () => onChange(val),
      }, t(text)))));
}

function elementName(kind) {
  return t(kind === 'tree' ? 'Sapin' : kind === 'fireplace' ? 'Cheminée' : 'Décoration');
}

// ---------------------------------------------------------------------------
// light style editor — shared by garlands, trees and fireplaces
// ---------------------------------------------------------------------------

/// Un seul éditeur pour toutes les guirlandes. Palette et animation sont
/// toujours proposées ; vitesse, taille et luminosité sont avancées.
function lightStyleEditor(prefix, style, apply) {
  const paletteOptions = [
    ...Object.keys(LIGHT_PALETTES).map((k) => [k, LIGHT_PALETTE_LABELS[k] ?? k]),
    ['custom', 'Couleurs personnalisées'],
  ];
  const nodes = [
    el('div', { class: 'grid-2' },
      dropdown({
        id: `${prefix}-palette`, label: 'Couleurs', value: style.palette,
        options: paletteOptions,
        onChange: (v) => apply((s) => { s.palette = v; }),
      }),
      dropdown({
        id: `${prefix}-mode`, label: 'Animation', value: style.mode,
        options: LIGHT_MODES.map((m) => [m, LIGHT_MODE_LABELS[m] ?? m]),
        onChange: (v) => apply((s) => { s.mode = v; }),
      })
    ),
  ];

  if (style.palette === 'custom') {
    const colors = style.customColors ?? [];
    const swatches = colors.map((c, i) => el('input', {
      type: 'color', value: c, 'data-testid': `${prefix}-color-${i}`,
      oninput: (e) => apply((s) => { s.customColors = [...s.customColors]; s.customColors[i] = e.target.value; }),
    }));
    nodes.push(el('div', {},
      el('label', { class: 'small', text: t('Couleurs personnalisées') }),
      el('div', { class: 'swatches' },
        swatches,
        el('button', {
          class: 'remove', 'data-testid': `${prefix}-color-add`, text: '+',
          onclick: () => apply((s) => { s.customColors = [...s.customColors, '#ffffff']; }),
        }),
        colors.length > 1 && el('button', {
          class: 'remove', 'data-testid': `${prefix}-color-remove`, text: '−',
          onclick: () => apply((s) => { s.customColors = s.customColors.slice(0, -1); }),
        })
      )
    ));
  }

  if (advanced) {
    nodes.push(el('div', { class: 'grid-2' },
      slider({
        id: `${prefix}-speed`, label: 'Vitesse', min: 20, max: 300, step: 10,
        value: Math.round(style.speed * 100), format: (v) => `${v}%`,
        onInput: (v) => apply((s) => { s.speed = v / 100; }),
      }),
      slider({
        id: `${prefix}-bulb-size`, label: 'Taille des ampoules', min: 40, max: 220, step: 10,
        value: Math.round(style.size * 100), format: (v) => `${v}%`,
        onInput: (v) => apply((s) => { s.size = v / 100; }),
      })
    ));
    nodes.push(slider({
      id: `${prefix}-intensity`, label: 'Luminosité', min: 20, max: 200, step: 10,
      value: Math.round(style.intensity * 100), format: (v) => `${v}%`,
      onInput: (v) => apply((s) => { s.intensity = v / 100; }),
    }));
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// layout map
// ---------------------------------------------------------------------------

const MAP_GLYPHS = { tree: '🎄', fireplace: '🔥' };

/// Maquette de l'écran : chaque élément est un repère à faire glisser. Le
/// cadre reprend les proportions réelles de l'écran sélectionné, et un
/// clic sur un repère amène la carte de réglages correspondante.
function layoutMap(cfg) {
  const info = screens.find((s) => s.index === activeScreen);
  const ratio = info?.width && info?.height ? `${info.width} / ${info.height}` : '16 / 9';
  const map = el('div', { class: 'layout', 'data-testid': 'layout-map', style: `aspect-ratio:${ratio}` },
    el('div', { class: 'ground' }));

  const place = (kind, item, glyph, index) => {
    const size = Math.round(Math.max(26, Math.min(64, 40 * (item.scale ?? 1))));
    const marker = el('div', {
      class: 'marker',
      'data-testid': `marker-${kind}-${index}`,
      'aria-selected': selectedElement?.id === item.id,
      style: `left:${(item.x ?? 0.5) * 100}%`,
    },
      el('div', { class: 'glyph', style: `font-size:${size}px`, text: glyph }),
      el('span', { text: `${elementName(kind)} · ${Math.round((item.x ?? 0.5) * 100)}%` })
    );

    // Évènements de pointeur : fonctionne au trackpad, au tactile et sous
    // les entrées synthétiques de Playwright.
    marker.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      marker.setPointerCapture(ev.pointerId);
      selectedElement = { kind, id: item.id };
      for (const m of map.querySelectorAll('.marker')) m.setAttribute('aria-selected', String(m === marker));
      document.querySelector(`[data-testid="${kind}-card-${index}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const rect = map.getBoundingClientRect();
      const move = (e) => {
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        marker.style.left = `${x * 100}%`;
        marker.lastChild.textContent = `${elementName(kind)} · ${Math.round(x * 100)}%`;
        item.x = Math.round(x * 1000) / 1000;
      };
      const up = () => {
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        editScreen((s) => {
          const list = kind === 'tree' ? s.trees
            : kind === 'fireplace' ? s.fireplaces : s.decorations;
          const target = list.find((e) => e.id === item.id);
          if (target) target.x = item.x;
        });
      };
      marker.addEventListener('pointermove', move);
      marker.addEventListener('pointerup', up);
    });
    map.append(marker);
  };

  (cfg.fireplaces ?? []).forEach((f, i) => place('fireplace', f, MAP_GLYPHS.fireplace, i));
  (cfg.trees ?? []).forEach((t, i) => place('tree', t, MAP_GLYPHS.tree, i));
  (cfg.decorations ?? []).forEach((d, i) => place(
    'decoration', d, HOLIDAY_DECORATION_TYPES[d.type]?.glyph ?? '🎁', i,
  ));
  return el('div', {}, map,
    el('p', { class: 'layout-hint', text: t('Faites glisser un élément pour le placer. Les positions sont une fraction de la largeur de l\'écran : elles résistent à un changement de résolution.') }));
}

// ---------------------------------------------------------------------------
// panels — scène
// ---------------------------------------------------------------------------

function backgroundCard(cfg) {
  const card = el('div', { class: 'card' },
    dropdown({
      id: 'background-mode', label: 'Décor de fond', value: cfg.background,
      options: [['none', 'Aucun (voir le bureau)'], ...Object.entries(ANIMATED_BACKGROUNDS).map(([id, b]) => [id, b.label]), ['image', 'Image personnelle']],
      onChange: (v) => editScreen((s) => { s.background = v; }),
    }));
  if (settings.displayMode === 'front' && cfg.background !== 'none') {
    card.append(el('p', { class: 'hint', text: t('Le décor de fond n\'est pas affiché en mode « Par-dessus tout » : il masquerait vos fenêtres.') }));
  }
  if (cfg.background !== 'image' && !isAnimatedBackground(cfg.background)) return card;

  if (cfg.background === 'image') {
    card.append(
      el('label', { class: 'ghost file', style: 'text-align:center' }, t('Choisir une image…'),
        el('input', {
          type: 'file', accept: 'image/*', hidden: true, 'data-testid': 'background-file',
          onchange: async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const screen = activeScreen;
            const reader = new FileReader();
            reader.onload = async () => {
              try {
                const key = writableBackgroundKey(screen);
                await saveBackground(key, String(reader.result));
                const next = screenConfig(scene(), screen);
                next.backgroundImageKey = key;
                scene().screens[String(screen)] = next;
                await persist({ immediate: true });
                setStatus('Arrière-plan mis à jour');
              } catch {
                setStatus('Impossible d\'enregistrer l\'image');
              }
            };
            reader.onerror = () => setStatus('Impossible de lire l\'image');
            // Lue en data URL puis confiée à Rust : l'image ne transite
            // jamais par settings.json.
            reader.readAsDataURL(file);
          },
        })),
      el('button', {
        class: 'remove', 'data-testid': 'background-clear', text: t('Retirer l\'image'),
        onclick: async () => {
          const screen = activeScreen;
          try {
            const key = writableBackgroundKey(screen);
            await saveBackground(key, null);
            const next = screenConfig(scene(), screen);
            next.backgroundImageKey = key;
            scene().screens[String(screen)] = next;
            await persist({ immediate: true });
            setStatus('Arrière-plan retiré');
          } catch {
            setStatus('Impossible de retirer l\'image');
          }
        },
      }));
  } else {
    card.append(dropdown({
      id: 'background-palette', label: 'Ambiance du paysage', value: cfg.backgroundPalette,
      options: [...Object.entries(BACKGROUND_PALETTES).map(([key, p]) => [key, p.label]), ['custom', 'Couleurs personnalisées']],
      onChange: (v) => editScreen((s) => {
        if (v === 'custom') {
          const palette = BACKGROUND_PALETTES[s.backgroundPalette];
          if (palette) {
            s.backgroundSky = palette.sky;
            s.backgroundHorizon = palette.horizon;
            s.backgroundSnow = palette.snow;
          }
        }
        s.backgroundPalette = v;
      }),
    }));
    if (cfg.backgroundPalette === 'custom') {
      card.append(el('div', { class: 'grid-2' },
        ...[['sky', 'Ciel', 'backgroundSky'], ['horizon', 'Horizon', 'backgroundHorizon'], ['snow', 'Neige', 'backgroundSnow']]
          .map(([slug, label, key]) => colorField({
            id: `background-${slug}`, label, value: cfg[key],
            onInput: (v) => editScreen((s) => { s[key] = v; }),
          }))));
    }
  }

  if (!advanced) return card;

  card.append(
    el('div', { class: 'grid-2' },
      cfg.background === 'image' && dropdown({
        id: 'background-fit', label: 'Ajustement', value: cfg.backgroundFit,
        options: [['cover', 'Recouvrir'], ['contain', 'Contenir'], ['stretch', 'Étirer'], ['tile', 'Mosaïque']],
        onChange: (v) => editScreen((s) => { s.backgroundFit = v; }),
      }),
      slider({
        id: 'background-opacity', label: 'Opacité', min: 10, max: 100, step: 5,
        value: Math.round((cfg.backgroundOpacity ?? 1) * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.backgroundOpacity = v / 100; }),
      })),
    el('div', { class: 'grid-2' },
      dropdown({
        id: 'background-animation', label: 'Animation', value: cfg.backgroundAnimation ?? 'drift',
        options: [['none', 'Statique'], ['drift', 'Dérive flottante'], ['kenburns', 'Zoom cinématique']],
        onChange: (v) => editScreen((s) => {
          s.backgroundAnimation = v;
          if (v === 'none') s.backgroundMotion = 0;
          else if ((s.backgroundMotion ?? 0) <= 0) s.backgroundMotion = 1;
        }),
      }),
      slider({
        id: 'background-motion', label: 'Mouvement', min: 0, max: 200, step: 10,
        value: Math.round((cfg.backgroundMotion ?? 1) * 100), format: (v) => (v === 0 ? t('Immobile') : `${v}%`),
        onInput: (v) => editScreen((s) => { s.backgroundMotion = v / 100; }),
      })));
  if (['animated-forest', 'alpine-lake', 'village', 'sleigh-night'].includes(cfg.background)) {
    card.append(el('div', { class: 'grid-2' },
      slider({
        id: 'background-fog', label: 'Brume de vallée', min: 0, max: 100, step: 5,
        value: Math.round(cfg.backgroundFog * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.backgroundFog = v / 100; }),
      }),
      slider({
        id: 'background-moon', label: 'Clair de lune', min: 0, max: 200, step: 10,
        value: Math.round(cfg.backgroundMoon * 100), format: (v) => (v === 0 ? t('Pas de lune') : `${v}%`),
        onInput: (v) => editScreen((s) => { s.backgroundMoon = v / 100; }),
      }),
      slider({
        id: 'background-moon-x', label: 'Lune : position horizontale', min: 0, max: 100, step: 1,
        value: Math.round(cfg.backgroundMoonX * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.backgroundMoonX = v / 100; }),
      }),
      slider({
        id: 'background-moon-y', label: 'Lune : position verticale', min: 0, max: 65, step: 1,
        value: Math.round(cfg.backgroundMoonY * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.backgroundMoonY = v / 100; }),
      })));
  }
  card.append(
    el('p', { class: 'hint', text: t('Les mouvements d\'arrière-plan se mettent en pause lorsque votre système demande une réduction de mouvement.') }),
    el('p', {
      class: 'hint', 'data-testid': 'background-renderer-info',
      text: t('Les images d\'arrière-plan utilisent le rendu Canvas 2D. WebGL, quand disponible, rend les arbres et l\'aurore ; Canvas 2D prend le relais si son démarrage échoue.'),
    }));
  return card;
}

function skyCard(cfg) {
  const sky = el('div', { class: 'card' },
    toggle({ id: 'aurora-toggle', label: '🌌 Aurore boréale', checked: cfg.aurora,
      onChange: (v) => editScreen((s) => { s.aurora = v; }) }));
  if (cfg.aurora && advanced) {
    const paletteOptions = [
      ...Object.keys(AURORA_PALETTES).filter((k) => k !== 'custom').map((name) => [name, AURORA_PALETTE_LABELS[name] ?? name]),
      ['custom', 'Couleurs personnalisées'],
    ];
    sky.append(dropdown({
      id: 'aurora-palette', label: 'Couleurs de l\'aurore', value: cfg.auroraPalette ?? 'classic',
      options: paletteOptions,
      onChange: (v) => editScreen((s) => { s.auroraPalette = v; }),
    }));
    if (cfg.auroraPalette === 'custom') {
      const colors = cfg.auroraCustomColors?.colors ?? ['#5cffb0', '#82ebff', '#d678ff'];
      const hazes = cfg.auroraCustomColors?.haze ?? ['#40be8c', '#50aadc', '#965ad2'];
      const edit = (key, i) => (e) => editScreen((s) => {
        s.auroraCustomColors = { ...(s.auroraCustomColors ?? { colors, haze: hazes }) };
        s.auroraCustomColors[key][i] = e.target.value;
      });
      sky.append(el('div', {},
        el('label', { class: 'small', text: t('Couleurs des rideaux / de la brume') }),
        el('div', { class: 'swatches' }, ...colors.map((col, i) => el('div', { class: 'swatch-row' },
          el('input', { type: 'color', value: col, 'data-testid': `aurora-color-${i}`, oninput: edit('colors', i) }),
          el('input', { type: 'color', value: hazes[i] ?? '#000000', 'data-testid': `aurora-haze-${i}`, oninput: edit('haze', i) }))))));
    }
    sky.append(slider({
      id: 'aurora-intensity', label: 'Intensité de l\'aurore', min: 20, max: 200, step: 10,
      value: Math.round((cfg.auroraIntensity ?? 1) * 100), format: (v) => `${v}%`,
      onInput: (v) => editScreen((s) => { s.auroraIntensity = v / 100; }),
    }));
  }
  sky.append(toggle({ id: 'stars-toggle', label: '⭐ Étoiles et étoiles filantes', checked: cfg.stars,
    onChange: (v) => editScreen((s) => { s.stars = v; }) }));
  if (cfg.stars && advanced) {
    sky.append(el('div', { class: 'grid-2' },
      slider({
        id: 'star-density', label: 'Densité d\'étoiles', min: 25, max: 200, step: 25,
        value: Math.round((cfg.starDensity ?? 1) * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.starDensity = v / 100; }),
      }),
      slider({
        id: 'shooting-star-frequency', label: 'Étoiles filantes', min: 0, max: 200, step: 25,
        value: Math.round((cfg.shootingStarFrequency ?? 1) * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.shootingStarFrequency = v / 100; }),
      })));
  }
  sky.append(
    toggle({ id: 'icicles-toggle', label: '🧊 Stalactites de glace', checked: cfg.icicles,
      onChange: (v) => editScreen((s) => { s.icicles = v; }) }),
    toggle({ id: 'glitter-toggle', label: '✨ Scintillement de la neige au sol', checked: cfg.snowGlitter,
      onChange: (v) => editScreen((s) => { s.snowGlitter = v; }) }));
  return sky;
}

function garlandCard(cfg) {
  const garland = el('div', { class: 'card' },
    toggle({ id: 'garland-enabled', label: 'Guirlande en haut de l\'écran', checked: cfg.garland.enabled,
      onChange: (v) => editScreen((s) => { s.garland.enabled = v; }) }));
  if (cfg.garland.enabled) {
    garland.append(el('div', { class: 'grid-2' },
      dropdown({
        id: 'garland-style', label: 'Style de guirlande', value: cfg.garland.style ?? 'classic',
        options: Object.entries(GARLAND_STYLES).map(([id, g]) => [id, g.label]),
        onChange: (v) => editScreen((s) => { s.garland.style = v; }),
      }),
      (cfg.garland.style ?? 'classic') === 'classic' && dropdown({
        id: 'garland-bulb-shape', label: 'Forme des ampoules', value: cfg.garland.bulbShape ?? 'drop',
        options: Object.entries(BULB_SHAPES),
        onChange: (v) => editScreen((s) => { s.garland.bulbShape = v; }),
      })));
    garland.append(slider({
      id: 'garland-swags', label: 'Nombre de festons', min: 1, max: 10, step: 1,
      value: cfg.garland.swags ?? 3, format: (v) => String(v),
      onInput: (v) => editScreen((s) => { s.garland.swags = v; }),
    }));
    if (advanced) {
      garland.append(slider({
        id: 'garland-glow', label: 'Halo des ampoules', min: 0, max: 200, step: 10,
        value: Math.round((cfg.garland.glow ?? 1) * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.garland.glow = v / 100; }),
      }));
      garland.append(el('div', { class: 'grid-2' },
        slider({
          id: 'garland-sag', label: 'Affaissement', min: 20, max: 250, step: 10,
          value: Math.round(cfg.garland.sag * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.garland.sag = v / 100; }),
        }),
        slider({
          id: 'garland-spacing', label: 'Espacement des ampoules', min: 40, max: 260, step: 10,
          value: Math.round(cfg.garland.spacing * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.garland.spacing = v / 100; }),
        })));
    }
    garland.append(...lightStyleEditor('garland', cfg.garland.lights,
      (fn) => editScreen((s) => fn(s.garland.lights))));
  }
  return garland;
}

/// En-tête commun des cartes d'élément : titre, repère de position, suppression.
function cardHead(kind, item, i, title) {
  return el('div', { class: 'card-head' },
    el('div', { class: 'card-title' }, title,
      kind !== 'decoration' && el('span', { class: 'badge', text: `${Math.round(item.x * 100)}%` })),
    el('button', {
      class: 'remove', 'data-testid': `${kind}-remove-${i}`, text: t('Supprimer'),
      onclick: () => editScreen((s) => {
        const list = kind === 'tree' ? s.trees : kind === 'fireplace' ? s.fireplaces : s.decorations;
        list.splice(i, 1);
      }),
    }));
}

function positionSizeRow(idPrefix, item, list, i, { min, max }) {
  return el('div', { class: 'grid-2' },
    slider({
      id: `${idPrefix}-x`, label: 'Position', min: 0, max: 100, step: 1,
      value: Math.round(item.x * 100), format: (v) => `${v}%`,
      onInput: (v) => editScreen((s) => { s[list][i].x = v / 100; }),
    }),
    slider({
      id: `${idPrefix}-scale`, label: 'Taille', min, max, step: 5,
      value: Math.round(item.scale * 100), format: (v) => `${v}%`,
      onInput: (v) => editScreen((s) => { s[list][i].scale = v / 100; }),
    }));
}

function treeCard(tree, i) {
  const needles = resolveNeedles(tree);
  const edit = (fn) => editScreen((s) => fn(s.trees[i]));
  return el('div', { class: 'card', 'data-testid': `tree-card-${i}`, 'data-selected': selectedElement?.id === tree.id },
    cardHead('tree', tree, i, `🎄 ${t('Sapin')}`),
    positionSizeRow(`tree-${i}`, tree, 'trees', i, { min: 30, max: 260 }),
    dropdown({
      id: `tree-${i}-style`, label: 'Essence', value: tree.style,
      options: Object.entries(TREE_STYLES).map(([k, v]) => [k, v.label]),
      onChange: (v) => edit((t) => { t.style = v; }),
    }),
    el('div', { class: 'chips' },
      chip({ id: `tree-${i}-star`, label: '⭐ Étoile', checked: tree.star, onChange: (v) => edit((t) => { t.star = v; }) }),
      chip({ id: `tree-${i}-lights`, label: '💡 Guirlande', checked: tree.lightsOn, onChange: (v) => edit((t) => { t.lightsOn = v; }) }),
      chip({ id: `tree-${i}-ribbon`, label: '🎀 Ruban', checked: tree.ribbon, onChange: (v) => edit((t) => { t.ribbon = v; }) })),
    ...adv(
      el('div', { class: 'grid-2' },
        dropdown({
          id: `tree-${i}-flip`, label: 'Orientation', value: String(tree.flip),
          options: [['false', 'Normale'], ['true', 'Miroir']],
          onChange: (v) => edit((t) => { t.flip = v === 'true'; }),
        }),
        slider({
          id: `tree-${i}-ornaments`, label: 'Boules', min: 0, max: 250, step: 10,
          value: Math.round(tree.ornaments * 100), format: (v) => `${v}%`,
          onInput: (v) => edit((t) => { t.ornaments = v / 100; }),
        })),
      slider({
        id: `tree-${i}-snow`, label: 'Neige sur les branches', min: 0, max: 200, step: 10,
        value: Math.round(tree.snow * 100), format: (v) => `${v}%`,
        onInput: (v) => edit((t) => { t.snow = v / 100; }),
      }),
      section(`tree-${i}-foliage`, '🌲 Feuillage et finition',
        dropdown({
          id: `tree-${i}-needle-mode`, label: 'Couleur des aiguilles',
          value: tree.needleColors ?? 'auto',
          options: [['auto', 'Par défaut (essence)'], ['custom', 'Personnalisée']],
          onChange: (v) => edit((t) => {
            // Point de départ : la couleur actuellement affichée, pas un vert sans rapport.
            if (v === 'custom') { t.needleDark = needles.dark; t.needleLight = needles.light; }
            t.needleColors = v;
          }),
        }),
        tree.needleColors === 'custom' && el('div', { class: 'grid-2' },
          colorField({ id: `tree-${i}-needle-dark`, label: 'Ombre', value: needles.dark,
            onInput: (v) => edit((t) => { t.needleDark = v; }) }),
          colorField({ id: `tree-${i}-needle-light`, label: 'Reflet', value: needles.light,
            onInput: (v) => edit((t) => { t.needleLight = v; }) })),
        el('div', { class: 'grid-2' },
          slider({
            id: `tree-${i}-frost`, label: 'Givre sur les pointes', min: 0, max: 100, step: 5,
            value: Math.round(resolveFrost(tree) * 100), format: (v) => `${v}%`,
            onInput: (v) => edit((t) => { t.frost = v / 100; }),
          }),
          slider({
            id: `tree-${i}-sway`, label: 'Balancement au vent', min: 0, max: 200, step: 10,
            value: Math.round((tree.sway ?? 1) * 100), format: (v) => `${v}%`,
            onInput: (v) => edit((t) => { t.sway = v / 100; }),
          })),
        slider({
          id: `tree-${i}-gloss`, label: 'Finition des boules', min: 0, max: 100, step: 5,
          value: Math.round((tree.ornamentGloss ?? 1) * 100),
          format: (v) => t(v < 25 ? 'Mat' : v > 75 ? 'Miroir' : 'Satiné'),
          onInput: (v) => edit((t) => { t.ornamentGloss = v / 100; }),
        })),
      tree.ribbon && section(`tree-${i}-ribbon-style`, '🎀 Style du ruban',
        colorField({ id: `tree-${i}-ribbon-color`, label: 'Couleur', value: tree.ribbonColor ?? '#c0392b',
          onInput: (v) => edit((t) => { t.ribbonColor = v; }) }),
        el('div', { class: 'grid-2' },
          slider({
            id: `tree-${i}-ribbon-width`, label: 'Largeur', min: 40, max: 220, step: 10,
            value: Math.round((tree.ribbonWidth ?? 1) * 100), format: (v) => `${v}%`,
            onInput: (v) => edit((t) => { t.ribbonWidth = v / 100; }),
          }),
          slider({
            id: `tree-${i}-ribbon-turns`, label: 'Tours', min: 1, max: 9, step: 1,
            value: tree.ribbonTurns ?? 4, format: (v) => `${v}×`,
            onInput: (v) => edit((t) => { t.ribbonTurns = v; }),
          }))),
      tree.star && section(`tree-${i}-star-style`, '⭐ Style de l\'étoile',
        colorField({ id: `tree-${i}-star-color`, label: 'Couleur', value: tree.starColor ?? '#fff0c2',
          onInput: (v) => edit((t) => { t.starColor = v; }) }),
        slider({
          id: `tree-${i}-star-size`, label: 'Taille du halo', min: 40, max: 200, step: 10,
          value: Math.round((tree.starSize ?? 1) * 100), format: (v) => `${v}%`,
          onInput: (v) => edit((t) => { t.starSize = v / 100; }),
        })),
      tree.lightsOn && el('div', { class: 'card nested' },
        ...lightStyleEditor(`tree-${i}`, tree.lights, (fn) => edit((t) => fn(t.lights))))));
}

function decorationCard(decoration, i) {
  const type = HOLIDAY_DECORATION_TYPES[decoration.type] ? decoration.type : 'presents';
  const info = HOLIDAY_DECORATION_TYPES[type];
  const ownColor = /^#[0-9a-f]{6}$/i.test(decoration.color ?? '');
  const theme = themes.find((th) => th.id === settings.themeId);
  return el('div', { class: 'card', 'data-testid': `decoration-card-${i}`, 'data-selected': selectedElement?.id === decoration.id },
    cardHead('decoration', decoration, i, `${info.glyph} ${t(info.label)}`),
    dropdown({
      id: `decoration-${i}-type`, label: 'Décoration', value: type,
      options: Object.entries(HOLIDAY_DECORATION_TYPES).map(([id, item]) => [id, item.label]),
      onChange: (v) => editScreen((s) => {
        s.decorations[i].type = v;
        s.decorations[i].y = HOLIDAY_DECORATION_TYPES[v].y;
      }),
    }),
    el('div', { class: 'grid-2' },
      slider({
        id: `decoration-${i}-x`, label: 'Position', min: 0, max: 100, step: 1,
        value: Math.round(decoration.x * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.decorations[i].x = v / 100; }),
      }),
      slider({
        id: `decoration-${i}-scale`, label: 'Taille', min: 50, max: 200, step: 10,
        value: Math.round(decoration.scale * 100), format: (v) => `${v}%`,
        onInput: (v) => editScreen((s) => { s.decorations[i].scale = v / 100; }),
      })),
    slider({
      id: `decoration-${i}-y`, label: 'Hauteur', min: 0, max: 100, step: 1,
      value: Math.round(decoration.y * 100), format: (v) => `${v}%`,
      onInput: (v) => editScreen((s) => { s.decorations[i].y = v / 100; }),
    }),
    el('div', { class: 'chips' },
      chip({ id: `decoration-${i}-flip`, label: 'Miroir', checked: decoration.flip === true,
        onChange: (v) => editScreen((s) => { s.decorations[i].flip = v; }) }),
      chip({ id: `decoration-${i}-own-color`, label: 'Couleur personnalisée', checked: ownColor,
        onChange: (v) => editScreen((s) => { s.decorations[i].color = v ? (theme?.colors.primary ?? '#c0392b') : 'theme'; }) })),
    ownColor && colorField({
      id: `decoration-${i}-color`, label: 'Couleur', value: decoration.color,
      onInput: (v) => editScreen((s) => { s.decorations[i].color = v; }),
    }),
    ...adv(slider({
      id: `decoration-${i}-opacity`, label: 'Opacité', min: 10, max: 100, step: 5,
      value: Math.round((decoration.opacity ?? 1) * 100), format: (v) => `${v}%`,
      onInput: (v) => editScreen((s) => { s.decorations[i].opacity = v / 100; }),
    })));
}

function fireplaceCard(fire, i) {
  const style = fire.fireplaceStyle ?? 'classic';
  const edit = (fn) => editScreen((s) => fn(s.fireplaces[i]));
  return el('div', { class: 'card', 'data-testid': `fireplace-card-${i}`, 'data-selected': selectedElement?.id === fire.id },
    cardHead('fireplace', fire, i, `🔥 ${t('Cheminée')}`),
    positionSizeRow(`fire-${i}`, fire, 'fireplaces', i, { min: 40, max: 250 }),
    el('div', { class: 'grid-2' },
      dropdown({
        id: `fire-${i}-style`, label: 'Style', value: style,
        options: [['classic', 'Classique (briques)'], ['rustic', 'Rustique (pierre)'], ['modern', 'Moderne (panneau)']],
        onChange: (v) => edit((f) => { f.fireplaceStyle = v; }),
      }),
      style === 'classic' && dropdown({
        id: `fire-${i}-brick`, label: 'Briques', value: fire.brick ?? 'red',
        options: [['red', 'Rouges'], ['ochre', 'Ocre'], ['grey', 'Gris pierre'], ['white', 'Blanches']],
        onChange: (v) => edit((f) => { f.brick = v; }),
      })),
    slider({
      id: `fire-${i}-flame`, label: 'Feu', min: 30, max: 200, step: 5,
      value: Math.round((fire.flameIntensity ?? 1) * 100),
      format: (v) => (v < 60 ? t('Braises') : v > 140 ? t('Brasier') : `${v}%`),
      onInput: (v) => edit((f) => { f.flameIntensity = v / 100; }),
    }),
    el('div', { class: 'chips' },
      chip({ id: `fire-${i}-stockings`, label: '🧦 Bas de Noël', checked: fire.stockings, onChange: (v) => edit((f) => { f.stockings = v; }) }),
      chip({ id: `fire-${i}-swag`, label: '🌿 Guirlande', checked: fire.mantelGarland, onChange: (v) => edit((f) => { f.mantelGarland = v; }) }),
      chip({ id: `fire-${i}-candles`, label: '🕯️ Bougies', checked: fire.candles, onChange: (v) => edit((f) => { f.candles = v; }) }),
      style === 'classic' && chip({ id: `fire-${i}-wreath`, label: '🎄 Couronne', checked: fire.wreath === true, onChange: (v) => edit((f) => { f.wreath = v; }) }),
      chip({ id: `fire-${i}-screen`, label: '🛡️ Pare-feu', checked: fire.fireScreen === true, onChange: (v) => edit((f) => { f.fireScreen = v; }) })),
    ...adv(
      style === 'classic' && colorField({
        id: `fire-${i}-mantel-color`, label: 'Couleur du manteau', value: fire.mantelColor ?? '#ece6d8',
        onInput: (v) => edit((f) => { f.mantelColor = v; }),
      }),
      el('div', { class: 'card nested' },
        el('label', { class: 'small', text: t('Lumières de la cheminée') }),
        ...lightStyleEditor(`fire-${i}`, fire.lights, (fn) => edit((f) => fn(f.lights))))));
}

/// Carte de mode : pictogramme, nom et une ligne de description.
function modeCard(id, mode, { selected, onPick, prefix = 'mode' }) {
  return el('button', {
    type: 'button', class: `mode-card${selected ? ' selected' : ''}`,
    'data-testid': `${prefix}-${id}`, 'aria-pressed': String(!!selected), onclick: onPick,
  },
    el('span', { class: 'mode-glyph', 'aria-hidden': 'true', text: mode.glyph }),
    el('strong', { text: t(mode.label) }),
    el('small', { text: t(mode.hint) }));
}

function addRow(buttons) {
  return el('div', { class: 'add-row' }, ...buttons);
}

function renderScene() {
  const cfg = currentScreen();
  const panel = panels.scene;
  panel.replaceChildren();

  // --- modes ----------------------------------------------------------
  panel.append(el('h2', { text: t('Modes') }));
  panel.append(el('div', { class: 'mode-grid', 'data-testid': 'mode-grid' },
    ...Object.entries(SCENE_MODES).map(([id, mode]) => modeCard(id, mode, {
      selected: settings.sceneMode === id,
      onPick: () => {
        applySceneMode(settings, id, activeScreen);
        selectedElement = null;
        applyThemeColors();
        persist({ immediate: true });
        renderAll();
        setStatus('Mode « {name} » appliqué', { name: t(mode.label) });
      },
    }))));
  panel.append(el('p', { class: 'hint', text: t('Un mode recompose l\'écran sélectionné en un clic. Tout reste modifiable ensuite.') }));

  // --- écran -----------------------------------------------------------
  panel.append(el('h2', { text: t('Écran') }));
  const chips = el('div', { class: 'screens' });
  for (const s of screens) {
    chips.append(el('button', {
      class: 'screen-chip',
      'data-testid': `screen-chip-${s.index}`,
      'aria-pressed': s.index === activeScreen,
      onclick: () => { activeScreen = s.index; selectedElement = null; renderScene(); },
    }, el('strong', { text: s.primary ? t('{name} (principal)', { name: s.name }) : s.name }),
       el('small', { text: `${s.width}×${s.height}` })));
  }
  panel.append(chips);
  if (screens.length > 1) {
    panel.append(el('p', { class: 'hint', 'data-testid': 'screen-hint',
      text: t('Chaque écran garde sa propre composition. Les modifications ne concernent que l\'écran sélectionné.') }));
  }
  panel.append(el('div', { class: 'card' },
    toggle({
      id: 'screen-enabled', label: 'Décorer cet écran', checked: cfg.enabled !== false,
      onChange: (v) => editScreen((s) => { s.enabled = v; }),
    })));

  // --- disposition et éléments ----------------------------------------
  panel.append(el('h2', { text: t('Disposition') }));
  panel.append(el('div', { class: 'card' }, layoutMap(cfg)));

  panel.append(el('h2', { text: t('Sapins ({n})', { n: cfg.trees.length }) }));
  cfg.trees.forEach((tree, i) => panel.append(treeCard(tree, i)));
  panel.append(el('button', {
    class: 'add', 'data-testid': 'tree-add', text: t('+ Ajouter un sapin'),
    onclick: () => editScreen((s) => {
      // Un nouveau sapin prend une place libre plutôt que d'empiler le précédent.
      const used = s.trees.map((t) => t.x);
      let x = 0.5;
      for (const candidate of [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4, 0.6]) {
        if (!used.some((u) => Math.abs(u - candidate) < 0.06)) { x = candidate; break; }
      }
      s.trees.push(defaultTree({ x, flip: x > 0.5 }));
    }),
  }));

  panel.append(el('h2', { text: t('Cheminées ({n})', { n: cfg.fireplaces.length }) }));
  cfg.fireplaces.forEach((fire, i) => panel.append(fireplaceCard(fire, i)));
  panel.append(el('button', {
    class: 'add', 'data-testid': 'fireplace-add', text: t('+ Ajouter une cheminée'),
    // Le thème actif peut suggérer un style pour une cheminée neuve ; les
    // cheminées existantes ne changent jamais rétroactivement.
    onclick: () => editScreen((s) => {
      const theme = themes.find((th) => th.id === settings.themeId);
      s.fireplaces.push(defaultFireplace({ x: 0.5, fireplaceStyle: theme?.fireplaceStyle ?? 'classic' }));
    }),
  }));

  panel.append(el('h2', { text: t('Décorations ({n})', { n: cfg.decorations.length }) }));
  cfg.decorations.forEach((d, i) => panel.append(decorationCard(d, i)));
  panel.append(el('button', {
    class: 'add', 'data-testid': 'decoration-add', text: t('+ Ajouter une décoration'),
    onclick: () => editScreen((s) => {
      const used = s.decorations.map((d) => d.x);
      const x = [0.2, 0.8, 0.35, 0.65, 0.5].find((candidate) =>
        !used.some((u) => Math.abs(u - candidate) < 0.08)) ?? 0.5;
      s.decorations.push(defaultHolidayDecoration({ x }));
    }),
  }));

  // --- ambiance de l'écran --------------------------------------------
  panel.append(el('h2', { text: t('Arrière-plan') }), backgroundCard(cfg));
  panel.append(el('h2', { text: t('Ciel et givre') }), skyCard(cfg));
  panel.append(el('h2', { text: t('Guirlande lumineuse') }), garlandCard(cfg));

  panel.append(el('button', {
    class: 'add', 'data-testid': 'screen-reset', text: t('Réinitialiser cet écran'),
    style: 'margin-top:10px',
    onclick: () => editScreen((s) => Object.assign(s, defaultScreen())),
  }));
}

// ---------------------------------------------------------------------------
// panels — neige, ambiance, système
// ---------------------------------------------------------------------------

const SNOW_LEVELS = [
  ['light', 'Légère', 60], ['normal', 'Normale', 120], ['heavy', 'Forte', 320], ['storm', 'Tempête', 500],
];

function renderSnow() {
  const panel = panels.snow;
  const cfg = currentScreen();
  panel.replaceChildren();

  const level = SNOW_LEVELS.find(([, , d]) => d === settings.snowDensity)?.[0] ?? '';
  panel.append(el('h2', { text: t('Chute de neige') }));
  const fall = el('div', { class: 'card' });
  if (advanced) {
    fall.append(slider({
      id: 'snow-density', label: 'Densité', min: 0, max: 600, step: 10,
      value: settings.snowDensity, format: (v) => String(v),
      onInput: (v) => { settings.snowDensity = v; persist(); },
    }));
  } else {
    fall.append(segmented({
      id: 'snow-level', label: 'Quantité de neige', value: level,
      options: SNOW_LEVELS.map(([id, text]) => [id, text]),
      onChange: (id) => {
        settings.snowDensity = SNOW_LEVELS.find(([k]) => k === id)[2];
        persist();
        renderSnow();
      },
    }));
  }
  fall.append(slider({
    id: 'snow-wind', label: 'Vent', min: 0, max: 100, step: 5,
    value: Math.round(settings.snowWind * 100), format: (v) => (v === 0 ? t('Calme') : `${v}%`),
    onInput: (v) => { settings.snowWind = v / 100; persist(); },
  }));
  if (advanced) {
    fall.append(slider({
      id: 'flake-scale', label: 'Taille des flocons', min: 40, max: 250, step: 10,
      value: Math.round(settings.flakeScale * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.flakeScale = v / 100; persist(); },
    }));
  }
  fall.append(slider({
    id: 'snow-speed', label: 'Vitesse de chute', min: 30, max: 250, step: 10,
    value: Math.round((settings.snowSpeed ?? 1) * 100), format: (v) => `${v}%`,
    onInput: (v) => { settings.snowSpeed = v / 100; persist(); },
  }));
  fall.append(el('div', { class: 'grid-2' },
    dropdown({
      id: 'flake-style', label: 'Forme des flocons', value: settings.flakeStyle ?? 'mixed',
      options: [['mixed', 'Mélange naturel'], ['soft', 'Flocons doux'], ['crystal', 'Cristaux étoilés']],
      onChange: (v) => { settings.flakeStyle = v; persist(); },
    }),
    colorField({
      id: 'snow-color', label: 'Couleur de la neige', value: settings.snowColor ?? '#ffffff',
      onInput: (v) => { settings.snowColor = v; persist(); },
    })));
  panel.append(fall);

  panel.append(el('h2', { text: t('Neige au sol') }));
  const ground = el('div', { class: 'card' },
    toggle({
      id: 'accumulate-toggle', label: 'Accumuler au sol', checked: settings.snowAccumulate,
      onChange: (v) => { settings.snowAccumulate = v; persist(); },
    }));
  if (advanced) {
    ground.append(slider({
      id: 'max-snow-height', label: 'Épaisseur maximale', min: 0, max: 300, step: 10,
      value: settings.maxSnowHeight, format: (v) => `${v} px`,
      onInput: (v) => { settings.maxSnowHeight = v; persist(); },
    }));
  }
  panel.append(ground);

  if (!advanced) return;

  panel.append(el('h2', { text: t('Cet écran') }));
  const override = cfg.snowDensity !== 'inherit' && cfg.snowDensity != null;
  const card = el('div', { class: 'card' },
    dropdown({
      id: 'weather-profile', label: 'Profil météo', value: cfg.weatherProfile ?? 'winter',
      options: Object.entries(WEATHER_PROFILES).map(([id, profile]) => [id, profile.label]),
      onChange: (v) => editScreen((s) => { s.weatherProfile = v; }),
    }),
    toggle({
      id: 'snow-density-override', label: 'Densité propre à cet écran', checked: override,
      onChange: (v) => { editScreen((s) => { s.snowDensity = v ? settings.snowDensity : 'inherit'; }); renderSnow(); },
    }));
  if (override) {
    card.append(slider({
      id: 'screen-snow-density', label: 'Densité ici', min: 0, max: 600, step: 10,
      value: Number(cfg.snowDensity), format: (v) => String(v),
      onInput: (v) => editScreen((s) => { s.snowDensity = v; }),
    }));
  }
  panel.append(card);
}

function renderLights() {
  const panel = panels.lights;
  panel.replaceChildren();

  const theme = themes.find((th) => th.id === settings.themeId);
  panel.append(el('h2', { text: t('Couleurs') }));
  panel.append(el('div', { class: 'card' },
    dropdown({
      id: 'theme-select', label: 'Thème de couleurs', value: settings.themeId,
      options: themes.map((th) => [th.id, th.name]),
      onChange: (v) => { settings.themeId = v; applyThemeColors(); persist(); renderLights(); },
    }),
    theme && el('div', { class: 'theme-preview', 'aria-hidden': 'true' },
      ...['primary', 'secondary', 'accent', 'background'].map((k) => el('i', { style: `background:${theme.colors[k]}` })))));

  panel.append(el('h2', { text: t('Lumières') }));
  panel.append(el('div', { class: 'card' },
    dropdown({
      id: 'light-animation', label: 'Animation par défaut', value: settings.lightAnimation,
      options: LIGHT_MODES.map((m) => [m, LIGHT_MODE_LABELS[m] ?? m]),
      onChange: (v) => { settings.lightAnimation = v; persist(); },
    }),
    slider({
      id: 'light-intensity', label: 'Luminosité', min: 20, max: 200, step: 10,
      value: Math.round(settings.lightIntensity * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.lightIntensity = v / 100; persist(); },
    }),
    slider({
      id: 'decor-scale', label: 'Taille des décorations', min: 50, max: 200, step: 10,
      value: Math.round(settings.decorScale * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.decorScale = v / 100; persist(); },
    }),
    el('p', { class: 'hint', text: t('Chaque guirlande, sapin et cheminée peut aussi avoir ses propres couleurs (mode avancé, onglet Scène).') })));

  if (!advanced) return;

  // Tout ce qui suit est un paramètre par image du rendu GPU : aucune
  // géométrie à reconstruire, donc sûr à faire glisser en continu.
  const look = { ...defaultLook(), ...(currentScreen().look ?? {}) };
  const editLook = (key) => (v) => editScreen((s) => {
    s.look = { ...defaultLook(), ...(s.look ?? {}), [key]: v };
  });

  panel.append(el('h2', { text: t('Rendu de la scène') }));
  panel.append(el('div', { class: 'card' },
    el('p', { class: 'hint', text: t('S\'applique à la scène 3D de l\'écran sélectionné. Ces réglages de rendu changent instantanément et ne coûtent rien.') }),
    el('div', { class: 'grid-2' },
      slider({
        id: 'look-exposure', label: 'Exposition', min: 40, max: 200, step: 5,
        value: Math.round(look.exposure * 100), format: (v) => `${v}%`,
        onInput: (v) => editLook('exposure')(v / 100),
      }),
      slider({
        id: 'look-bloom', label: 'Halo lumineux', min: 0, max: 200, step: 5,
        value: Math.round(look.bloom * 100), format: (v) => `${v}%`,
        onInput: (v) => editLook('bloom')(v / 100),
      })),
    el('div', { class: 'grid-2' },
      slider({
        id: 'ambient-warmth', label: 'Chaleur ambiante', min: 0, max: 200, step: 5,
        value: Math.round(look.ambientWarmth * 100), format: (v) => `${v}%`,
        onInput: (v) => editLook('ambientWarmth')(v / 100),
      }),
      slider({
        id: 'fireplace-contribution', label: 'Lumière de la cheminée', min: 0, max: 200, step: 5,
        value: Math.round(look.fireplaceContribution * 100), format: (v) => `${v}%`,
        onInput: (v) => editLook('fireplaceContribution')(v / 100),
      })),
    slider({
      id: 'look-saturation', label: 'Intensité des couleurs', min: 0, max: 180, step: 5,
      value: Math.round(look.saturation * 100),
      format: (v) => (v === 0 ? t('Noir et blanc') : `${v}%`),
      onInput: (v) => editLook('saturation')(v / 100),
    }),
    el('div', { class: 'grid-2' },
      slider({
        id: 'look-shadow-strength', label: 'Profondeur des ombres', min: 0, max: 180, step: 5,
        value: Math.round((look.shadowStrength ?? 1) * 100),
        format: (v) => (v === 0 ? t('Désactivées') : `${v}%`),
        onInput: (v) => editLook('shadowStrength')(v / 100),
      }),
      slider({
        id: 'look-shadow-softness', label: 'Douceur des ombres', min: 40, max: 200, step: 5,
        value: Math.round((look.shadowSoftness ?? 1) * 100), format: (v) => `${v}%`,
        onInput: (v) => editLook('shadowSoftness')(v / 100),
      }))));

  panel.append(el('h2', { text: t('Vent et caméra') }));
  panel.append(el('div', { class: 'card' },
    el('p', { class: 'hint', text: t('Un seul champ de vent dirige toute la scène : boules, lumières et ruban suivent la même rafale que la branche qui les porte.') }),
    el('div', { class: 'grid-2' },
      slider({
        id: 'wind-strength', label: 'Force', min: 0, max: 250, step: 10,
        value: Math.round(look.windStrength * 100), format: (v) => (v === 0 ? t('Air calme') : `${v}%`),
        onInput: (v) => editLook('windStrength')(v / 100),
      }),
      slider({
        id: 'wind-gustiness', label: 'Rafales', min: 0, max: 200, step: 10,
        value: Math.round(look.windGustiness * 100), format: (v) => (v === 0 ? t('Régulier') : `${v}%`),
        onInput: (v) => editLook('windGustiness')(v / 100),
      })),
    slider({
      id: 'wind-direction', label: 'Direction dominante', min: -100, max: 100, step: 10,
      value: Math.round(look.windDirection * 100),
      format: (v) => (v === 0 ? t('Aucune') : v < 0 ? `← ${-v}%` : `${v}% →`),
      onInput: (v) => editLook('windDirection')(v / 100),
    }),
    dropdown({
      id: 'camera-motion-profile', label: 'Mouvement de caméra', value: look.cameraMotionProfile,
      options: Object.entries(CAMERA_MOTION_PROFILES).map(([id, profile]) => [id, profile.label]),
      onChange: editLook('cameraMotionProfile'),
    }),
    slider({
      id: 'camera-motion', label: 'Dérive de la caméra', min: 0, max: 200, step: 10,
      value: Math.round(look.cameraMotion * 100), format: (v) => (v === 0 ? t('Caméra fixe') : `${v}%`),
      onInput: (v) => editLook('cameraMotion')(v / 100),
    })));
}

const TIER_CHOICES = [['0', 'Complète'], ['1', 'Réduite'], ['2', 'Basse'], ['3', 'Minimale']];

/// Résumé en clair de ce qu'un profil fait réellement.
function perfSummary(perf) {
  return [
    perf.fpsLimit > 0 ? t('{n} images par seconde', { n: perf.fpsLimit }) : t('Cadence de l\'écran'),
    t('Résolution ×{n}', { n: perf.dprCap }),
    t(perf.renderer === 'canvas' ? 'Sapins en 2D (léger)' : 'Sapins en 3D si la carte graphique le permet'),
  ].join(' · ');
}

function setPerformanceMode(id) {
  const profile = PERFORMANCE_PROFILES[id];
  if (profile) {
    // Les réglages détaillés suivent le profil : repasser en
    // « Personnalisé » repart donc de ce qui était affiché.
    settings.fpsLimit = profile.fpsLimit;
    settings.renderer = profile.renderer;
    settings.dprCap = profile.dprCap;
    settings.minTier = profile.minTier;
  }
  settings.performanceMode = id;
}

/// Les cartes de profil, partagées par l'onglet Performances et l'assistant.
function perfCards(prefix, onPick) {
  const current = resolvePerformance(settings).mode;
  const entries = [
    ...Object.entries(PERFORMANCE_PROFILES).map(([id, p]) => [id, p.label, p.hint]),
    ['custom', 'Personnalisé', 'Vous réglez chaque paramètre vous-même'],
  ];
  const glyphs = { eco: '🍃', balanced: '⚖️', quality: '✨', custom: '🎛️' };
  return el('div', { class: 'mode-grid perf-grid', role: 'radiogroup', 'aria-label': t('Profil de performance') },
    ...entries.map(([id, label, hint]) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(current === id),
      class: `mode-card${current === id ? ' selected' : ''}`, 'data-testid': `${prefix}-${id}`,
      onclick: () => { setPerformanceMode(id); onPick(); },
    },
      el('span', { class: 'mode-glyph', 'aria-hidden': 'true', text: glyphs[id] }),
      el('strong', { text: t(label) }),
      el('small', { text: t(hint) }))));
}

function renderPerf() {
  const panel = panels.perf;
  panel.replaceChildren();
  const perf = resolvePerformance(settings);

  panel.append(el('h2', { text: t('Profil de performance') }));
  panel.append(perfCards('perf', () => { persist({ immediate: true }); renderPerf(); }));
  panel.append(el('p', { class: 'hint', 'data-testid': 'perf-summary', text: perfSummary(perf) }));
  panel.append(el('p', { class: 'hint', text: t('Le profil « Silencieux » limite la cadence et la résolution pour que les ventilateurs ne se déclenchent pas. La décoration se met aussi en veille dès qu\'elle n\'est plus visible.') }));

  if (perf.mode === 'custom') {
    // 30 i/s est le défaut recommandé : c'est un fond d'écran permanent, et
    // limiter la cadence est le levier le plus efficace sur le coût CPU/GPU.
    const fpsOptions = [['0', 'Illimitée (suivre l\'écran)'], ['144', '144 i/s'], ['120', '120 i/s'], ['60', '60 i/s'], ['30', '30 i/s (recommandé)'], ['24', '24 i/s (économe)'], ['15', '15 i/s (silencieux)']];
    if (!fpsOptions.some(([v]) => v === String(settings.fpsLimit))) {
      fpsOptions.push([String(settings.fpsLimit), `${settings.fpsLimit} i/s`]);
    }
    panel.append(el('h2', { text: t('Réglages détaillés') }));
    panel.append(el('div', { class: 'card' },
      el('div', { class: 'grid-2' },
        dropdown({
          id: 'fps-limit', label: 'Limite de fréquence d\'images',
          value: String(settings.fpsLimit), options: fpsOptions,
          onChange: (v) => { settings.fpsLimit = Number(v); persist(); renderPerf(); },
        }),
        dropdown({
          id: 'dpr-cap', label: 'Résolution du rendu', value: String(settings.dprCap ?? 2),
          options: [['1', 'Standard (×1, la plus légère)'], ['1.5', 'Intermédiaire (×1,5)'], ['2', 'Haute définition (×2)'], ['3', 'Maximale (×3)']],
          onChange: (v) => { settings.dprCap = Number(v); persist(); renderPerf(); },
        })),
      el('div', { class: 'grid-2' },
        dropdown({
          id: 'min-tier', label: 'Qualité des effets', value: String(settings.minTier ?? 0),
          options: TIER_CHOICES,
          onChange: (v) => { settings.minTier = Number(v); persist(); },
        }),
        dropdown({
          id: 'renderer-pref', label: 'Moteur des sapins', value: settings.renderer ?? 'auto',
          options: [['auto', 'Automatique (GPU si disponible)'], ['webgl', 'Toujours WebGL'], ['canvas', 'Toujours Canvas 2D']],
          onChange: (v) => { settings.renderer = v; persist(); renderPerf(); },
        })),
      el('p', { class: 'hint', text: t('La qualité baisse d\'elle-même si la machine peine, jamais en dessous du niveau choisi ici. Le moteur des sapins prend effet au prochain démarrage.') })));
  }

  panel.append(el('h2', { text: t('Mesures en direct') }));
  const live = el('div', { class: 'card' },
    el('p', { class: 'hint', id: 'fps-readout', 'data-testid': 'fps-readout', text: t('En attente de la superposition…') }),
    el('p', { class: 'hint', id: 'perf-tier-explain', 'data-testid': 'perf-tier-explain', text: '' }));
  if (advanced) {
    live.append(el('canvas', { id: 'perf-sparkline', 'data-testid': 'perf-sparkline', class: 'perf-sparkline', width: 280, height: 40 }));
  }
  panel.append(live);
}

function changeLanguage(value) {
  settings.language = value;
  applyLanguage();
  renderAll();
  refreshDockStatus();
  persist({ immediate: true });
}

/// Applique la langue des réglages à tout ce qui n'est pas reconstruit par
/// les panneaux : balisage statique, titre de l'onglet actif et menu de la
/// barre des menus / zone de notification.
function applyLanguage() {
  setLanguage(settings?.language ?? 'auto');
  translateDom();
  const active = document.querySelector('.nav-item.active span');
  const title = document.getElementById('section-title');
  if (active && title) title.textContent = active.textContent;
  document.title = t('Décoration de Noël');
  void setTrayLabels({
    open: t('Ouvrir les paramètres'),
    pause: t('Mettre la décoration en pause'),
    resume: t('Reprendre la décoration'),
    quit: t('Quitter Décoration de Noël'),
    tooltip: t('Décoration de Noël'),
  });
}

function renderPause() {
  const btn = document.getElementById('pause-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(settings.paused === true));
  btn.querySelector('span').textContent = t(settings.paused ? 'Reprendre' : 'Pause');
  btn.title = t(settings.paused ? 'Reprendre la décoration' : 'Mettre la décoration en pause');
  document.body.classList.toggle('is-paused', settings.paused === true);
}

function renderSystem() {
  const panel = panels.system;
  panel.replaceChildren();

  panel.append(el('h2', { text: t('Langue') }));
  panel.append(el('div', { class: 'card' },
    dropdown({
      id: 'language-select', label: 'Langue de l\'interface', value: settings.language ?? 'auto',
      options: [['auto', 'Automatique (langue du système)'], ...Object.entries(LANGUAGES).map(([id, l]) => [id, l.name, true])],
      onChange: changeLanguage,
    })));

  panel.append(el('h2', { text: t('Affichage') }));
  panel.append(el('div', { class: 'card' },
    segmented({
      id: 'display-mode', label: 'Emplacement de la décoration', value: settings.displayMode ?? 'wallpaper',
      options: Object.entries(DISPLAY_MODES).map(([id, m]) => [id, m.label, m.hint]),
      onChange: (v) => { settings.displayMode = v; persist({ immediate: true }); renderSystem(); renderScene(); },
    }),
    el('p', { class: 'hint', text: t(DISPLAY_MODES[settings.displayMode ?? 'wallpaper']?.hint ?? '') }),
    slider({
      id: 'overlay-opacity', label: 'Opacité de la décoration', min: 20, max: 100, step: 5,
      value: Math.round((settings.overlayOpacity ?? 1) * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.overlayOpacity = v / 100; persist(); },
    })));

  panel.append(el('h2', { text: t('Dock et barre des tâches') }));
  const dock = el('div', { class: 'card' },
    toggle({
      id: 'dock-toggle', label: 'Décorer le Dock / la barre des tâches', checked: settings.dockDecoration,
      onChange: (v) => { settings.dockDecoration = v; settings.taskbarDecoration = v; persist({ immediate: true }).then(refreshDockStatus); renderSystem(); },
    }),
    el('p', { class: 'hint', id: 'dock-status', 'data-testid': 'dock-status', text: t('Vérification du Dock / de la barre des tâches…') }));
  if (settings.dockDecoration) {
    dock.append(
      segmented({
        id: 'dock-placement', label: 'Position de la bande', value: settings.dockPlacement ?? 'behind',
        options: Object.entries(DOCK_PLACEMENTS).map(([id, m]) => [id, m.label, m.hint]),
        onChange: (v) => { settings.dockPlacement = v; persist({ immediate: true }); renderSystem(); },
      }),
      el('p', { class: 'hint', text: t(DOCK_PLACEMENTS[settings.dockPlacement ?? 'behind']?.hint ?? '') }),
      el('div', { class: 'chips' },
        chip({ id: 'dock-garland', label: '🌿 Guirlande', checked: settings.dockGarland !== false, onChange: (v) => { settings.dockGarland = v; persist(); } }),
        chip({ id: 'dock-icicles', label: '🧊 Stalactites', checked: settings.dockIcicles !== false, onChange: (v) => { settings.dockIcicles = v; persist(); } }),
        chip({ id: 'dock-snow', label: '❄️ Neige', checked: settings.dockSnow !== false, onChange: (v) => { settings.dockSnow = v; persist(); } })),
      dropdown({
        id: 'dock-palette', label: 'Couleurs des lumières', value: settings.dockPalette ?? 'multicolor',
        options: Object.keys(LIGHT_PALETTES).map((k) => [k, LIGHT_PALETTE_LABELS[k] ?? k]),
        onChange: (v) => { settings.dockPalette = v; persist(); },
      }));
  }
  panel.append(dock);

  panel.append(el('h2', { text: t('Son') }));
  panel.append(el('div', { class: 'card' },
    slider({
      id: 'volume', label: 'Volume ambiant', min: 0, max: 100, step: 5,
      value: Math.round(settings.soundVolume * 100), format: (v) => (v === 0 ? t('Muet') : `${v}%`),
      onInput: (v) => { settings.soundVolume = v / 100; persist(); },
    })));

  panel.append(el('h2', { text: t('Démarrage') }));
  panel.append(el('div', { class: 'card' },
    toggle({
      id: 'autostart-toggle', label: 'Lancer au démarrage du système', checked: settings.autostart,
      onChange: (v) => { settings.autostart = v; persist(); },
    }),
    el('p', { class: 'hint', text: t('L\'application reste discrète : aucune icône dans le Dock ni dans la barre des tâches. Retrouvez-la dans la barre des menus (macOS) ou la zone de notification (Windows, Linux).') }),
    el('button', {
      class: 'add', 'data-testid': 'wizard-reopen', text: t('Relancer l\'assistant de configuration'),
      onclick: () => openWizard(),
    })));
}

function renderAll() {
  renderScene();
  renderSnow();
  renderLights();
  renderPerf();
  renderSystem();
  renderPresets();
  renderPause();
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

function presetList() {
  return Array.isArray(settings.presets) ? settings.presets : [];
}

function renderPresets() {
  const select = document.getElementById('preset-select');
  const current = select.value;
  select.replaceChildren(el('option', { value: '', text: t('— Préréglage —') }));
  for (const p of presetList()) {
    select.append(el('option', { value: p.id, text: p.name }));
  }
  select.value = current;
  updatePresetThumb(select.value);
}

function updatePresetThumb(id) {
  const img = document.getElementById('preset-thumb');
  const preset = presetList().find((p) => p.id === id);
  if (preset?.thumbnail) {
    img.src = preset.thumbnail;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
}

/// A small (96x60) rendering of a look's sky, snow and trees — sampled
/// from the settings snapshot rather than the live overlay, since the
/// settings window has no canvas of its own to capture. Stylised, not a
/// screenshot: it just needs to read apart from the other presets at a
/// glance.
function makePresetThumbnail(snapshot) {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  const screen = screenConfig(snapshot.scene, 0);
  const aurora = AURORA_PALETTES[screen.auroraPalette] ?? AURORA_PALETTES.classic;
  const weather = WEATHER_PROFILES[screen.weatherProfile] ?? WEATHER_PROFILES.winter;

  const sky = ctx.createLinearGradient(0, 0, 0, 40);
  sky.addColorStop(0, '#05070f');
  sky.addColorStop(1, '#101a33');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 96, 40);

  if (screen.aurora) {
    ctx.globalAlpha = 0.55 * (screen.auroraIntensity ?? 1);
    aurora.colors.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 4 + i * 6, 96, 5);
    });
    ctx.globalAlpha = 1;
  }

  if (screen.stars) {
    ctx.fillStyle = '#ffffff';
    const count = Math.round(8 * (screen.starDensity ?? 1));
    for (let i = 0; i < count; i += 1) {
      const x = (i * 37) % 96;
      const y = (i * 17) % 34;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  ctx.fillStyle = `rgba(230, 240, 255, ${0.6 + 0.4 * weather.accumulate})`;
  ctx.fillRect(0, 40, 96, 20);

  for (const fireplace of screen.fireplaces ?? []) {
    ctx.fillStyle = 'rgba(255, 150, 60, 0.5)';
    ctx.beginPath();
    ctx.arc(fireplace.x * 96, 40, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const tree of screen.trees ?? []) {
    const { dark, light } = resolveNeedles(tree);
    ctx.fillStyle = light ?? dark ?? '#2f5f43';
    const x = tree.x * 96;
    ctx.beginPath();
    ctx.moveTo(x, 40 - 18 * (tree.scale ?? 1));
    ctx.lineTo(x - 6 * (tree.scale ?? 1), 40);
    ctx.lineTo(x + 6 * (tree.scale ?? 1), 40);
    ctx.closePath();
    ctx.fill();
  }

  return canvas.toDataURL('image/jpeg', 0.7);
}

/// Applying a preset replaces the whole look — scene included — but never
/// the things that belong to this machine rather than to the look:
/// autostart and the Dock toggle stay as they are, because a preset
/// shared by someone else has no business turning those on.
function applyPreset(id) {
  const preset = presetList().find((p) => p.id === id);
  if (!preset) return;
  const keep = {
    autostart: settings.autostart,
    dockDecoration: settings.dockDecoration,
    taskbarDecoration: settings.taskbarDecoration,
    presets: settings.presets,
  };
  settings = { ...settings, ...preset.settings, ...keep };
  applyThemeColors();
  renderAll();
  persist({ immediate: true });
  setStatus('Préréglage « {name} » appliqué', { name: preset.name });
}

function setupPresetBar() {
  document.getElementById('preset-select').addEventListener('change', (e) => {
    updatePresetThumb(e.target.value);
    if (e.target.value) applyPreset(e.target.value);
  });

  document.getElementById('preset-save').addEventListener('click', () => {
    const name = prompt(t('Nommer ce préréglage'), t('Préréglage {n}', { n: presetList().length + 1 }));
    if (!name) return;
    const snapshot = { ...settings };
    delete snapshot.presets; // a preset never contains the preset list
    const thumbnail = makePresetThumbnail(snapshot);
    const preset = makePreset(name, snapshot, thumbnail);
    settings.presets = [...presetList(), preset];
    renderPresets();
    document.getElementById('preset-select').value = preset.id;
    updatePresetThumb(preset.id);
    persist({ immediate: true });
    setStatus('« {name} » enregistré', { name });
  });

  document.getElementById('preset-delete').addEventListener('click', () => {
    const select = document.getElementById('preset-select');
    if (!select.value) return;
    settings.presets = presetList().filter((p) => p.id !== select.value);
    renderPresets();
    persist({ immediate: true });
    setStatus('Préréglage supprimé');
  });

  document.getElementById('preset-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(presetList(), null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'christmas-presets.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setStatus('Préréglages exportés');
  });

  document.getElementById('preset-import').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result));
        if (!Array.isArray(imported)) throw new Error('liste de préréglages invalide');
        // Merged, not replaced: importing someone else's presets should
        // never silently delete your own.
        const existing = new Set(presetList().map((p) => p.id));
        settings.presets = [...presetList(), ...imported.filter((p) => p?.id && !existing.has(p.id))];
        renderPresets();
        persist({ immediate: true });
        setStatus('{n} préréglage(s) importé(s)', { n: imported.length });
      } catch {
        setStatus('Ce fichier n\'est pas une liste de préréglages');
      }
    };
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// chrome
// ---------------------------------------------------------------------------

function applyThemeColors() {
  const theme = themes.find((th) => th.id === settings.themeId);
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--primary', theme.colors.primary);
  root.style.setProperty('--secondary', theme.colors.secondary);
  root.style.setProperty('--accent', theme.colors.accent);
  root.style.setProperty('--background', theme.colors.background);
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('.nav-item')];
  const title = document.getElementById('section-title');
  for (const tab of tabs) {
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        other.classList.toggle('active', other === tab);
        other.setAttribute('aria-selected', String(other === tab));
      }
      for (const [name, panel] of Object.entries(panels)) {
        panel.hidden = name !== tab.dataset.tab;
      }
      if (title) title.textContent = tab.querySelector('span').textContent;
    });
  }
}

async function refreshDockStatus() {
  const node = document.getElementById('dock-status');
  if (!node) return;
  try {
    const { strips, reason } = await dockStatus();
    node.textContent = strips?.length
      ? t('Détectée sur {n} écran(s) : {list}', { n: strips.length, list: strips.map((s) => `${t(EDGE_LABELS[s.edge] ?? s.edge)} (${s.barThickness}px)`).join(', ') })
      : t(reason ?? 'Aucune barre de Dock / des tâches détectée.');
  } catch {
    node.textContent = t('État de la barre de Dock / des tâches indisponible.');
  }
}

document.getElementById('disable-btn').addEventListener('click', async () => {
  await disableEverything();
  settings = await getSettings();
  if (!settings.scene) settings.scene = defaultScene();
  if (!Array.isArray(settings.presets)) settings.presets = [];
  renderAll();
  setStatus('Tout est désactivé');
});

/// Draws a bare frame-time history: one bar per sample, red above the
/// target the quality governor is actually budgeting against. This is
/// the same measurement the automatic degrade acts on, not a separate
/// reading, so a bar crossing the line is the reason a tier step is
/// coming, not just decoration.
function drawPerfSparkline(history, target) {
  const canvas = document.getElementById('perf-sparkline');
  if (!canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!history.length) return;

  const maxMs = Math.max(target * 2, ...history);
  const barW = w / history.length;
  history.forEach((ms, i) => {
    const barH = Math.max(1, (ms / maxMs) * h);
    g.fillStyle = ms > target ? '#e0554d' : '#4caf7d';
    g.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  });

  const targetY = h - Math.min(h, (target / maxMs) * h);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, targetY);
  g.lineTo(w, targetY);
  g.stroke();
}

/// Explains WHY the current quality tier is active, in the same terms the
/// governor itself uses (see shared/perf.js), rather than leaving "quality:
/// reduced" as an unexplained fact — and separately, whether the tree
/// renderer is actually on a GPU or fell back, and why.
function explainPerfTier({ qualityLabel, qualityTarget, frameHistory, renderer, rendererReason }) {
  const node = document.getElementById('perf-tier-explain');
  if (!node) return;
  const parts = [];
  if (qualityLabel && qualityLabel !== 'full') {
    const avg = frameHistory.length
      ? Math.round((frameHistory.reduce((a, b) => a + b, 0) / frameHistory.length) * 10) / 10
      : 0;
    parts.push(t('Qualité réduite à « {label} » : les dernières images ont pris {avg} ms en moyenne pour un budget de {target} ms.', { label: t(TIER_LABELS[qualityLabel] ?? qualityLabel), avg, target: qualityTarget }));
  }
  if (renderer === 'canvas2d' && rendererReason) {
    parts.push(t('Les sapins utilisent Canvas 2D et non le moteur WebGL : {reason}.', { reason: rendererReason }));
  }
  node.textContent = parts.join(' ');
}

function applyStats(snapshot) {
  const { fps, frameMs, particles, qualityLabel, frameHistory = [], qualityTarget = 16.7 } = snapshot;
  const node = document.getElementById('fps-readout');
  if (node) {
    // The quality label only appears once it has actually degraded once
    // ('full' stays implicit) — showing it unconditionally would make a
    // perfectly healthy machine look like something is wrong.
    const tierNote = qualityLabel && qualityLabel !== 'full' ? ` · ${t('qualité : {label}', { label: t(TIER_LABELS[qualityLabel] ?? qualityLabel) })}` : '';
    node.textContent = t('{fps} i/s · {ms} ms/image · {n} flocons', { fps, ms: frameMs, n: particles }) + tierNote;
  }
  drawPerfSparkline(frameHistory, qualityTarget);
  explainPerfTier(snapshot);
}

onStats(applyStats);

// `onStats` is a no-op outside Tauri (see bridge.js), so a Playwright test
// — which runs the settings window standalone, with no overlay window
// publishing real stats — has no event to listen for. Exposed here so a
// test can drive the same code path deterministically, the same way
// snow.js exposes `__simulateFrameCost` for the overlay side.
window.__applyStats = applyStats;


// ---------------------------------------------------------------------------
// assistant de première utilisation
// ---------------------------------------------------------------------------

const SNOW_CHOICES = [
  ['light', 'Légère', 'Quelques flocons, très discret', 60],
  ['normal', 'Normale', 'Une jolie chute équilibrée', 120],
  ['heavy', 'Intense', 'Tempête de neige immersive', 320],
];

const WIZARD_STEPS = ['welcome', 'mode', 'performance', 'options', 'done'];

/// Assistant d'installation et de configuration, en cinq étapes : langue,
/// mode, performances, options, terminé. Il ne fait que remplir `settings`
/// (comme le ferait le panneau), et chaque choix est appliqué tout de
/// suite : la décoration change derrière la fenêtre pendant qu'on choisit.
function openWizard() {
  if (document.getElementById('wizard')) return;
  let step = 0;
  const backdrop = el('div', { class: 'wizard-backdrop', id: 'wizard', 'data-testid': 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wizard-title' });
  const dialog = el('div', { class: 'wizard' });
  backdrop.append(dialog);
  document.body.append(backdrop);

  const finish = async () => {
    settings.onboardingDone = true;
    await persist({ immediate: true });
    backdrop.remove();
    renderAll();
  };
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); });

  const render = () => {
    const name = WIZARD_STEPS[step];
    const dots = el('div', { class: 'wizard-dots', 'data-testid': 'wizard-progress', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': WIZARD_STEPS.length, 'aria-valuenow': step + 1,
      'aria-label': t('Étape {n} sur {total}', { n: step + 1, total: WIZARD_STEPS.length }) },
      ...WIZARD_STEPS.map((_, i) => el('span', { class: i === step ? 'on' : i < step ? 'past' : '' })));
    const body = el('div', { class: 'wizard-body' });

    if (name === 'welcome') {
      body.append(
        el('div', { class: 'wizard-hero', text: '🎄' }),
        el('h2', { id: 'wizard-title', text: t('Bienvenue dans Décoration de Noël') }),
        el('p', { text: t('Quelques choix et votre bureau est prêt pour les fêtes. Tout reste modifiable plus tard dans les paramètres.') }),
        el('div', { class: 'wizard-langs', role: 'radiogroup', 'aria-label': t('Langue') },
          ...Object.entries(LANGUAGES).map(([id, l]) => el('button', {
            type: 'button', role: 'radio', 'aria-checked': String(getLanguage() === id),
            class: `wizard-lang${getLanguage() === id ? ' selected' : ''}`, 'data-testid': `wizard-lang-${id}`, lang: id,
            onclick: () => { settings.language = id; applyLanguage(); renderAll(); persist(); render(); },
          }, l.name))),
        el('ul', { class: 'wizard-points' },
          el('li', { text: t('❄️ Neige animée sur tous vos écrans, sans gêner vos fenêtres') }),
          el('li', { text: t('🎄 Sapins, guirlandes et cheminée entièrement personnalisables') }),
          el('li', { text: t('🔒 Aucune donnée collectée, aucune connexion requise') })));
    } else if (name === 'mode') {
      body.append(
        el('h2', { id: 'wizard-title', text: t('Choisissez votre ambiance') }),
        el('p', { text: t('Un point de départ : vous pourrez tout ajuster ensuite, élément par élément.') }),
        el('div', { class: 'mode-grid' },
          ...Object.entries(SCENE_MODES).map(([id, mode]) => modeCard(id, mode, {
            prefix: 'wizard-mode', selected: settings.sceneMode === id,
            onPick: () => { applySceneMode(settings, id, null); applyThemeColors(); persist(); render(); },
          }))));
    } else if (name === 'performance') {
      body.append(
        el('h2', { id: 'wizard-title', text: t('Performances') }),
        el('p', { text: t('Choisissez l\'équilibre entre beauté et discrétion. « Silencieux » garde les ventilateurs au repos, quitte à alléger les graphismes.') }),
        perfCards('wizard-perf', () => { persist(); render(); }),
        el('p', { class: 'hint', 'data-testid': 'wizard-perf-summary', text: perfSummary(resolvePerformance(settings)) }));
    } else if (name === 'options') {
      body.append(
        el('h2', { id: 'wizard-title', text: t('Derniers réglages') }),
        el('p', { text: t('Quantité de neige :') }));
      const choices = el('div', { class: 'wizard-choices', role: 'radiogroup', 'aria-label': t('Quantité de neige') });
      for (const [id, label, hint, density] of SNOW_CHOICES) {
        const on = settings.snowDensity === density;
        choices.append(el('button', {
          class: `wizard-choice${on ? ' selected' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), 'data-testid': `wizard-snow-${id}`,
          onclick: () => { settings.snowDensity = density; persist(); render(); },
        }, el('strong', { text: t(label) }), el('small', { text: t(hint) })));
      }
      body.append(choices,
        toggle({ id: 'wizard-dock', label: 'Décorer le Dock / la barre des tâches', checked: settings.dockDecoration,
          onChange: (v) => { settings.dockDecoration = v; settings.taskbarDecoration = v; persist(); } }),
        toggle({ id: 'wizard-autostart', label: 'Lancer automatiquement au démarrage du système', checked: settings.autostart,
          onChange: (v) => { settings.autostart = v; } }),
        slider({ id: 'wizard-volume', label: 'Volume de l\'ambiance sonore', min: 0, max: 100, step: 5,
          value: Math.round(settings.soundVolume * 100), format: (v) => (v === 0 ? t('Muet') : `${v}%`),
          onInput: (v) => { settings.soundVolume = v / 100; persist(); } }));
    } else {
      body.append(
        el('div', { class: 'wizard-hero', text: '✨' }),
        el('h2', { id: 'wizard-title', text: t('Tout est prêt !') }),
        el('p', { text: t('Votre décoration est active et reste en arrière-plan, sans icône dans le Dock ni dans la barre des tâches.') }),
        el('ul', { class: 'wizard-points' },
          el('li', { text: t('🍎 macOS : l\'icône se trouve en haut, dans la barre des menus') }),
          el('li', { text: t('🪟 Windows et Linux : dans la zone de notification (icônes masquées)') }),
          el('li', { text: t('⏸️ Un clic sur l\'icône permet de mettre en pause ou de rouvrir ces paramètres') })));
    }

    const last = step === WIZARD_STEPS.length - 1;
    const back = el('button', { class: 'ghost', type: 'button', text: t('Retour'), 'data-testid': 'wizard-back', onclick: () => { step--; render(); } });
    back.hidden = step === 0;
    const skip = el('button', { class: 'ghost', type: 'button', text: t('Passer'), 'data-testid': 'wizard-skip', onclick: finish });
    skip.hidden = last;
    const next = el('button', {
      class: 'primary', type: 'button', 'data-testid': 'wizard-next',
      text: t(last ? 'Terminer' : step === 0 ? 'Commencer' : 'Continuer'),
      onclick: () => (last ? finish() : (step++, render())),
    });
    dialog.replaceChildren(dots, body, el('div', { class: 'wizard-actions' }, skip, el('span', { class: 'spacer' }), back, next));
    next.focus();
  };
  render();
}

function maybeOpenWizard() {
  const forced = new URLSearchParams(location.search).has('onboarding');
  // Les tests pilotent la page avec WebDriver : ils ne doivent pas être
  // bloqués par une boîte de dialogue qu'ils n'attendent pas.
  if (forced || (!settings.onboardingDone && !navigator.webdriver)) openWizard();
}

async function init() {
  [themes, screens, settings] = await Promise.all([listThemes(), listScreens(), getSettings()]);
  if (!settings.scene) settings.scene = defaultScene();
  if (!Array.isArray(settings.presets)) settings.presets = [];
  activeScreen = screens[0]?.index ?? 0;
  setupTabs();
  setupPresetBar();
  const sw = document.getElementById('advanced-toggle');
  sw.checked = advanced;
  sw.addEventListener('change', () => setAdvanced(sw.checked));
  document.getElementById('pause-toggle').addEventListener('click', () => {
    settings.paused = !settings.paused;
    renderPause();
    persist({ immediate: true });
    setStatus(settings.paused ? 'Décoration en pause' : 'Décoration relancée');
  });
  // La pause peut aussi venir du menu de la barre des menus : la fenêtre
  // doit refléter l'état réel, pas celui qu'elle avait à l'ouverture.
  onSettingsChanged(({ settings: next }) => {
    if (next && next.paused !== settings.paused) { settings.paused = next.paused; renderPause(); }
  });
  applyLanguage();
  applyThemeColors();
  renderAll();
  refreshDockStatus();
  maybeOpenWizard();
}

// Exposed so tests can await the initial load before asserting.
window.settingsReady = init();
