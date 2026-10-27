// Pure save-document helpers shared by the engine client (native/platform.ts)
// and the node tests: the progress document's shape, its versioned migration,
// the merge of two devices' copies, the local personal-best boards and the
// achievements record — js/platform.js's data rules from the browser build,
// without the DOM, localStorage or the JS SDK.
//
// The document is the browser build's save doc { version, progression,
// achievements, leaderboards } (its `settings` part moved to the runtime's
// Options and the game's own settings store). The browser build's cloud slot
// held { checksum, payload } as text (the SDK's zipped save.json): read it
// with docFromBrowserSave.

import { hashValue } from './rng.js';
import { ACHIEVEMENTS, CONTENT_VERSION, RULESET_ID } from './content.js';

export const SAVE_VERSION = 1;

/** The game's own settings (game.<key> in the runtime's settings store), with their checks. */
const bool = (v) => typeof v === 'boolean';
export const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
const GAME_SETTINGS = {
  captions: bool,
  palette: (v) => PALETTES.includes(v),
  leftHanded: bool,
  holdToAim: bool,
  timingAssist: bool,
  haptics: bool,
  tutorialDone: bool,
};
export const GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
export const DEFAULT_SETTINGS = { captions: true, palette: 'default', leftHanded: false, holdToAim: false, timingAssist: false, haptics: true, tutorialDone: false };
/** Every key the browser build kept in the account's per-player settings (the SDK's settings PATCH). */
export const BROWSER_SETTING_KEYS = [
  'volumeMusic', 'volumeEffects', 'volumeAmbience', 'volumeVoice', 'muted', 'graphics',
  'reducedMotion', 'highContrast', 'palette', 'textScale', 'leftHanded', 'holdToAim',
  'timingAssist', 'haptics', 'captions',
];
/** A browser-build setting's value as the engine client keeps it, or undefined (dropped: the runtime owns it). */
export function migrateSetting(key, value) {
  const check = GAME_SETTINGS[key];
  return check && check(value) ? value : undefined;
}

/**
 * @typedef {{ name?: string, score: number, durationTicks?: number, [key: string]: unknown }} BoardEntry
 * @typedef {{
 *   version: number,
 *   progression: { journeyCompleted: string[], journeyStars: Record<string, number>, totalGoals: number, wins: number, losses: number,
 *     currentStreak: number, bestStreak: number, lessonsDone: string[], dailyDays: string[], challengesDone: string[],
 *     cosmetics: { theme: string, trail: string } },
 *   achievements: Record<string, { unlockedAt: string }>,
 *   leaderboards: { daily: Record<string, BoardEntry[]>, journey: BoardEntry[], challenge: Record<string, BoardEntry[]> },
 * }} SaveDoc
 */

