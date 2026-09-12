// Unit tests for the StarHermit hosted adapter (js/platform.js) and the
// host-routed realtime-rooms client (js/net.js RoomsClient). Browser globals
// (location/history/fetch/WebSocket/localStorage) are mocked per test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../js/platform.js';
import { RoomsClient } from '../js/net.js';
import { createAI } from '../js/ai.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `hdr.${b64url(payload)}.sig`;
const TOK = jwt({ sub: 'user-12345678-abcd', game_scope: 'glow-strikers' });
const TOK2 = jwt({ sub: 'user-12345678-abcd', game_scope: 'glow-strikers' });

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  arrayBuffer: async () => (obj instanceof Uint8Array ? obj.buffer.slice(obj.byteOffset, obj.byteOffset + obj.byteLength) : new ArrayBuffer(0)),
});

function mockLocation({ hash = '', search = '', host = 'glow-strikers.starhermit.com', protocol = 'https:' } = {}) {
  const replaceStateCalls = [];
  globalThis.location = { hash, search, host, protocol, hostname: host, pathname: '/index.html' };
  globalThis.history = { replaceState: (...args) => replaceStateCalls.push(args) };
  return replaceStateCalls;
}

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, handler] of routes) {
      const hit = match instanceof RegExp ? match.test(String(url)) : String(url) === match;
      if (hit) return handler(url, opts);
    }
    return jsonRes({}, 404);
  };
  return calls;
}

function mockLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
  return globalThis.localStorage;
}

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
}

// ---------------------------------------------------------------------------
// Launch token
// ---------------------------------------------------------------------------

test('launch token is read from the fragment once and stripped', () => {
  const calls = mockLocation({ hash: `#game_token=${TOK}&session_id=abc`, search: '' });
  mockFetch([]);
  const p = new Platform();
  assert.equal(p.token, TOK);
  assert.equal(p.sub, 'user-12345678-abcd');
  assert.equal(p.gameSlug, 'glow-strikers');     // never hard-coded
  assert.equal(p.hosted, true);
  assert.equal(calls.length, 1);
  const url = calls[0][2];
  assert.ok(!url.includes('game_token'), 'token must be stripped from the URL');
  assert.ok(!url.includes('session_id'));
});

test('query token fallbacks remain for local dev', () => {
  const calls = mockLocation({ hash: '', search: `?token=${TOK}` });
  mockFetch([]);
  const p = new Platform();
  assert.equal(p.token, TOK);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0][2].includes('token'));
});

test('offline: no token, no hosted mode, no display name', () => {
  mockLocation({ hash: '', search: '' });
  const calls = mockFetch([]);
  const p = new Platform();
  assert.equal(p.hosted, false);
  assert.equal(p.displayName, null);
  assert.equal(p.accountLine(), '');
  assert.equal(calls.length, 0, 'zero API calls offline');
});

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

test('refresh re-mints the scoped token via POST launch-token with Bearer', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  const calls = mockFetch([
    [`/api/v1/games/glow-strikers/launch-token`, () => jsonRes({ token: TOK2 })]
  ]);
  const p = new Platform();
  await p.refreshToken();
  assert.equal(p.token, TOK2, 'new token swapped in');
  const call = calls.find(c => c.url.endsWith('/launch-token'));
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.authorization, `Bearer ${TOK}`);
});

test('failed refresh retries in ~60 s', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([[/launch-token$/, () => jsonRes({}, 500)]]);
  const delays = [];
  const origSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); const t = origSet(fn, ms, ...rest); t.unref?.(); return t; };
  try {
    const p = new Platform();   // constructor schedules the 45-min refresh
    await p.refreshToken();
    assert.ok(delays.includes(45 * 60 * 1000), '45-min schedule on boot');
    assert.ok(delays.includes(60 * 1000), '60 s retry after failure');
  } finally {
    globalThis.setTimeout = origSet;
  }
});

// ---------------------------------------------------------------------------
// Profile / nickname
// ---------------------------------------------------------------------------

