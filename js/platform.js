// Platform layer: per-game settings, versioned+checksummed local save,
// host time synchronization, achievements, leaderboards, telemetry consent,
// and presence heartbeats. No credentials or tokens are ever persisted.
//
// Hosted mode (StarHermit platform) activates only when a launch token was
// read from the URL: fragment #game_token=<jwt> (read once, then stripped;
// query ?token=/&launch=/&launch_token= remain as local-dev fallbacks). The
// JWT payload (base64url decode, no verify) carries sub (user id) and
// game_scope (this game's slug). The token lives in memory only and is
// re-minted every 45 min via POST /api/v1/games/{slug}/launch-token.

import { hashValue } from './rng.js';
import { ACHIEVEMENTS, CONTENT_VERSION, RULESET_ID } from './content.js';

// --- minimal ZIP writer/reader (stored entries only, no compression) ---------
// Cloud saves travel as ONE zip+base64 slot; saves are small JSON.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// --- launch token --------------------------------------------------------------

/** Read the launch token once, then strip it from the URL. Returns null offline. */
function readLaunchToken() {
  if (typeof location === 'undefined' || typeof history === 'undefined') return null;
  if (location.hash.length > 1) {
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const token = params.get('game_token');
      if (token) {
        params.delete('game_token');
        params.delete('session_id');
        const rest = params.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
        return token;
      }
    } catch { /* malformed fragment; fall through to query */ }
  }
  // Local-dev fallbacks only — the platform always delivers the fragment.
  try {
    const q = new URLSearchParams(location.search);
    const token = q.get('token') ?? q.get('launch') ?? q.get('launch_token');
    if (token) history.replaceState(null, '', location.pathname + location.hash);
    return token;
  } catch {
    return null;
  }
}

