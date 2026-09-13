// Settings window.
//
// The controls are BUILT FROM THE SCENE, not written out by hand in HTML,
// because the scene is now a list: any number of trees and fireplaces per
// screen, each with its own position, size, style and light string. A
// fixed set of toggles cannot express that, which is why the old page had
// exactly two trees and one fireplace baked into the renderer.
//
// The layout map is the other half of that answer. "Where does this go"
// is a spatial question, and a number field is a poor way to ask it, so
// each element is a marker you drag along a scale model of the screen.

import {
  listThemes, getSettings, saveSettings, disableEverything, onStats, dockStatus,
  listScreens, saveBackground, loadBackground,
} from '../shared/bridge.js';
import {
  LIGHT_PALETTES, LIGHT_MODES, TREE_STYLES, defaultScene, defaultScreen,
  defaultTree, defaultFireplace, screenConfig, makePreset,
} from '../shared/scene.js';

const panels = {
  scene: document.getElementById('panel-scene'),
  snow: document.getElementById('panel-snow'),
  lights: document.getElementById('panel-lights'),
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
  return el('div', {}, el('label', { for: id }, label, out), input);
}

function fill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max === min ? 0 : ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function toggle({ id, label, checked, onChange }) {
  return el('div', { class: 'row' },
    el('label', { for: id, text: label }),
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
  for (const [val, text] of options) {
    select.append(el('option', { value: val, selected: String(val) === String(value) }, text));
  }
  return label ? el('div', {}, el('label', { for: id, text: label }), select) : select;
}

function setStatus(text) {
  statusEl.textContent = text;
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => { statusEl.textContent = ''; }, 1600);
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
    setStatus('Saved');
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
// light style editor — shared by garlands, trees and fireplaces
// ---------------------------------------------------------------------------

/// One editor for every light string in the app. A garland, a tree's
/// string and a mantel swag are the same kind of object, so "red and blue,
/// chasing, fast" is set the same way wherever it appears.
function lightStyleEditor(prefix, style, apply) {
  const paletteOptions = [
    ...Object.keys(LIGHT_PALETTES).map((k) => [k, k.replace('-', ' & ').replace(/^./, (c) => c.toUpperCase())]),
    ['custom', 'Custom colours'],
  ];
  const nodes = [
    el('div', { class: 'grid-2' },
      dropdown({
        id: `${prefix}-palette`, label: 'Colours', value: style.palette,
        options: paletteOptions,
        onChange: (v) => apply((s) => { s.palette = v; }),
      }),
      dropdown({
        id: `${prefix}-mode`, label: 'Animation', value: style.mode,
        options: LIGHT_MODES.map((m) => [m, m.replace(/^./, (c) => c.toUpperCase())]),
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
      el('label', { class: 'small', text: 'Custom colours' }),
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

  nodes.push(el('div', { class: 'grid-2' },
    slider({
      id: `${prefix}-speed`, label: 'Speed', min: 20, max: 300, step: 10,
      value: Math.round(style.speed * 100), format: (v) => `${v}%`,
      onInput: (v) => apply((s) => { s.speed = v / 100; }),
    }),
    slider({
      id: `${prefix}-bulb-size`, label: 'Bulb size', min: 40, max: 220, step: 10,
      value: Math.round(style.size * 100), format: (v) => `${v}%`,
      onInput: (v) => apply((s) => { s.size = v / 100; }),
    })
  ));
  nodes.push(slider({
    id: `${prefix}-intensity`, label: 'Brightness', min: 20, max: 200, step: 10,
    value: Math.round(style.intensity * 100), format: (v) => `${v}%`,
    onInput: (v) => apply((s) => { s.intensity = v / 100; }),
  }));
  return nodes;
}

// ---------------------------------------------------------------------------
// layout map
// ---------------------------------------------------------------------------

function layoutMap(cfg) {
  const map = el('div', { class: 'layout', 'data-testid': 'layout-map' },
    el('div', { class: 'ground' }));

  const place = (kind, item, glyph, index) => {
    const marker = el('div', {
      class: 'marker',
      'data-testid': `marker-${kind}-${index}`,
      'aria-selected': selectedElement?.id === item.id,
      style: `left:${(item.x ?? 0.5) * 100}%`,
    },
      el('div', { class: 'glyph', style: `font-size:${18 * (item.scale ?? 1)}px`, text: glyph }),
      el('span', { text: `${Math.round((item.x ?? 0.5) * 100)}%` })
    );

    // Pointer events rather than mouse events: this has to work under a
    // trackpad, a touch screen and Playwright's synthetic input alike.
    marker.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      marker.setPointerCapture(ev.pointerId);
      selectedElement = { kind, id: item.id };
      const rect = map.getBoundingClientRect();
      const move = (e) => {
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        marker.style.left = `${x * 100}%`;
        marker.lastChild.textContent = `${Math.round(x * 100)}%`;
        item.x = Math.round(x * 1000) / 1000;
      };
      const up = () => {
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        editScreen((s) => {
          const list = kind === 'tree' ? s.trees : s.fireplaces;
          const target = list.find((e) => e.id === item.id);
          if (target) target.x = item.x;
        });
      };
      marker.addEventListener('pointermove', move);
      marker.addEventListener('pointerup', up);
    });
    map.append(marker);
  };

  (cfg.fireplaces ?? []).forEach((f, i) => place('fireplace', f, '🔥', i));
  (cfg.trees ?? []).forEach((t, i) => place('tree', t, '🎄', i));
  return el('div', {}, map,
    el('p', { class: 'layout-hint', text: 'Drag an element to place it. Positions are a fraction of the screen width, so they survive a resolution change.' }));
}

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

function renderScene() {
  const cfg = currentScreen();
  const panel = panels.scene;
  panel.replaceChildren();

  // --- screen picker ---------------------------------------------------
  panel.append(el('h2', { text: 'Screen' }));
  const chips = el('div', { class: 'screens' });
  for (const s of screens) {
    chips.append(el('button', {
      class: 'screen-chip',
      'data-testid': `screen-chip-${s.index}`,
      'aria-pressed': s.index === activeScreen,
      onclick: () => { activeScreen = s.index; selectedElement = null; renderScene(); },
    }, el('strong', { text: s.primary ? `${s.name} (main)` : s.name }),
       el('small', { text: `${s.width}×${s.height}` })));
  }
  panel.append(chips);
  if (screens.length > 1) {
    panel.append(el('p', { class: 'hint', 'data-testid': 'screen-hint',
      text: 'Each screen keeps its own composition. Changes here affect only the selected screen.' }));
  }

  panel.append(el('div', { class: 'card' },
    toggle({
      id: 'screen-enabled', label: 'Decorate this screen', checked: cfg.enabled !== false,
      onChange: (v) => editScreen((s) => { s.enabled = v; }),
    })));

  // --- layout ----------------------------------------------------------
  panel.append(el('h2', { text: 'Layout' }));
  panel.append(el('div', { class: 'card' }, layoutMap(cfg)));

  // --- background ------------------------------------------------------
  panel.append(el('h2', { text: 'Background' }));
  const bgCard = el('div', { class: 'card' },
    dropdown({
      id: 'background-mode', label: 'Backdrop', value: cfg.background,
      options: [['none', 'None (see the desktop)'], ['image', 'Image']],
      onChange: (v) => editScreen((s) => { s.background = v; }),
    }));
  if (cfg.background === 'image') {
    bgCard.append(
      el('label', { class: 'ghost file', style: 'text-align:center' }, 'Choose image…',
        el('input', {
          type: 'file', accept: 'image/*', hidden: true, 'data-testid': 'background-file',
          onchange: async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
              await saveBackground(`screen-${activeScreen}`, String(reader.result));
              setStatus('Background updated');
            };
            // Read as a data URL and hand it to Rust, which stores it in
            // its own file: the picture never goes through settings.json.
            reader.readAsDataURL(file);
          },
        })),
      el('div', { class: 'grid-2' },
        dropdown({
          id: 'background-fit', label: 'Fit', value: cfg.backgroundFit,
          options: [['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch'], ['tile', 'Tile']],
          onChange: (v) => editScreen((s) => { s.backgroundFit = v; }),
        }),
        slider({
          id: 'background-opacity', label: 'Opacity', min: 10, max: 100, step: 5,
          value: Math.round((cfg.backgroundOpacity ?? 1) * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.backgroundOpacity = v / 100; }),
        })),
      el('button', {
        class: 'remove', 'data-testid': 'background-clear', text: 'Remove image',
        onclick: async () => { await saveBackground(`screen-${activeScreen}`, null); setStatus('Background removed'); },
      })
    );
  }
  panel.append(bgCard);

  // --- sky -------------------------------------------------------------
  panel.append(el('h2', { text: 'Sky' }));
  const sky = el('div', { class: 'card' },
    toggle({ id: 'aurora-toggle', label: '🌌 Aurora curtains', checked: cfg.aurora,
      onChange: (v) => editScreen((s) => { s.aurora = v; }) }));
  if (cfg.aurora) {
    sky.append(slider({
      id: 'aurora-intensity', label: 'Aurora strength', min: 20, max: 200, step: 10,
      value: Math.round((cfg.auroraIntensity ?? 1) * 100), format: (v) => `${v}%`,
      onInput: (v) => editScreen((s) => { s.auroraIntensity = v / 100; }),
    }));
  }
  sky.append(
    toggle({ id: 'stars-toggle', label: '⭐ Stars & shooting stars', checked: cfg.stars,
      onChange: (v) => editScreen((s) => { s.stars = v; }) }),
    toggle({ id: 'icicles-toggle', label: '🧊 Icicles', checked: cfg.icicles,
      onChange: (v) => editScreen((s) => { s.icicles = v; }) }),
    toggle({ id: 'glitter-toggle', label: '✨ Glitter on settled snow', checked: cfg.snowGlitter,
      onChange: (v) => editScreen((s) => { s.snowGlitter = v; }) })
  );
  panel.append(sky);

  // --- garland ---------------------------------------------------------
  panel.append(el('h2', { text: 'Light garland' }));
  const garland = el('div', { class: 'card' },
    toggle({ id: 'garland-enabled', label: 'Garland across the top', checked: cfg.garland.enabled,
      onChange: (v) => editScreen((s) => { s.garland.enabled = v; }) }));
  if (cfg.garland.enabled) {
    garland.append(
      el('div', { class: 'grid-2' },
        slider({
          id: 'garland-sag', label: 'Sag', min: 20, max: 250, step: 10,
          value: Math.round(cfg.garland.sag * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.garland.sag = v / 100; }),
        }),
        slider({
          id: 'garland-spacing', label: 'Bulb spacing', min: 40, max: 260, step: 10,
          value: Math.round(cfg.garland.spacing * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.garland.spacing = v / 100; }),
        })),
      ...lightStyleEditor('garland', cfg.garland.lights,
        (fn) => editScreen((s) => fn(s.garland.lights)))
    );
  }
  panel.append(garland);

  // --- trees -----------------------------------------------------------
  panel.append(el('h2', { text: `Trees (${cfg.trees.length})` }));
  cfg.trees.forEach((tree, i) => {
    panel.append(el('div', { class: 'card', 'data-testid': `tree-card-${i}` },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, '🎄 Tree',
          el('span', { class: 'badge', text: `${Math.round(tree.x * 100)}%` })),
        el('button', {
          class: 'remove', 'data-testid': `tree-remove-${i}`, text: 'Remove',
          onclick: () => editScreen((s) => { s.trees.splice(i, 1); }),
        })),
      el('div', { class: 'grid-2' },
        slider({
          id: `tree-${i}-x`, label: 'Position', min: 0, max: 100, step: 1,
          value: Math.round(tree.x * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.trees[i].x = v / 100; }),
        }),
        slider({
          id: `tree-${i}-scale`, label: 'Size', min: 30, max: 260, step: 5,
          value: Math.round(tree.scale * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.trees[i].scale = v / 100; }),
        })),
      el('div', { class: 'grid-2' },
        dropdown({
          id: `tree-${i}-style`, label: 'Species', value: tree.style,
          options: Object.entries(TREE_STYLES).map(([k, v]) => [k, v.label]),
          onChange: (v) => editScreen((s) => { s.trees[i].style = v; }),
        }),
        dropdown({
          id: `tree-${i}-flip`, label: 'Facing', value: String(tree.flip),
          options: [['false', 'Normal'], ['true', 'Mirrored']],
          onChange: (v) => editScreen((s) => { s.trees[i].flip = v === 'true'; }),
        })),
      el('div', { class: 'grid-2' },
        slider({
          id: `tree-${i}-ornaments`, label: 'Baubles', min: 0, max: 250, step: 10,
          value: Math.round(tree.ornaments * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.trees[i].ornaments = v / 100; }),
        }),
        slider({
          id: `tree-${i}-snow`, label: 'Snow on branches', min: 0, max: 200, step: 10,
          value: Math.round(tree.snow * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.trees[i].snow = v / 100; }),
        })),
      toggle({ id: `tree-${i}-ribbon`, label: 'Ribbon', checked: tree.ribbon,
        onChange: (v) => editScreen((s) => { s.trees[i].ribbon = v; }) }),
      toggle({ id: `tree-${i}-star`, label: 'Star on top', checked: tree.star,
        onChange: (v) => editScreen((s) => { s.trees[i].star = v; }) }),
      toggle({ id: `tree-${i}-lights`, label: 'String lights', checked: tree.lightsOn,
        onChange: (v) => editScreen((s) => { s.trees[i].lightsOn = v; }) }),
      tree.lightsOn && el('div', { class: 'card nested' },
        ...lightStyleEditor(`tree-${i}`, tree.lights,
          (fn) => editScreen((s) => fn(s.trees[i].lights))))
    ));
  });
  panel.append(el('button', {
    class: 'add', 'data-testid': 'tree-add', text: '+ Add a tree',
    onclick: () => editScreen((s) => {
      // New trees land at an unoccupied spot rather than on top of the
      // last one, so adding several in a row is immediately useful.
      const used = s.trees.map((t) => t.x);
      let x = 0.5;
      for (const candidate of [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4, 0.6]) {
        if (!used.some((u) => Math.abs(u - candidate) < 0.06)) { x = candidate; break; }
      }
      s.trees.push(defaultTree({ x, flip: x > 0.5 }));
    }),
  }));

  // --- fireplaces ------------------------------------------------------
  panel.append(el('h2', { text: `Fireplaces (${cfg.fireplaces.length})` }));
  cfg.fireplaces.forEach((fire, i) => {
    panel.append(el('div', { class: 'card', 'data-testid': `fireplace-card-${i}` },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, '🔥 Fireplace',
          el('span', { class: 'badge', text: `${Math.round(fire.x * 100)}%` })),
        el('button', {
          class: 'remove', 'data-testid': `fireplace-remove-${i}`, text: 'Remove',
          onclick: () => editScreen((s) => { s.fireplaces.splice(i, 1); }),
        })),
      el('div', { class: 'grid-2' },
        slider({
          id: `fire-${i}-x`, label: 'Position', min: 0, max: 100, step: 1,
          value: Math.round(fire.x * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.fireplaces[i].x = v / 100; }),
        }),
        slider({
          id: `fire-${i}-scale`, label: 'Size', min: 40, max: 250, step: 5,
          value: Math.round(fire.scale * 100), format: (v) => `${v}%`,
          onInput: (v) => editScreen((s) => { s.fireplaces[i].scale = v / 100; }),
        })),
      toggle({ id: `fire-${i}-stockings`, label: '🧦 Stockings', checked: fire.stockings,
        onChange: (v) => editScreen((s) => { s.fireplaces[i].stockings = v; }) }),
      toggle({ id: `fire-${i}-swag`, label: '🌿 Pine swag on the mantel', checked: fire.mantelGarland,
        onChange: (v) => editScreen((s) => { s.fireplaces[i].mantelGarland = v; }) }),
      toggle({ id: `fire-${i}-candles`, label: '🕯️ Candles', checked: fire.candles,
        onChange: (v) => editScreen((s) => { s.fireplaces[i].candles = v; }) }),
      el('div', { class: 'card nested' },
        ...lightStyleEditor(`fire-${i}`, fire.lights,
          (fn) => editScreen((s) => fn(s.fireplaces[i].lights))))
    ));
  });
  panel.append(el('button', {
    class: 'add', 'data-testid': 'fireplace-add', text: '+ Add a fireplace',
    onclick: () => editScreen((s) => { s.fireplaces.push(defaultFireplace({ x: 0.5 })); }),
  }));

  panel.append(el('button', {
    class: 'add', 'data-testid': 'screen-reset', text: 'Reset this screen to defaults',
    style: 'margin-top:10px',
    onclick: () => editScreen((s) => Object.assign(s, defaultScreen())),
  }));
}