test('profileFor uses nickname, never username, with Player id8 fallback + cache', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  const calls = mockFetch([
    ['/api/v1/users/u-alice/profile', () => jsonRes({ id: 'u-alice', username: 'alice_x', nickname: 'Alice' })],
    ['/api/v1/users/u-bob/profile', () => jsonRes({ id: 'u-bob', username: 'bob_x' }, 404)],
  ]);
  const p = new Platform();
  assert.equal(await p.profileFor('u-alice'), 'Alice');
  assert.equal(await p.profileFor('u-alice'), 'Alice');   // cached: no second fetch
  assert.equal(calls.filter(c => c.url.includes('u-alice')).length, 1);
  const bob = await p.profileFor('u-bob');
  assert.equal(bob, 'Player u-bob'.slice(0, 14));         // "Player " + id8
  assert.ok(!bob.includes('bob_x'), 'never usernames');
  const own = await p.fetchProfile();
  assert.equal(own, 'Player user-123');                    // own 404 fallback
  assert.equal(p.displayName, 'Player user-123');
  const profCall = calls.find(c => c.url.includes(`/users/${p.sub}/profile`));
  assert.equal(profCall.opts.headers.authorization, `Bearer ${TOK}`);
});

// ---------------------------------------------------------------------------
// Cloud save
// ---------------------------------------------------------------------------

test('cloud save round-trips through the zip slot; remote wins on load', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockLocalStorage();
  let savedBody = null;
  const calls = mockFetch([
    [`/api/v1/me/cloud-saves/glow-strikers`, (url, opts) => {
      if (opts.method === 'PUT') { savedBody = JSON.parse(opts.body); return jsonRes({}, 200); }
      return jsonRes({}, 404);
    }],
  ]);
  const a = new Platform();
  a.save.progression.wins = 7;
  a.save.achievements.first_victory = { unlockedAt: '2026-09-11T00:00:00Z' };
  a.persist();
  assert.equal(a.syncStatus, 'saving', 'persist marks saving');
  await a._pushCloudSave(false);
  assert.equal(a.syncStatus, 'synced');
  const put = calls.find(c => c.opts.method === 'PUT');
  assert.equal(put.opts.headers.authorization, `Bearer ${TOK}`);
  assert.ok(savedBody.dataBase64.length > 0, 'zip+base64 body');

  // A second device loads the slot: remote doc wins, local cache rewritten.
  mockLocation({ hash: `#game_token=${TOK}` });
  const storeB = mockLocalStorage();
  const bytes = new Uint8Array(Buffer.from(savedBody.dataBase64, 'base64'));
  mockFetch([[`/api/v1/me/cloud-saves/glow-strikers`, () => jsonRes(bytes, 200)]]);
  const b = new Platform();
  const remote = await b.cloudLoad();
  assert.equal(remote, true);
  assert.equal(b.save.progression.wins, 7);
  assert.equal(b.hasAchievement('first_victory'), true);
  assert.equal(b.syncStatus, 'synced');
  const local = JSON.parse(storeB.getItem('glow-strikers.save.v1'));
  assert.equal(JSON.parse(local.payload).progression.wins, 7, 'local cache mirrors remote');
});

test('cloud load 404 means no remote save; offline game makes no cloud calls', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockLocalStorage();
  const calls = mockFetch([]);
  const p = new Platform();
  assert.equal(await p.cloudLoad(), false);
  assert.equal(p.syncStatus, 'synced');
  assert.equal(calls.length, 1, 'exactly one GET');

  mockLocation({ hash: '', search: '' });
  const offlineCalls = mockFetch([]);
  const q = new Platform();
  assert.equal(await q.cloudLoad(), false);
  q.persist();
  assert.equal(offlineCalls.length, 0, 'no cloud traffic without a token');
});

// ---------------------------------------------------------------------------
// Read-only platform leaderboard
// ---------------------------------------------------------------------------