/** Decode a JWT payload segment (base64url) without verifying the signature. */
function decodeJwtPayload(token) {
  try {
    const seg = token.split('.')[1];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

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
    // Hosted identity + cloud state (all in-memory; nothing persisted).
    this.token = readLaunchToken();
    this.claims = this.token ? decodeJwtPayload(this.token) : null;
    this.sub = typeof this.claims?.sub === 'string' ? this.claims.sub : null;
    this.gameSlug = typeof this.claims?.game_scope === 'string' ? this.claims.game_scope : null;
    this.nickname = null;              // resolved async from the profile route
    this.syncStatus = 'offline';       // offline | saving | synced
    this.onSync = null;                // fn(status) — sync status display hook
    this._profileCache = new Map();
    this._cloudTimer = null;
    this._refreshTimer = null;
    if (this.token) {
      this._scheduleRefresh(45 * 60 * 1000);
      this._installCloudFlush();
    }
  }

  /** True when a platform launch token is in memory. */
  get hosted() { return !!this.token; }

  /** Display name: profile nickname, else "Player " + id8. Null when anonymous. */
  get displayName() {
    if (this.nickname) return this.nickname;
    return this.sub ? `Player ${this.sub.slice(0, 8)}` : null;
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

  /** Fetch a platform API path with the launch token. Throws when offline. */
  async api(path, opts = {}) {
    if (!this.token) throw new Error('offline');
    const headers = { ...(opts.headers ?? {}) };
    headers.authorization = `Bearer ${this.token}`;
    if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
    return fetch(path, { ...opts, headers });
  }

  _scheduleRefresh(delayMs) {
    if (typeof setTimeout === 'undefined') return;
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refreshToken(), delayMs);
    this._refreshTimer.unref?.();
  }

  /** Re-mint the scoped launch token; failures retry in ~60 s. */
  async refreshToken() {
    if (!this.token || !this.gameSlug) return;
    try {
      const res = await this.api(`/api/v1/games/${encodeURIComponent(this.gameSlug)}/launch-token`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (body && typeof body.token === 'string' && body.token) this.token = body.token;
      this._scheduleRefresh(45 * 60 * 1000);
    } catch {
      this._scheduleRefresh(60 * 1000);
    }
  }

  /**
   * Resolve a user id to a display nickname (cached). Never returns usernames;
   * falls back to "Player " + id8. Anonymous/offline callers get the fallback.
   */
  async profileFor(userId) {
    if (this._profileCache.has(userId)) return this._profileCache.get(userId);
    let rec = null;
    if (this.token) {
      try {
        const res = await this.api(`/api/v1/users/${encodeURIComponent(userId)}/profile`);
        if (res.ok) rec = await res.json();
      } catch { /* offline; fall back below */ }
    }
    const nick = rec && typeof rec.nickname === 'string' && rec.nickname.trim()
      ? rec.nickname.trim()
      : `Player ${String(userId).slice(0, 8)}`;
    this._profileCache.set(userId, nick);
    return nick;
  }

  /** Load the signed-in player's profile into displayName. */
  async fetchProfile() {
    if (!this.sub) return null;
    this.nickname = await this.profileFor(this.sub);
    return this.nickname;
  }

  /** Read-only platform leaderboard (clients can never submit scores). */
  async fetchPlatformLeaderboard({ page = 0, pageSize = 20, friendsOnly = false } = {}) {
    if (!this.token || !this.gameSlug) return null;
    try {
      const g = await this.api(`/api/v1/games/${encodeURIComponent(this.gameSlug)}`);
      if (!g.ok) return null;
      const info = await g.json();
      const leaderboardId = info?.leaderboardId ?? null;
      const base = { me: info?.me ?? null, leaderboardId, entries: [] };
      if (!leaderboardId) return base;
      const qs = `?friendsOnly=${friendsOnly ? 'true' : ''}&page=${page}&pageSize=${pageSize}`;
      const e = await this.api(`/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries${qs}`);
      if (!e.ok) return base;
      const data = await e.json();
      const rows = Array.isArray(data) ? data : (data?.entries ?? []);
      base.entries = [];
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

  // --- cloud save (mirror of the checksummed local doc) ------------------------

  _installCloudFlush() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const flush = () => {
      if (!this._cloudTimer) return;
      clearTimeout(this._cloudTimer);
      this._cloudTimer = null;
      this._pushCloudSave(true);
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  _queueCloudSave() {
    if (!this.token || !this.gameSlug) return;
    this._setSync('saving');
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => {
      this._cloudTimer = null;
      this._pushCloudSave(false);
    }, 2000);
    this._cloudTimer.unref?.();
  }

  async _pushCloudSave(keepalive) {
    if (!this.token || !this.gameSlug) return;
    try {
      const payload = JSON.stringify(this.save);
      const wrapped = JSON.stringify({ checksum: hashValue(payload), payload });
      const zip = zipStore('save.json', new TextEncoder().encode(wrapped));
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameSlug)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: bytesToBase64(zip) }),
        keepalive,
      });
      this._setSync(res.ok ? 'synced' : 'offline');
    } catch {
      this._setSync('offline');
    }
  }

  /**
   * Load the remote save slot; on success the remote doc wins (same checksum +
   * version validation as the local path) and the local cache is rewritten.
   */
  async cloudLoad() {
    if (!this.token || !this.gameSlug) return false;
    const res = await this.api(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameSlug)}`);
    if (res.status === 404) { this._setSync('synced'); return false; }
    if (!res.ok) throw new Error(String(res.status));
    const zipBytes = new Uint8Array(await res.arrayBuffer());
    const wrapped = JSON.parse(new TextDecoder().decode(unzipFirstEntry(zipBytes)));
    if (wrapped.checksum !== hashValue(wrapped.payload)) throw new Error('save checksum mismatch');
    this.save = migrate(JSON.parse(wrapped.payload));
    this._writeLocal();
    this._setSync('synced');
    return true;
  }

  /** Boot handshake for hosted mode: profile first, then the remote save doc. */
  async initHosted() {
    if (!this.hosted) return false;
    let remote = false;
    try { await this.fetchProfile(); } catch { /* nickname falls back to Player id8 */ }
    try { remote = await this.cloudLoad(); } catch { /* local doc stays authoritative */ }
    return remote;
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
      const res = await fetch('/api/v1/time', {
        cache: 'no-store',
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      });
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
  // Local-dev only (the repo's own server.js implements this route). The
  // platform has no per-game presence endpoint reachable by launch tokens.

  startPresence() {
    this.stopPresence();
    if (!this.online || this.hosted) return;
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