function renderSnow() {
  const panel = panels.snow;
  const cfg = currentScreen();
  panel.replaceChildren();

  panel.append(el('h2', { text: 'Snowfall' }));
  panel.append(el('div', { class: 'card' },
    slider({
      id: 'snow-density', label: 'Density', min: 0, max: 600, step: 10,
      value: settings.snowDensity, format: (v) => String(v),
      onInput: (v) => { settings.snowDensity = v; persist(); },
    }),
    slider({
      id: 'snow-wind', label: 'Wind', min: 0, max: 100, step: 5,
      value: Math.round(settings.snowWind * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.snowWind = v / 100; persist(); },
    }),
    slider({
      id: 'flake-scale', label: 'Flake size', min: 40, max: 250, step: 10,
      value: Math.round(settings.flakeScale * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.flakeScale = v / 100; persist(); },
    })));

  panel.append(el('h2', { text: 'This screen' }));
  const override = cfg.snowDensity !== 'inherit' && cfg.snowDensity != null;
  const card = el('div', { class: 'card' },
    toggle({
      id: 'snow-density-override', label: 'Override density for this screen', checked: override,
      onChange: (v) => { editScreen((s) => { s.snowDensity = v ? settings.snowDensity : 'inherit'; }); renderSnow(); },
    }));
  if (override) {
    card.append(slider({
      id: 'screen-snow-density', label: 'Density here', min: 0, max: 600, step: 10,
      value: Number(cfg.snowDensity), format: (v) => String(v),
      onInput: (v) => editScreen((s) => { s.snowDensity = v; }),
    }));
  }
  panel.append(card);

  panel.append(el('h2', { text: 'Settling' }));
  panel.append(el('div', { class: 'card' },
    toggle({
      id: 'accumulate-toggle', label: 'Accumulate on the ground', checked: settings.snowAccumulate,
      onChange: (v) => { settings.snowAccumulate = v; persist(); },
    }),
    slider({
      id: 'max-snow-height', label: 'Max snow depth', min: 0, max: 300, step: 10,
      value: settings.maxSnowHeight, format: (v) => `${v} px`,
      onInput: (v) => { settings.maxSnowHeight = v; persist(); },
    })));
}

