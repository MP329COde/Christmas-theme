// Traductions de l'interface.
//
// La clé d'une chaîne est son texte français : `t('Sapin')`. Le français
// est donc la langue source et n'a pas de dictionnaire ; chaque autre
// langue est un simple objet { 'texte français': 'traduction' } dans son
// propre fichier. Ajouter une langue = ajouter un fichier et une ligne
// dans LANGUAGES ci-dessous. tests/i18n.spec.js vérifie qu'aucune chaîne
// affichée ne manque dans aucune langue.

import en from './en.js';
import es from './es.js';
import de from './de.js';
import it from './it.js';

export const LANGUAGES = {
  fr: { name: 'Français', dict: null },
  en: { name: 'English', dict: en },
  es: { name: 'Español', dict: es },
  de: { name: 'Deutsch', dict: de },
  it: { name: 'Italiano', dict: it },
};

let current = 'fr';
const missing = new Set();

/// 'auto' suit la langue du système (navigator.languages), en retombant
/// sur l'anglais pour une langue que l'application ne parle pas.
export function resolveLanguage(preference) {
  if (preference && preference !== 'auto' && LANGUAGES[preference]) return preference;
  const wanted = typeof navigator !== 'undefined'
    ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const tag of wanted) {
    const code = String(tag ?? '').toLowerCase().split('-')[0];
    if (LANGUAGES[code]) return code;
  }
  return 'en';
}

export function setLanguage(preference) {
  current = resolveLanguage(preference);
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  return current;
}

export function getLanguage() {
  return current;
}

/// Traduit `text` et remplace les {jetons} par `vars`.
export function t(text, vars) {
  const dict = LANGUAGES[current]?.dict;
  let out = text;
  if (dict) {
    if (Object.prototype.hasOwnProperty.call(dict, text)) out = dict[text];
    else missing.add(text);
  }
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

/// Traduit le balisage statique : data-i18n (texte), data-i18n-title,
/// data-i18n-aria. La clé française est mémorisée au premier passage pour
/// qu'un changement de langue à chaud reparte toujours de la source.
export function translateDom(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    if (!node.dataset.i18n) node.dataset.i18n = node.textContent.trim();
    node.textContent = t(node.dataset.i18n);
  }
  for (const [attr, target] of [['i18nTitle', 'title'], ['i18nAria', 'aria-label']]) {
    for (const node of root.querySelectorAll(`[data-${attr === 'i18nTitle' ? 'i18n-title' : 'i18n-aria'}]`)) {
      if (!node.dataset[attr]) node.dataset[attr] = node.getAttribute(target) ?? '';
      node.setAttribute(target, t(node.dataset[attr]));
    }
  }
}

if (typeof window !== 'undefined') window.__i18nMissing = missing;