test('platform leaderboard read resolves nicknames and marks your row', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([
    ['/api/v1/games/glow-strikers', () => jsonRes({ leaderboardId: 'lb1', me: { best: 47 } })],
    ['/api/v1/leaderboards/lb1/entries?friendsOnly=&page=0&pageSize=20',
      () => jsonRes({ entries: [{ userId: 'u-zoe', score: 47 }, { userId: 'user-12345678-abcd', score: 31 }] })],
    ['/api/v1/users/u-zoe/profile', () => jsonRes({ id: 'u-zoe', username: 'zoe_x', nickname: 'Zoe' })],
  ]);
  const p = new Platform();
  const board = await p.fetchPlatformLeaderboard();
  assert.equal(board.leaderboardId, 'lb1');
  assert.equal(board.entries[0].name, 'Zoe');
  assert.equal(board.entries[0].you, false);
  assert.equal(board.entries[1].you, true, 'own row marked');
  assert.equal(board.entries[1].name, 'Player user-123');
});

test('no leaderboardId yields local-records-only state; offline yields null', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([['/api/v1/games/glow-strikers', () => jsonRes({})]]);
  const p = new Platform();
  const board = await p.fetchPlatformLeaderboard();
  assert.deepEqual(board.entries, []);
  assert.equal(board.leaderboardId, null);

  mockLocation({ hash: '', search: '' });
  mockFetch([]);
  const q = new Platform();
  assert.equal(await q.fetchPlatformLeaderboard(), null);
});

// ---------------------------------------------------------------------------
// Presence is dev-only
// ---------------------------------------------------------------------------

test('presence heartbeat never runs in hosted mode', () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([]);
  const intervals = [];
  const orig = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { intervals.push(ms); return orig(fn, ms); };
  try {
    const p = new Platform();
    p.online = true;
    p.startPresence();
    assert.equal(intervals.length, 0, 'no heartbeat when hosted');
    p.stopPresence();
  } finally {
    globalThis.setInterval = orig;
  }
});

// ---------------------------------------------------------------------------
// RoomsClient — lobby REST + transport
// ---------------------------------------------------------------------------

function hostedPlatform() {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([]);
  return new Platform();
}

function freshSocketMock() {
  MockWebSocket.last = undefined;
  globalThis.WebSocket = MockWebSocket;
}

test('host creates + opens a room and connects with roomId and access_token', async () => {
  const p = hostedPlatform();
  freshSocketMock();
  const calls = mockFetch([
    ['/api/v1/realtime/rooms', () => jsonRes({ id: 'room-1' })],
    ['/api/v1/realtime/rooms/room-1/open', () => jsonRes({}, 204)],
  ]);
  const c = new RoomsClient(p);
  let created = null;
  c.on('created', (m) => { created = m; });
  await c.createRoom();
  assert.equal(c.room, 'room-1');
  assert.equal(c.isHost, true);
  assert.equal(c.seat, 0);
  assert.deepEqual(created, { room: 'room-1', seat: 0 });
  assert.ok(MockWebSocket.last.url.startsWith('wss://glow-strikers.starhermit.com/ws/v1/realtime?'));
  assert.ok(MockWebSocket.last.url.includes('roomId=room-1'));
  assert.ok(MockWebSocket.last.url.includes(`access_token=${encodeURIComponent(TOK)}`));
  assert.equal(calls[0].opts.headers.authorization, `Bearer ${TOK}`);
});

test('quick-join 404 surfaces an honest no-open-tables state, no socket', async () => {
  const p = hostedPlatform();
  freshSocketMock();
  mockFetch([['/api/v1/realtime/rooms/quick-join', () => jsonRes({}, 404)]]);
  const c = new RoomsClient(p);
  let err = null;
  c.on('error', (m) => { err = m; });
  const ok = await c.quickJoin();
  assert.equal(ok, false);
  assert.equal(err.error, 'no-open-tables');
  assert.equal(MockWebSocket.last, undefined, 'no socket constructed');
});

// ---------------------------------------------------------------------------
// RoomsClient — binary frames
// ---------------------------------------------------------------------------

function snapshotFrame(scores = [2, 3], phase = 1) {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setUint8(0, 2);
  v.setUint32(1, 123, true);
  v.setUint8(29, scores[0]);
  v.setUint8(30, scores[1]);
  v.setUint8(31, phase);
  return buf;
}

