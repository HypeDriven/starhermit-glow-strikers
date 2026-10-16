// Glow Strikers — translation helpers for ES modules. Tables and the language
// choice live in js/i18n/i18n.js (window.GSI18N); outside the browser (unit
// tests) T() returns the English key with {placeholders} filled.

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

/** Translate an English source string. */
export function T(key, vars) {
  const I = globalThis.GSI18N;
  return I ? I.T(key, vars) : fill(key, vars);
}

/**
 * Marks English text that is rendered as-is and translated by the DOM
 * observer in i18n.js (stays live across language changes); also keeps the
 * key visible to tests/i18n.test.mjs.
 */
export const N = (key) => key;

/** The effective game locale (en-US outside the browser). */
export function lang() {
  return globalThis.GSI18N?.lang || 'en-US';
}

/** A player name: built-in labels ("You", "AI") are translated, typed names are not. */
export function pname(name) {
  const I = globalThis.GSI18N;
  return I && I.has(name) ? I.T(name) : String(name ?? '');
}