function renderLights() {
  const panel = panels.lights;
  panel.replaceChildren();
  panel.append(el('h2', { text: 'Master controls' }));
  panel.append(el('div', { class: 'card' },
    dropdown({
      id: 'light-animation', label: 'Default animation', value: settings.lightAnimation,
      options: LIGHT_MODES.map((m) => [m, m.replace(/^./, (c) => c.toUpperCase())]),
      onChange: (v) => { settings.lightAnimation = v; persist(); },
    }),
    el('p', { class: 'hint', text: 'Used by any light string left on its own default. Each garland, tree and fireplace can override it in the Scene tab.' }),
    slider({
      id: 'light-intensity', label: 'Overall brightness', min: 20, max: 200, step: 10,
      value: Math.round(settings.lightIntensity * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.lightIntensity = v / 100; persist(); },
    }),
    slider({
      id: 'decor-scale', label: 'Decoration size (all elements)', min: 50, max: 200, step: 10,
      value: Math.round(settings.decorScale * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.decorScale = v / 100; persist(); },
    })));

  panel.append(el('h2', { text: 'Theme' }));
  panel.append(el('div', { class: 'card' },
    dropdown({
      id: 'theme-select', label: 'Colour theme', value: settings.themeId,
      options: themes.map((t) => [t.id, t.name]),
      onChange: (v) => { settings.themeId = v; applyThemeColors(); persist(); },
    })));
}

