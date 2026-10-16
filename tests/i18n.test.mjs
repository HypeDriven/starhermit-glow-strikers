// Localization coverage: every English key the UI shows — index.html markup,
// prose literals the el()-built screens, toasts, captions and statuses pass as
// text, T('…') / N('…') keys, and the content shown through T(variable) — is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit) with intact placeholders; no prose template literal bypasses T();
// the language follows sh-language.js and switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, proseLiterals, proseTemplates, markupKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';
import { JOURNEY, CHALLENGES, LESSONS, ACHIEVEMENTS } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const FILES = ['js/i18n/strings.js', 'js/i18n/strings-content.js'];
const UI = ['js/ui.js', 'js/main.js', 'js/audio.js'];
const CODE = [...UI, 'js/net.js', 'js/session.js', 'js/platform.js'];

export function usedKeys() {
  const keys = new Set(markupKeys(read('index.html')));
  for (const f of CODE) codeKeys(read(f)).forEach((k) => keys.add(k));
  // Setting keys (camelCase), the logo and glyph labels are not prose.
  const NOT_TEXT = new Set(['GLOW STRIKERS', 'II', 'Esc']);
  for (const f of UI) proseLiterals(read(f)).filter((k) => !/^[a-z]+[A-Z]\w*$/.test(k) && !NOT_TEXT.has(k)).forEach((k) => keys.add(k));
  JOURNEY.forEach((s) => keys.add(s.name));
  CHALLENGES.forEach((c) => { keys.add(c.name); keys.add(c.description); });
  LESSONS.forEach((l) => { keys.add(l.title); keys.add(l.text); });
  ACHIEVEMENTS.forEach((a) => { keys.add(a.name); keys.add(a.description); });
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, FILES, 'GS_STRINGS'), usedKeys()), []);
});

test('no prose template literal bypasses T()', () => {
  const bad = CODE.flatMap((f) => proseTemplates(read(f)).map((t) => `${f}: ${t}`))
    .filter((t) => !/\/ws$|r…-ai-…|…:\/\/|: \?\w+=/.test(t)); // URLs and query strings
  assert.deepEqual(bad, []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { files: ['sh-language.js', ...FILES, 'js/i18n/i18n.js'], global: 'GSI18N', event: 'gs-language', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Hosted Play'), 'Online-Spiel');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('es-ES');
  assert.equal(I18N.T('First to {n}', { n: 5 }), 'Primero a 5');
});

test('graphics and platform strings cover all nine locales', async () => {
  const { platformStrings, PLATFORM_LOCALES } = await import('../js/platform-strings.js');
  const { gfxStrings } = await import('../js/gfx-strings.js');
  for (const l of LOCALES) {
    assert.ok(PLATFORM_LOCALES.includes(l), l);
    for (const k of Object.keys(platformStrings('en-US'))) assert.ok(platformStrings(l)[k], `${l} ${k}`);
    assert.ok(gfxStrings(l).graphics, l);
  }
});
