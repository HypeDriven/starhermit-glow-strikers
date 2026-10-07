// Platform layer: per-game settings, versioned+checksummed local save,
// achievements, leaderboards and telemetry consent, plus the StarHermit
// surface over window.StarHermit (starhermit-sdk.js, loaded by index.html
// before the game modules). No credentials or tokens are ever persisted.
//
// Hosted mode activates only when the SDK read a launch token (#game_token=…
// library launch or #access_token=… sign-in return; stripped from the URL).
// The SDK renews it, and owns the cloud-save slot game:<slug>, the settings
// KV and the controls endpoint. Without a token nothing touches the network.

import { hashValue } from './rng.js';
import { ACHIEVEMENTS, CONTENT_VERSION, RULESET_ID } from './content.js';

const sdk = () => globalThis.StarHermit ?? null;

/** Keyboard actions → default KeyboardEvent.code lists (control.* in starhermit.txt). */
export const DEFAULT_KEYS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  pause: ['Escape'], undo: ['KeyZ'], camera: ['KeyC'], hint: ['KeyH'],
};

/** Preferences mirrored to the platform settings KV (same keys as save.settings). */
export const SYNCED_SETTINGS = [
  'volumeMusic', 'volumeEffects', 'volumeAmbience', 'volumeVoice', 'muted', 'graphics',
  'reducedMotion', 'highContrast', 'palette', 'textScale', 'leftHanded', 'holdToAim',
  'timingAssist', 'haptics', 'captions',
];