function renderSystem() {
  const panel = panels.system;
  panel.replaceChildren();

  panel.append(el('h2', { text: 'Dock / taskbar' }));
  const dockCard = el('div', { class: 'card' },
    toggle({
      id: 'dock-toggle', label: 'Decorate Dock / Taskbar', checked: settings.dockDecoration,
      onChange: (v) => { settings.dockDecoration = v; settings.taskbarDecoration = v; persist({ immediate: true }).then(refreshDockStatus); },
    }),
    el('p', { class: 'hint', id: 'dock-status', 'data-testid': 'dock-status', text: 'Checking the Dock / taskbar…' }));
  panel.append(dockCard);

  panel.append(el('h2', { text: 'Sound' }));
  panel.append(el('div', { class: 'card' },
    slider({
      id: 'volume', label: 'Ambient volume', min: 0, max: 100, step: 5,
      value: Math.round(settings.soundVolume * 100), format: (v) => `${v}%`,
      onInput: (v) => { settings.soundVolume = v / 100; persist(); },
    })));

  panel.append(el('h2', { text: 'Performance' }));
  panel.append(el('div', { class: 'card' },
    dropdown({
      id: 'fps-limit', label: 'Frame rate cap', value: String(settings.fpsLimit),
      options: [['0', 'Unlimited (match display)'], ['144', '144 fps'], ['120', '120 fps'],
        ['60', '60 fps'], ['30', '30 fps (battery saver)']],
      onChange: (v) => { settings.fpsLimit = Number(v); persist(); },
    }),
    el('p', { class: 'hint', id: 'fps-readout', 'data-testid': 'fps-readout', text: 'Waiting for the overlay…' }),
    dropdown({
      id: 'renderer-pref', label: 'Tree renderer', value: settings.renderer ?? 'auto',
      options: [
        ['auto', 'Automatic (GPU when available)'],
        ['webgl', 'Always WebGL'],
        ['canvas', 'Always Canvas 2D'],
      ],
      onChange: (v) => { settings.renderer = v; persist(); },
    }),
    el('p', { class: 'hint', text: 'Automatic uses the WebGL engine only on a real GPU. On a software rasteriser it stays on Canvas 2D, which there is both faster and no less detailed. Takes effect on the next launch.' })));

  panel.append(el('h2', { text: 'Startup' }));
  panel.append(el('div', { class: 'card' },
    toggle({
      id: 'autostart-toggle', label: 'Start automatically with system', checked: settings.autostart,
      onChange: (v) => { settings.autostart = v; persist(); },
    })));
}

