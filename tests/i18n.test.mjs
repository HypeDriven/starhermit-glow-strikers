// Localization coverage: every English key the engine client shows — the
// T("…") literals of native/*.ts, the status and toast keys net.ts hands to
// T(), the label tables translated through T(variable), the content shown
// through T(variable) (journey, challenges, lessons, achievements) — is in
// every locale's table (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit)
// with its placeholders intact, and the account strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JOURNEY, CHALLENGES, LESSONS, ACHIEVEMENTS } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = JSON.parse(read('assets/strings.json'));
const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

// Label tables that reach T() through a variable (native/main.ts, native/screens.ts).
const TABLE_KEYS = [
  'strike', 'defend', 'obstacles', 'time pressure', 'move budget', 'combined',            // MECHANICS
  'Relaxed', 'Club', 'Pro', 'Legend',                                                      // DIFFICULTIES
  'Target score reached', 'Time limit', 'Overtime golden goal', 'Forfeit', 'Move budget exhausted', // TERMINAL_LABEL
  'Goals', 'Shots', 'Saves', 'Steals', 'Invalid actions', 'Rail bounces', 'Fastest strike', // results rows
  'practice', 'journey', 'daily', 'challenge', 'learn', 'hosted',                          // pause context
  'Victory', 'Defeat', 'Draw', 'Lesson complete', 'Lesson ended',                         // headlines
];

function usedKeys() {
  const keys = new Set(TABLE_KEYS);
  for (const f of readdirSync(new URL('native/', ROOT))) {
    const src = read(`native/${f}`);
    for (const m of src.matchAll(/\bT\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
  }
  const net = read('native/net.ts');
  for (const m of net.matchAll(/\b(?:say|toast)\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
  for (const m of net.matchAll(/(?:say|fail)\([^;]*?\? "((?:[^"\\]|\\.)*)" : "((?:[^"\\]|\\.)*)"/g)) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of net.matchAll(/fallback = "((?:[^"\\]|\\.)*)"|fail\(e, "((?:[^"\\]|\\.)*)"\)/g)) keys.add(m[1] ?? m[2]);
  JOURNEY.forEach((s) => keys.add(s.name));
  CHALLENGES.forEach((c) => { keys.add(c.name); keys.add(c.description); });
  LESSONS.forEach((l) => { keys.add(l.title); keys.add(l.text); });
  ACHIEVEMENTS.forEach((a) => { keys.add(a.name); keys.add(a.description); });
  return [...keys].filter((k) => k && /[A-Za-z]/.test(k) && !k.startsWith('starhermit.')).sort();
}

const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
function lookup(locale, key) {
  for (let l = locale; l; l = PARENT[l]) if (TABLES[l] && Object.prototype.hasOwnProperty.call(TABLES[l], key)) return TABLES[l][key];
  return null;
}

test('every used key is translated in every locale; placeholders intact', () => {
  const keys = usedKeys();
  assert.ok(keys.length > 150, `found ${keys.length} keys`);
  const problems = [];
  for (const k of keys) {
    for (const l of FULL) {
      const v = lookup(l, k);
      if (v == null) problems.push(`${l}: missing "${k}"`);
      else if (holes(v) !== holes(k)) problems.push(`${l}: placeholders of "${k}"`);
    }
  }
  assert.deepEqual(problems, []);
});

test('account lines cover all nine locales', () => {
  const keys = Object.keys(TABLES['en-US']).filter((k) => k.startsWith('acct.'));
  assert.ok(keys.length > 10);
  for (const l of LOCALES) for (const k of keys) assert.ok(lookup(l, k), `${l} ${k}`);
});
