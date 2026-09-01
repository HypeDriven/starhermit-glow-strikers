// Platform layer: per-game settings, versioned+checksummed local save,
// host time synchronization, achievements, leaderboards, telemetry consent,
// and presence heartbeats. No credentials or tokens are ever persisted.

import { hashValue } from './rng.js';
import { ACHIEVEMENTS, CONTENT_VERSION, RULESET_ID } from './content.js';

const SAVE_KEY = 'glow-strikers.save.v1';
const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS = {
  volumeMusic: 0.6,
  volumeEffects: 0.8,
  volumeAmbience: 0.5,
  volumeVoice: 0.8,
  muted: false,
  quality: 'auto',            // auto | low | medium | high
  reducedMotion: false,
  highContrast: false,
  palette: 'default',         // default | deuteranopia | protanopia | tritanopia
  textScale: 1,
  leftHanded: false,
  holdToAim: false,           // hold-vs-toggle pointer control
  timingAssist: false,        // slightly slows solo simulation
  haptics: true,
  captions: true,
  keys: {                     // desktop bindings (player overrides allowed)
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    pause: 'Escape', undo: 'KeyZ', camera: 'KeyC', hint: 'KeyH',
  },
  tutorialDone: false,
  telemetryConsent: false,
};

function defaultSave() {
  return {
    version: SAVE_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
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
    leaderboards: {              // local boards; server boards are authoritative when hosted
      daily: {},                 // dateKey -> [entries]
      journey: [],               // mastery clear times
      challenge: {},             // challengeId -> [entries]
    },
  };
}

export class Platform {
  constructor() {
    this.save = defaultSave();
    this.timeOffset = 0;        // server - client (ms)
    this.timeSynced = false;
    this.telemetryQueue = [];
    this.online = false;
  }

  // --- persistence ---------------------------------------------------------

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const doc = JSON.parse(raw);
      if (doc.checksum !== hashValue(doc.payload)) {
        console.warn('save checksum mismatch; starting fresh');
        return false;
      }
      this.save = migrate(JSON.parse(doc.payload));
      return true;
    } catch (e) {
      console.warn('save load failed', e);
      return false;
    }
  }

  persist() {
    try {
      const payload = JSON.stringify(this.save);
      localStorage.setItem(SAVE_KEY, JSON.stringify({ checksum: hashValue(payload), payload }));
    } catch (e) { /* storage may be unavailable; session continues unsaved */ }
  }

  get settings() { return this.save.settings; }

  updateSettings(patch) {
    Object.assign(this.save.settings, patch);
    this.persist();
    this.track('settings_change', { keys: Object.keys(patch).sort().join(',') });
  }

  // --- host time sync --------------------------------------------------------

  /** Round-trip-adjusted offset from GET /api/v1/time; falls back to local. */
  async syncTime() {
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const t1 = Date.now();
      const serverNow = typeof body.now === 'number' ? body.now : body.serverTime;
      if (typeof serverNow !== 'number') throw new Error('invalid time response');
      this.timeOffset = serverNow - Math.round((t0 + t1) / 2);
      this.timeSynced = true;
      this.online = true;
    } catch {
      this.timeOffset = 0;
      this.timeSynced = false;
    }
    return this.now();
  }

  now() { return new Date(Date.now() + this.timeOffset); }

  /** Seconds until the next UTC daily boundary, using synchronized time. */
  secondsUntilNextDaily() {
    const n = this.now();
    const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
    return Math.max(0, Math.round((next - n.getTime()) / 1000));
  }

  // --- achievements ------------------------------------------------------------

  unlock(key) {
    if (!ACHIEVEMENTS.some(a => a.key === key)) return null;
    if (this.save.achievements[key]) return null; // idempotent
    const rec = { unlockedAt: this.now().toISOString() };
    this.save.achievements[key] = rec;
    this.persist();
    this.track('achievement', { key });
    return ACHIEVEMENTS.find(a => a.key === key);
  }

  hasAchievement(key) { return !!this.save.achievements[key]; }

  // --- leaderboards --------------------------------------------------------------

  /**
   * Validate + record a result. Returns the entry or null when rejected
   * (impossible or stale-version scores are refused).
   */
  submitResult(board, entry) {
    if (!entry || entry.ruleset !== RULESET_ID) return null;
    if (entry.contentVersion !== CONTENT_VERSION) return null;   // stale
    if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 99) return null;
    if (!Number.isInteger(entry.durationTicks) || entry.durationTicks < 60) return null;
    if (entry.durationTicks > 60 * 60 * 30) return null;         // implausible
    const e = { ...entry, submittedAt: this.now().toISOString() };
    const lb = this.save.leaderboards;
    let list;
    if (board === 'daily') list = lb.daily[entry.boardKey] ??= [];
    else if (board === 'challenge') list = lb.challenge[entry.boardKey] ??= [];
    else list = lb.journey;
    list.push(e);
    list.sort((a, b) => b.score - a.score || a.durationTicks - b.durationTicks);
    lb.trimmed = true;
    if (list.length > 20) list.length = 20;
    this.persist();
    return e;
  }

  getBoard(board, key) {
    const lb = this.save.leaderboards;
    if (board === 'daily') return lb.daily[key] ?? [];
    if (board === 'challenge') return lb.challenge[key] ?? [];
    return lb.journey;
  }

  // --- telemetry (anonymous funnel events only) -----------------------------------

  track(event, data = {}) {
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error', 'achievement'];
    if (!allowed.includes(event)) return;
    if (!this.save.settings.telemetryConsent) return;
    this.telemetryQueue.push({ event, data, t: Date.now() });
    if (this.telemetryQueue.length > 50) this.telemetryQueue.shift();
  }

  // --- presence -------------------------------------------------------------------

  startPresence() {
    this.stopPresence();
    if (!this.online) return;
    this._presence = setInterval(() => {
      fetch('/api/v1/presence', { method: 'POST' }).catch(() => {});
    }, 30000);
  }
  stopPresence() { clearInterval(this._presence); this._presence = null; }
}

function migrate(save) {
  // Versioned migration path; unknown versions fall back to defaults + salvage.
  if (!save || typeof save !== 'object') return defaultSave();
  if (save.version === SAVE_VERSION) return { ...defaultSave(), ...save, settings: { ...DEFAULT_SETTINGS, ...save.settings } };
  const fresh = defaultSave();
  fresh.settings = { ...fresh.settings, ...(save.settings ?? {}) };
  fresh.progression = { ...fresh.progression, ...(save.progression ?? {}) };
  fresh.version = SAVE_VERSION;
  return fresh;
}
