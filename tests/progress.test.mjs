// The save document (js/progress.js): the browser build's cloud save (the JS
// SDK's save.json text, { checksum, payload }) migrates — checked, its game
// settings carried over, its settings part dropped; two devices' documents
// merge without losing progress; achievements unlock once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashValue } from '../js/rng.js';
import * as G from '../js/progress.js';

function browserSave(doc) {
  const payload = JSON.stringify(doc);
  return JSON.stringify({ checksum: hashValue(payload), payload });
}
const OLD = {
  version: 1,
  settings: { volumeMusic: 0.3, graphics: { preset: 'high' }, captions: false, palette: 'tritanopia', holdToAim: true, keys: { up: 'KeyW' }, telemetryConsent: true },
  progression: { journeyCompleted: ['j01', 'j02'], journeyStars: { j01: 3, j02: 1 }, totalGoals: 42, wins: 7, losses: 3, currentStreak: 2, bestStreak: 4, lessonsDone: ['learn-move'], dailyDays: ['2026-10-01'], challengesDone: ['ch-blitz'], cosmetics: { theme: 'violet-abyss', trail: 'spark' } },
  achievements: { first_victory: { unlockedAt: '2026-09-01T10:00:00.000Z' } },
  leaderboards: { daily: { '2026-10-01': [{ score: 30, durationTicks: 3000 }] }, journey: [], challenge: {} },
};

test('the browser build\'s cloud save migrates with its game settings', () => {
  const r = G.docFromBrowserSave(browserSave(OLD));
  assert.ok(r);
  assert.deepEqual(r.doc.progression.journeyCompleted, ['j01', 'j02']);
  assert.equal(r.doc.progression.cosmetics.theme, 'violet-abyss');
  assert.equal(r.doc.achievements.first_victory.unlockedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(r.doc.leaderboards.daily['2026-10-01'][0].score, 30);
  assert.equal('settings' in r.doc, false);
  assert.deepEqual(r.settings, { captions: false, palette: 'tritanopia', holdToAim: true });
});

test('a corrupted or foreign slot is not adopted', () => {
  const bad = JSON.parse(browserSave(OLD));
  bad.checksum = '00000000';
  assert.equal(G.docFromBrowserSave(JSON.stringify(bad)), null);
  assert.equal(G.docFromBrowserSave('not json'), null);
  assert.equal(G.docFromBrowserSave(null), null);
});

test('merging keeps the best of both devices', () => {
  const a = G.migrate(OLD);
  const b = G.defaultSave();
  b.progression.journeyCompleted = ['j01', 'j03'];
  b.progression.journeyStars = { j01: 1, j03: 2 };
  b.progression.wins = 9;
  b.progression.currentStreak = 0;
  b.achievements = { first_victory: { unlockedAt: '2026-08-01T00:00:00.000Z' }, streak_three: { unlockedAt: '2026-10-02T00:00:00.000Z' } };
  b.leaderboards.daily['2026-10-01'] = [{ score: 40, durationTicks: 2000 }];
  const m = G.mergeSaves(a, b);
  assert.deepEqual([...m.progression.journeyCompleted].sort(), ['j01', 'j02', 'j03']);
  assert.deepEqual(m.progression.journeyStars, { j01: 3, j02: 1, j03: 2 });
  assert.equal(m.progression.wins, 9);
  assert.equal(m.progression.totalGoals, 42);
  assert.equal(m.progression.currentStreak, 0); // this device's
  assert.equal(m.achievements.first_victory.unlockedAt, '2026-08-01T00:00:00.000Z'); // the earliest
  assert.ok(m.achievements.streak_three);
  assert.deepEqual(m.leaderboards.daily['2026-10-01'].map((e) => e.score), [40, 30]);
  assert.deepEqual(G.mergeSaves(m, m), m);
});

test('achievements unlock once; game settings are checked', () => {
  const s = G.defaultSave();
  assert.equal(G.unlock(s, 'first_victory', 'x')?.key, 'first_victory');
  assert.equal(G.unlock(s, 'first_victory', 'y'), null);
  assert.equal(G.unlock(s, 'nope', 'y'), null);
  assert.equal(G.migrateSetting('palette', 'mono'), undefined);
  assert.equal(G.migrateSetting('volumeMusic', 0.5), undefined);
  assert.equal(G.migrateSetting('haptics', false), false);
});