/** @returns {SaveDoc} */
export function defaultSave() {
  return {
    version: SAVE_VERSION,
    progression: {
      journeyCompleted: [],      // stage ids
      journeyStars: {},          // id -> 1..3
      totalGoals: 0,
      wins: 0, losses: 0,
      currentStreak: 0, bestStreak: 0,
      lessonsDone: [],
      dailyDays: [],             // YYYY-MM-DD completed
      challengesDone: [],
      cosmetics: { theme: 'neon-dusk', trail: 'spark' },
    },
    achievements: {},            // key -> { unlockedAt }
    leaderboards: {              // personal bests on this account
      daily: {},                 // dateKey -> [entries]
      journey: [],               // mastery clear times
      challenge: {},             // challengeId -> [entries]
    },
  };
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Any stored document (browser build or engine) as a complete current one; settings are dropped. */
export function migrate(save) {
  const fresh = defaultSave();
  if (!save || typeof save !== 'object') return fresh;
  fresh.progression = { ...fresh.progression, ...obj(save.progression) };
  fresh.progression.cosmetics = { ...defaultSave().progression.cosmetics, ...obj(fresh.progression.cosmetics) };
  for (const k of ['journeyCompleted', 'lessonsDone', 'dailyDays', 'challengesDone']) {
    if (!Array.isArray(fresh.progression[k])) fresh.progression[k] = [];
  }
  fresh.progression.journeyStars = obj(fresh.progression.journeyStars);
  fresh.achievements = { ...obj(save.achievements) };
  const lb = obj(save.leaderboards);
  fresh.leaderboards = { daily: obj(lb.daily), journey: Array.isArray(lb.journey) ? lb.journey : [], challenge: obj(lb.challenge) };
  return fresh;
}

/** The browser build's save doc's game settings that the engine client keeps (valid ones only). */
export function settingsFromBrowserSave(save) {
  const out = {};
  const s = obj(save && save.settings);
  for (const k of GAME_SETTING_KEYS) {
    const v = migrateSetting(k, s[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The browser build's cloud save (the text of its save.json: { checksum,
 * payload }), as { doc, settings }, or null when it is not one (a checksum
 * mismatch is corruption: not adopted).
 */
export function docFromBrowserSave(text) {
  if (typeof text !== 'string') return null;
  try {
    const wrapped = JSON.parse(text);
    if (!wrapped || typeof wrapped.payload !== 'string') return null;
    if (wrapped.checksum !== hashValue(wrapped.payload)) return null;
    const raw = JSON.parse(wrapped.payload);
    return { doc: migrate(raw), settings: settingsFromBrowserSave(raw) };
  } catch { return null; }
}

/** An engine save's data as a document, or null. */
export function docFromSave(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? migrate(data) : null;
}

/**
 * Merge two diverged save docs so neither device loses progress: union of
 * cleared stages, lessons, daily days, challenges and achievements (earliest
 * unlock), the best stars per stage, the larger goal / win / loss / best-streak
 * counts, and the union of board entries. Cosmetics and the current streak
 * come from `local` (this device).
 */
export function mergeSaves(remote, local) {
  const a = migrate(remote), b = migrate(local);
  const out = JSON.parse(JSON.stringify(b));
  const pa = a.progression, pb = b.progression, po = out.progression;
  const union = (x, y) => [...new Set([...(x || []), ...(y || [])])];
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const time = (v) => { const t = Date.parse(v?.unlockedAt); return Number.isFinite(t) ? t : Infinity; };
  po.journeyCompleted = union(pa.journeyCompleted, pb.journeyCompleted);
  po.lessonsDone = union(pa.lessonsDone, pb.lessonsDone);
  po.dailyDays = union(pa.dailyDays, pb.dailyDays).sort();
  po.challengesDone = union(pa.challengesDone, pb.challengesDone);
  po.journeyStars = { ...pa.journeyStars };
  for (const [k, v] of Object.entries(pb.journeyStars || {})) po.journeyStars[k] = Math.max(num(v), num(po.journeyStars[k]));
  for (const k of ['totalGoals', 'wins', 'losses', 'bestStreak']) po[k] = Math.max(num(pa[k]), num(pb[k]));
  out.achievements = { ...a.achievements };
  for (const [k, v] of Object.entries(b.achievements || {})) {
    const other = out.achievements[k];
    out.achievements[k] = !other || time(v) < time(other) ? v : other;
  }
  const entries = (x, y) => {
    const seen = new Set();
    return [...(x || []), ...(y || [])].filter((e) => { const id = JSON.stringify(e); if (seen.has(id)) return false; seen.add(id); return true; })
      .sort((p, q) => q.score - p.score || p.durationTicks - q.durationTicks).slice(0, 20);
  };
  const la = a.leaderboards, lb = b.leaderboards;
  out.leaderboards = { daily: {}, journey: entries(la.journey, lb.journey), challenge: {} };
  for (const k of new Set([...Object.keys(la.daily), ...Object.keys(lb.daily)])) out.leaderboards.daily[k] = entries(la.daily[k], lb.daily[k]);
  for (const k of new Set([...Object.keys(la.challenge), ...Object.keys(lb.challenge)])) out.leaderboards.challenge[k] = entries(la.challenge[k], lb.challenge[k]);
  return out;
}

/** Unlock an achievement in the document (idempotent); its definition when new, else null. */
export function unlock(save, key, nowIso) {
  const def = ACHIEVEMENTS.find((a) => a.key === key);
  if (!def || save.achievements[key]) return null;
  save.achievements[key] = { unlockedAt: nowIso };
  return def;
}

/**
 * Validate + record a personal-best entry. Returns the entry or null when
 * rejected (impossible or stale-version scores are refused).
 */
export function submitResult(save, board, entry, nowIso) {
  if (!entry || entry.ruleset !== RULESET_ID) return null;
  if (entry.contentVersion !== CONTENT_VERSION) return null;   // stale
  if (!['journey', 'daily', 'challenge'].includes(board)) return null;
  // Mastery uses stars * 1000 - elapsed seconds; match boards use goal margin.
  const minScore = board === 'journey' ? -1800 : -99;
  const maxScore = board === 'journey' ? 3000 : 99;
  if (!Number.isInteger(entry.score) || entry.score < minScore || entry.score > maxScore) return null;
  if (!Number.isInteger(entry.durationTicks) || entry.durationTicks < 60) return null;
  if (entry.durationTicks > 60 * 60 * 30) return null;         // implausible
  const e = { ...entry, submittedAt: nowIso };
  const lb = save.leaderboards;
  let list;
  if (board === 'daily') list = lb.daily[entry.boardKey] ??= [];
  else if (board === 'challenge') list = lb.challenge[entry.boardKey] ??= [];
  else list = lb.journey;
  list.push(e);
  list.sort((a, b) => b.score - a.score || a.durationTicks - b.durationTicks);
  if (list.length > 20) list.length = 20;
  return e;
}

export function getBoard(save, board, key) {
  const lb = save.leaderboards;
  if (board === 'daily') return lb.daily[key] ?? [];
  if (board === 'challenge') return lb.challenge[key] ?? [];
  return lb.journey;
}