const SAVE_KEY = 'glow-strikers.save.v1';
const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS = {
  volumeMusic: 0.6,
  volumeEffects: 0.8,
  volumeAmbience: 0.5,
  volumeVoice: 0.8,
  muted: false,
  // Graphics quality (js/gfx.js): preset auto|low|balanced|high|ultra, render
  // scale, adaptive resolution, fps readout, plus optional per-category overrides.
  graphics: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false },
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
  constructor(sh = sdk()) {
    this.sh = sh;
    if (sh && !sh.__glowInit) { sh.__glowInit = true; sh.init(); }
    this.save = defaultSave();
    this.telemetryQueue = [];
    this.nickname = null;              // resolved async from the profile route
    this.syncStatus = 'offline';       // offline | saving | synced
    this.onSync = null;                // fn(status) — sync status display hook
    this.onSignedOut = null;           // fn() — renewal refused: back to local play
    this.keyBindings = null;           // platform bindings ({ action: codes[] }) when hosted
    this._lastSettings = null;
    if (sh) {
      sh.on('saved', (ok) => this._setSync(ok ? 'synced' : 'offline'));
      sh.on('auth', (a) => {
        if (a.signedIn) return;
        this.keyBindings = null;
        this._setSync('offline');
        this.onSignedOut?.();
      });
    }
  }

  /** True when the SDK holds a platform launch token. */
  get hosted() { return !!(this.sh?.signedIn && this.sh.slug); }
  get token() { return this.hosted ? this.sh.token : null; }
  get sub() { return this.sh?.userId ?? null; }
  get gameSlug() { return this.sh?.slug ?? null; }
  get canSignIn() { return !!this.sh?.canSignIn(); }
  signIn() { return !!this.sh?.signIn(); }
  /** Share link that friends the recipient and invites them back (null signed out). */
  inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }

  /** Display name: profile nickname, else "Player " + id. Null when anonymous. */
  get displayName() {
    if (!this.hosted) return null;
    if (this.nickname) return this.nickname;
    return this.sub ? `Player ${this.sub.slice(0, 6)}` : null;
  }

  /** Title-screen identity line; '' offline. */
  accountLine() {
    if (!this.hosted) return '';
    const sync = { saving: 'saving…', synced: 'synced', offline: 'offline' }[this.syncStatus] ?? 'offline';
    return `Playing as ${this.displayName ?? '…'} · cloud save ${sync}`;
  }

  _setSync(status) {
    if (this.syncStatus === status) return;
    this.syncStatus = status;
    this.onSync?.(status);
  }

  // --- hosted API ------------------------------------------------------------

  /**
   * Authenticated platform call through the SDK, returned as a minimal
   * Response-like object ({ ok, status, json() }) for the rooms client.
   * SDK null (404 / 204) reads as status 404.
   */
  async api(path, opts = {}) {
    if (!this.hosted) throw new Error('offline');
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    try {
      const data = await this.sh.api(path, { method: opts.method ?? 'GET', body });
      return data == null
        ? { ok: false, status: 404, json: async () => null }
        : { ok: true, status: 200, json: async () => data };
    } catch (e) {
      return { ok: false, status: e?.status ?? 0, json: async () => e?.body ?? null };
    }
  }

  /** Resolve a user id to a display nickname (SDK-cached); "Player <id>" fallback. */
  async profileFor(userId) {
    const p = this.hosted ? await this.sh.profile(userId).catch(() => null) : null;
    return p?.displayName ?? `Player ${String(userId).slice(0, 6)}`;
  }

  /** Load the signed-in player's profile into displayName. */
  async fetchProfile() {
    if (!this.hosted || !this.sub) return null;
    this.nickname = await this.profileFor(this.sub);
    return this.nickname;
  }

  /** Friends with online state, for room invites. */
  friends() { return this.hosted ? this.sh.friends() : Promise.resolve([]); }

  /** Read-only platform leaderboard (clients can never submit scores). */
  async fetchPlatformLeaderboard({ page = 0, pageSize = 20, friendsOnly = false } = {}) {
    if (!this.hosted) return null;
    try {
      const info = await this.sh.getGame();
      const leaderboardId = info?.leaderboardId ?? null;
      const base = { me: info?.me ?? null, leaderboardId, entries: [] };
      if (!leaderboardId) return base;
      const qs = `?friendsOnly=${friendsOnly ? 'true' : ''}&page=${page}&pageSize=${pageSize}`;
      const data = await this.sh.api(`/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries${qs}`).catch(() => null);
      if (!data) return base;
      const rows = Array.isArray(data) ? data : (data?.entries ?? data?.items ?? []);
      for (const r of rows) {
        const userId = r?.userId ?? r?.playerId ?? null;
        base.entries.push({
          userId,
          name: userId ? await this.profileFor(userId) : (r?.name ?? 'Player'),
          score: r?.score ?? 0,
          rank: r?.rank ?? null,
          you: !!userId && userId === this.sub,
        });
      }
      if (base.me == null && !Array.isArray(data)) base.me = data?.me ?? null;
      return base;
    } catch {
      return null;   // offline / not reachable: caller shows local records only
    }
  }

  // --- cloud save (mirror of the checksummed local doc, slot game:<slug>) ------

  _queueCloudSave() {
    if (!this.hosted) return;
    // Held during the start-up load: a stale doc queued then would still be
    // PUT after the remote one is adopted (initHosted replays it if needed).
    if (this._cloudLoading) { this._cloudHeld = true; return; }
    this._setSync('saving');
    const payload = JSON.stringify(this.save);
    this.sh.saveJSON({ checksum: hashValue(payload), payload });
  }

  /** Flush the debounced cloud save (pagehide / hidden). */
  flushCloud() { return this.hosted ? this.sh.flushSave(true) : Promise.resolve(false); }

  /**
   * Load the remote save slot; on success the remote doc wins (same checksum +
   * version validation as the local path) and the local cache is rewritten.
   * An empty slot is seeded from the local doc.
   */
  async cloudLoad() {
    if (!this.hosted) return false;
    const info = await this.sh.saveInfo();
    const wrapped = info && info.exists === false ? null : await this.sh.loadJSON();
    if (!wrapped) { this._queueCloudSave(); return false; }
    if (wrapped.checksum !== hashValue(wrapped.payload)) throw new Error('save checksum mismatch');
    this.save = migrate(JSON.parse(wrapped.payload));
    this._writeLocal();
    this._setSync('synced');
    return true;
  }

  /** Apply platform preferences over the local ones (type-checked); true when changed. */
  applyRemoteSettings(remote) {
    let changed = false;
    for (const k of SYNCED_SETTINGS) {
      const v = remote?.[k];
      if (v == null) continue;
      const ok = k === 'graphics' ? typeof v === 'object' && !Array.isArray(v) : typeof v === typeof DEFAULT_SETTINGS[k];
      if (ok && JSON.stringify(v) !== JSON.stringify(this.save.settings[k])) { this.save.settings[k] = v; changed = true; }
    }
    if (changed) this._writeLocal();
    this._lastSettings = JSON.stringify(this._settingsSubset());
    return changed;
  }

  _settingsSubset() {
    const out = {};
    for (const k of SYNCED_SETTINGS) out[k] = this.save.settings[k];
    return out;
  }

  _syncSettings() {
    if (!this.hosted || this._lastSettings === null) return;
    const subset = this._settingsSubset();
    const json = JSON.stringify(subset);
    if (json === this._lastSettings) return;
    this._lastSettings = json;
    clearTimeout(this._settingsTimer);
    this._settingsTimer = setTimeout(() => this.sh.patchSettings(subset), 400);
  }

  /** Boot handshake for hosted mode: profile, remote save doc, settings, bindings. */
  async initHosted() {
    if (!this.hosted) return false;
    let remote = false;
    this._cloudLoading = true;
    try { await this.fetchProfile(); } catch { /* nickname falls back to Player id */ }
    try { remote = await this.cloudLoad(); } catch { /* local doc stays authoritative */ }
    this._cloudLoading = false;
    // A save held during the load is pushed now, unless the remote doc replaced it.
    if (this._cloudHeld) { this._cloudHeld = false; if (!remote) this._queueCloudSave(); }
    try { if (this.applyRemoteSettings(await this.sh.getSettings())) remote = true; } catch { /* local prefs */ }
    try { this.keyBindings = await this.sh.loadBindings(DEFAULT_KEYS); } catch { /* defaults */ }
    return remote;
  }

  // --- keyboard bindings ---------------------------------------------------------

  /** Effective bindings { action: codes[] }: platform when hosted, else local remaps. */
  keyMap() {
    if (this.hosted && this.keyBindings) return { ...DEFAULT_KEYS, ...this.keyBindings };
    const local = this.save.settings.keys ?? {};
    const out = {};
    for (const a of Object.keys(DEFAULT_KEYS)) out[a] = local[a] ? [local[a]] : DEFAULT_KEYS[a].slice();
    return out;
  }

  /** Remap one action (press-to-bind): platform controls when hosted, local save otherwise. */
  setKey(action, code) {
    if (this.hosted) {
      this.keyBindings = { ...this.keyMap(), [action]: [code] };
      this.sh.setControl(action, [code]).catch(() => {});
    }
    this.updateSettings({ keys: { ...this.save.settings.keys, [action]: code } });
  }

  /** Restore default bindings everywhere. */
  resetKeys() {
    if (this.hosted) { this.keyBindings = null; this.sh.resetControls(); }
    const keys = {};
    for (const [a, codes] of Object.entries(DEFAULT_KEYS)) keys[a] = codes[0];
    this.updateSettings({ keys });
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

  _writeLocal() {
    try {
      const payload = JSON.stringify(this.save);
      localStorage.setItem(SAVE_KEY, JSON.stringify({ checksum: hashValue(payload), payload }));
    } catch (e) { /* storage may be unavailable; session continues unsaved */ }
  }

  persist() {
    this._writeLocal();
    this._queueCloudSave();   // cloud is a mirror; localStorage stays the cache
    this._syncSettings();     // changed preferences → settings KV
  }

  get settings() { return this.save.settings; }

  updateSettings(patch) {
    Object.assign(this.save.settings, patch);
    this.persist();
    this.track('settings_change', { keys: Object.keys(patch).sort().join(',') });
  }

  // --- clock ---------------------------------------------------------------

  now() { return new Date(); }

  /** Seconds until the next UTC daily boundary. */
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
    if (!['journey', 'daily', 'challenge'].includes(board)) return null;
    // Mastery uses stars * 1000 - elapsed seconds; match boards use goal margin.
    const minScore = board === 'journey' ? -1800 : -99;
    const maxScore = board === 'journey' ? 3000 : 99;
    if (!Number.isInteger(entry.score) || entry.score < minScore || entry.score > maxScore) return null;
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

  /** Post a finished match score to the platform leaderboards (score-script.js);
   *  resolves { posted, rank } — rank on the high-score board, or null. */
  async submitScore(score) {
    const sh = this.sh;
    if (!this.hosted || typeof sh.submitScores !== 'function') return { posted: false, rank: null };
    const keys = await sh.submitScores({ 'high-score': score }).catch(() => []);
    if (!keys || !keys.includes('high-score')) return { posted: false, rank: null };
    try {
      const r = await sh.leaderboard('high-score', { pageSize: 100 });
      const me = (r?.items ?? []).find(i => i.userId === sh.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
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
}

// Pre-graphics-panel saves stored a single quality tier.
const LEGACY_QUALITY = { low: 'low', medium: 'balanced', high: 'high' };
function migrateGraphics(settings) {
  if (!settings.graphics || typeof settings.graphics !== 'object') {
    settings.graphics = { ...DEFAULT_SETTINGS.graphics, preset: LEGACY_QUALITY[settings.quality] ?? 'auto' };
  }
  delete settings.quality;
  return settings;
}

function migrate(save) {
  // Versioned migration path; unknown versions fall back to defaults + salvage.
  if (!save || typeof save !== 'object') return defaultSave();
  if (save.version === SAVE_VERSION) return { ...defaultSave(), ...save, settings: migrateGraphics({ ...DEFAULT_SETTINGS, graphics: undefined, ...save.settings }) };
  const fresh = defaultSave();
  fresh.settings = migrateGraphics({ ...fresh.settings, graphics: undefined, ...(save.settings ?? {}) });
  fresh.progression = { ...fresh.progression, ...(save.progression ?? {}) };
  fresh.version = SAVE_VERSION;
  return fresh;
}