test('guest strips the 16-byte sender prefix off binary snapshot frames', () => {
  const p = hostedPlatform();
  const c = new RoomsClient(p);
  c.room = 'room-1'; c.seat = 1; c.isHost = false;
  let seen = null;
  c.onSnapshot = (snap) => { seen = snap; };
  const prefixed = new Uint8Array(16 + 32);
  prefixed.set(new Uint8Array(snapshotFrame([4, 5], 3)), 16);
  c._onMessage({ data: prefixed.buffer });
  assert.ok(seen, 'snapshot decoded');
  assert.deepEqual(seen.scores, [4, 5]);
  assert.equal(seen.phase, 'terminal');
});

test('host applies prefixed guest input frames and caps frame sizes', () => {
  const p = hostedPlatform();
  const c = new RoomsClient(p);
  c.room = 'room-1'; c.seat = 0; c.isHost = true;
  c._beginMatch(false);
  assert.equal(c.hostSim.state.targetScore, 5);

  const input = new ArrayBuffer(13);
  const iv = new DataView(input);
  iv.setUint8(0, 1); iv.setUint32(1, 1, true);
  iv.setFloat32(5, 42, true); iv.setFloat32(9, 42, true);
  const prefixed = new Uint8Array(16 + 13);
  prefixed.set(new Uint8Array(input), 16);
  c._onMessage({ data: prefixed.buffer });
  assert.deepEqual(c.hostSim.inputs[1], { x: 42, y: 42 }, 'guest move queued for seat 1');

  // 8 KB binary cap: oversized sends are dropped.
  const ws = { readyState: 1, sent: [], send(d) { this.sent.push(d); } };
  c.ws = ws;
  c._sendBinary(new ArrayBuffer(9000));
  assert.equal(ws.sent.length, 0);
  c._sendBinary(snapshotFrame());
  assert.equal(ws.sent.length, 1, '32-byte snapshot under the cap');

  // 4 KB text cap.
  c._sendControl({ op: 'chat', text: 'x'.repeat(5000) });
  assert.equal(ws.sent.length, 1, 'oversized control frame dropped');
});

// ---------------------------------------------------------------------------
// RoomsClient — host simulation end to end (vs AI, fast time limit path)
// ---------------------------------------------------------------------------

test('host sim broadcasts start, steps, and reports result via REST + frame', () => {
  const p = hostedPlatform();
  freshSocketMock();
  mockFetch([
    ['/api/v1/realtime/rooms', () => jsonRes({ id: 'room-1' })],
    ['/api/v1/realtime/rooms/room-1/open', () => jsonRes({}, 204)],
    ['/api/v1/realtime/rooms/room-1/result', () => jsonRes({}, 204)],
  ]);
  const c = new RoomsClient(p);
  const events = [];
  c.on('start', () => events.push('start'));
  c.on('result', () => events.push('result'));
  return c.createRoom().then(() => {
    c.startVsAI();
    assert.deepEqual(events, ['start']);
    // Drive seat 0 with an AI as well: an idle mallet can stalemate the AI
    // in golden-goal overtime, which is not what this transport test is about.
    const ai0 = createAI({ skill: 0.6, player: 0, seed: c.hostSim.seed });
    let ticks = 0;
    while (!c.hostSim.finished && ticks < 60 * 60 * 6) {
      const t = ai0.update(c.hostSim.state);
      if (t) c.hostSim.inputs[0] = t;
      c.stepHost(1000 / 60);
      ticks++;
    }
    assert.equal(c.hostSim.finished, true, 'match reaches a terminal state');
    assert.deepEqual(events, ['start', 'result']);
    const ws = MockWebSocket.last;
    const texts = ws.sent.filter(d => typeof d === 'string').map(JSON.parse);
    assert.ok(texts.some(m => m.op === 'start' && m.withAI === true));
    assert.ok(texts.some(m => m.op === 'result' && m.result.finalHash));
    const bins = ws.sent.filter(d => d instanceof ArrayBuffer);
    assert.ok(bins.length > 0 && bins.every(b => b.byteLength <= 8192));
    assert.equal(c.hostSim.state.phase, 'terminal');
    assert.ok(c.snap && c.snap.tick > 0, 'host renders through its own snapshot path');
  });
});