function renderAll() {
  renderScene();
  renderSnow();
  renderLights();
  renderSystem();
  renderPresets();
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
  select.replaceChildren(el('option', { value: '', text: '— Preset —' }));
  for (const p of presetList()) {
    select.append(el('option', { value: p.id, text: p.name }));
  }
  select.value = current;
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
  setStatus(`Applied “${preset.name}”`);
}

function setupPresetBar() {
  document.getElementById('preset-select').addEventListener('change', (e) => {
    if (e.target.value) applyPreset(e.target.value);
  });

  document.getElementById('preset-save').addEventListener('click', () => {
    const name = prompt('Name this preset', `Preset ${presetList().length + 1}`);
    if (!name) return;
    const snapshot = { ...settings };
    delete snapshot.presets; // a preset never contains the preset list
    settings.presets = [...presetList(), makePreset(name, snapshot)];
    renderPresets();
    persist({ immediate: true });
    setStatus(`Saved “${name}”`);
  });

  document.getElementById('preset-delete').addEventListener('click', () => {
    const select = document.getElementById('preset-select');
    if (!select.value) return;
    settings.presets = presetList().filter((p) => p.id !== select.value);
    renderPresets();
    persist({ immediate: true });
    setStatus('Preset deleted');
  });

  document.getElementById('preset-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(presetList(), null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'christmas-presets.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setStatus('Presets exported');
  });

  document.getElementById('preset-import').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result));
        if (!Array.isArray(imported)) throw new Error('not a preset list');
        // Merged, not replaced: importing someone else's presets should
        // never silently delete your own.
        const existing = new Set(presetList().map((p) => p.id));
        settings.presets = [...presetList(), ...imported.filter((p) => p?.id && !existing.has(p.id))];
        renderPresets();
        persist({ immediate: true });
        setStatus(`Imported ${imported.length} preset(s)`);
      } catch {
        setStatus('That file is not a preset list');
      }
    };
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// chrome
// ---------------------------------------------------------------------------

function applyThemeColors() {
  const theme = themes.find((t) => t.id === settings.themeId);
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--primary', theme.colors.primary);
  root.style.setProperty('--secondary', theme.colors.secondary);
  root.style.setProperty('--accent', theme.colors.accent);
  root.style.setProperty('--background', theme.colors.background);
}

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.setAttribute('aria-selected', String(other === tab));
      }
      for (const [name, panel] of Object.entries(panels)) {
        panel.hidden = name !== tab.dataset.tab;
      }
    });
  }
}

async function refreshDockStatus() {
  const node = document.getElementById('dock-status');
  if (!node) return;
  try {
    const { strips, reason } = await dockStatus();
    node.textContent = strips?.length
      ? `Detected on ${strips.length} screen(s): ${strips.map((s) => `${s.edge} (${s.barThickness}px)`).join(', ')}`
      : (reason ?? 'No Dock / taskbar strip detected.');
  } catch {
    node.textContent = 'Dock / taskbar status unavailable.';
  }
}

document.getElementById('disable-btn').addEventListener('click', async () => {
  await disableEverything();
  setStatus('Everything disabled');
});

onStats(({ fps, frameMs, particles }) => {
  const node = document.getElementById('fps-readout');
  if (node) node.textContent = `${fps} fps · ${frameMs} ms/frame · ${particles} flakes`;
});

async function init() {
  [themes, screens, settings] = await Promise.all([listThemes(), listScreens(), getSettings()]);
  if (!settings.scene) settings.scene = defaultScene();
  if (!Array.isArray(settings.presets)) settings.presets = [];
  activeScreen = screens[0]?.index ?? 0;
  setupTabs();
  setupPresetBar();
  applyThemeColors();
  renderAll();
  refreshDockStatus();
}

// Exposed so tests can await the initial load before asserting.
window.settingsReady = init();
