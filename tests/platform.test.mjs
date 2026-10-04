// Unit tests for the StarHermit hosted adapter (js/platform.js) on the real
// SDK and the host-routed realtime-rooms client (js/net.js RoomsClient).
// Browser globals (location/history/fetch/WebSocket/localStorage) are mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Platform, DEFAULT_KEYS } from '../js/platform.js';
import { RoomsClient } from '../js/net.js';
import { createAI } from '../js/ai.js';
import { hashValue } from '../js/rng.js';

// The package is ESM, so the UMD SDK is evaluated with a CommonJS-style module object.
const SDK = (() => { const module = { exports: {} }; new Function('module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(module); return module.exports; })();
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `hdr.${b64url(payload)}.sig`;
const TOK = jwt({ sub: 'user-12345678-abcd', game_scope: 'glow-strikers', exp: Math.floor(Date.now() / 1000) + 3600 });

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => (obj == null ? '' : JSON.stringify(obj)),
  arrayBuffer: async () => (obj instanceof Uint8Array ? obj.buffer.slice(obj.byteOffset, obj.byteOffset + obj.byteLength) : new ArrayBuffer(0)),
});

function mockLocation({ hash = '', search = '', host = 'glow-strikers.starhermit.com', protocol = 'https:' } = {}) {
  const replaceStateCalls = [];
  globalThis.location = { hash, search, host, protocol, hostname: host.split(':')[0], pathname: '/index.html', origin: `${protocol}//${host}`, href: `${protocol}//${host}/index.html${search}${hash}` };
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
    return jsonRes(null, 404);
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

/** Platform over a fresh SDK instance reading the mocked location / fetch. */
function makePlatform() {
  const sh = SDK.create({
    window: { location: globalThis.location, history: globalThis.history },
    fetch: (...a) => globalThis.fetch(...a),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  });
  return new Platform(sh);
}

// In-memory cloud slot keyed by the decoded path segment.
function cloudRoutes(store) {
  return [
    [/\/cloud-saves\/[^/]+\/info$/, (url) => jsonRes({ exists: !!store[decodeURIComponent(url.split('/cloud-saves/')[1].slice(0, -5))] })],
    [/\/cloud-saves\/[^/]+$/, (url, opts) => {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (opts.method === 'PUT') { store[key] = Buffer.from(JSON.parse(opts.body).dataBase64, 'base64'); return jsonRes({}); }
      return store[key] ? { ok: true, status: 200, arrayBuffer: async () => store[key].buffer.slice(store[key].byteOffset, store[key].byteOffset + store[key].byteLength) } : jsonRes(null, 404);
    }],
  ];
}

// ---------------------------------------------------------------------------
// Launch token, identity, cloud save, settings, bindings
// ---------------------------------------------------------------------------

test('launch token is read from the fragment once and stripped', () => {
  const calls = mockLocation({ hash: `#game_token=${TOK}&session_id=abc`, search: '' });
  mockFetch([]);
  const p = makePlatform();
  assert.equal(p.token, TOK);
  assert.equal(p.sub, 'user-12345678-abcd');
  assert.equal(p.gameSlug, 'glow-strikers');     // never hard-coded
  assert.equal(p.hosted, true);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0][2].includes('game_token'), 'token must be stripped from the URL');
  assert.ok(!calls[0][2].includes('session_id'));
});

test('offline: no token, no hosted mode, no display name, no requests', async () => {
  mockLocation({ hash: '', search: '', host: '127.0.0.1:8080', protocol: 'http:' });
  const calls = mockFetch([]);
  mockLocalStorage();
  const p = makePlatform();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn, false);
  assert.equal(p.displayName, null);
  assert.equal(p.accountLine(), '');
  assert.equal(await p.initHosted(), false);
  p.updateSettings({ volumeMusic: 0.1 });
  p.persist();
  await p.flushCloud();
  assert.equal(await p.fetchPlatformLeaderboard(), null);
  assert.equal(p.inviteLink(), null);
  assert.deepEqual(p.keyMap(), DEFAULT_KEYS);
  assert.equal(calls.length, 0);
});

test('sign-in is offered on the platform host without a token', () => {
  mockLocation({ hash: '', search: '' });
  const calls = mockFetch([]);
  const p = makePlatform();
  assert.equal(p.canSignIn, true);
  assert.equal(calls.length, 0);
});

test('profileFor uses the nickname with a Player-id fallback', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([
    ['/api/v1/users/user-12345678-abcd/profile', () => jsonRes({ nickname: 'Neon Ace', username: 'raw_user' })],
    ['/api/v1/users/other-999/profile', () => jsonRes({ username: 'raw_other' })],
  ]);
  const p = makePlatform();
  await p.fetchProfile();
  assert.equal(p.displayName, 'Neon Ace');
  assert.match(p.accountLine(), /Playing as Neon Ace/);
  assert.equal(await p.profileFor('other-999'), 'Player other-');
});

test('cloud save round-trips through the game:<slug> slot; remote wins on load', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockLocalStorage();
  const store = {};
  const calls = mockFetch(cloudRoutes(store));
  const p = makePlatform();
  assert.equal(await p.cloudLoad(), false, 'empty slot');
  assert.equal(p.syncStatus, 'saving', 'empty slot is seeded from the local doc');
  p.save.progression.wins = 7;
  p.persist();
  assert.equal(await p.flushCloud(), true);
  assert.equal(p.syncStatus, 'synced');
  assert.deepEqual(Object.keys(store), ['game:glow-strikers']);
  assert.ok(calls.some(c => c.opts.method === 'PUT' && c.url === '/api/v1/me/cloud-saves/' + encodeURIComponent('game:glow-strikers')));
  const q = makePlatform();
  q.save.progression.wins = 1;
  assert.equal(await q.cloudLoad(), true);
  assert.equal(q.save.progression.wins, 7, 'remote doc wins');
  const local = JSON.parse(localStorage.getItem('glow-strikers.save.v1'));
  assert.equal(local.checksum, hashValue(local.payload), 'local cache rewritten with a valid checksum');
});

test('settings KV: platform values applied at boot, changes patched', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockLocalStorage();
  const calls = mockFetch([
    ...cloudRoutes({}),
    ['/api/v1/games/glow-strikers/settings', (url, opts) => jsonRes(opts.method === 'PATCH' ? {} : { settings: { volumeMusic: 0.2, palette: 'tritanopia', muted: 'nope' } })],
    ['/api/v1/games/glow-strikers/controls', () => jsonRes({ actions: [{ action: 'undo', codes: ['KeyU'] }] })],
  ]);
  const p = makePlatform();
  assert.equal(await p.initHosted(), true);
  assert.equal(p.settings.volumeMusic, 0.2);
  assert.equal(p.settings.palette, 'tritanopia');
  assert.equal(p.settings.muted, false, 'mistyped values ignored');
  assert.deepEqual(p.keyMap().undo, ['KeyU']);
  assert.deepEqual(p.keyMap().hint, ['KeyH']);
  p.updateSettings({ volumeEffects: 0.3 });
  await new Promise(r => setTimeout(r, 450));
  const patch = calls.find(c => c.opts.method === 'PATCH');
  assert.equal(patch.url, '/api/v1/games/glow-strikers/settings');
  assert.equal(JSON.parse(patch.opts.body).settings.volumeEffects, 0.3);
  p.setKey('camera', 'KeyV');
  const put = calls.find(c => c.opts.method === 'PUT' && c.url.endsWith('/controls'));
  assert.deepEqual(JSON.parse(put.opts.body), { bindings: { camera: ['KeyV'] } });
  assert.deepEqual(p.keyMap().camera, ['KeyV']);
});

test('platform leaderboard read resolves nicknames and marks your row', async () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([
    ['/api/v1/games/glow-strikers', () => jsonRes({ leaderboardId: 'lb-1', me: { rank: 2 } })],
    [/\/api\/v1\/leaderboards\/lb-1\/entries/, () => jsonRes({ entries: [{ userId: 'user-12345678-abcd', score: 9, rank: 1 }] })],
    ['/api/v1/users/user-12345678-abcd/profile', () => jsonRes({ nickname: 'Neon Ace' })],
  ]);
  const p = makePlatform();
  const b = await p.fetchPlatformLeaderboard();
  assert.equal(b.leaderboardId, 'lb-1');
  assert.deepEqual(b.entries[0], { userId: 'user-12345678-abcd', name: 'Neon Ace', score: 9, rank: 1, you: true });
});

test('renewal refused signs out to local play', () => {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([]);
  const p = makePlatform();
  let out = 0;
  p.onSignedOut = () => { out++; };
  p.sh.signOut('expired');
  assert.equal(p.hosted, false);
  assert.equal(out, 1);
  assert.equal(p.inviteLink(), null);
});

// ---------------------------------------------------------------------------
// RoomsClient — lobby REST + transport
// ---------------------------------------------------------------------------

function hostedPlatform() {
  mockLocation({ hash: `#game_token=${TOK}` });
  mockFetch([]);
  return makePlatform();
}

test('room invites: friends listed, invite sent, invite accepted joins the guest seat', async () => {
  const p = hostedPlatform();
  freshSocketMock();
  const calls = mockFetch([
    ['/api/v1/me/friends', () => jsonRes([{ userId: 'f-1', username: 'raw', online: true }])],
    ['/api/v1/realtime/rooms', () => jsonRes({ id: 'room-1' })],
    ['/api/v1/realtime/rooms/room-1/open', () => jsonRes(null, 204)],
    ['/api/v1/realtime/rooms/room-1/invites', () => jsonRes({ id: 'inv-1' })],
    ['/api/v1/realtime/rooms/invites', () => jsonRes([{ id: 'inv-9', fromUserId: 'f-1' }])],
    ['/api/v1/realtime/rooms/invites/inv-9/accept', () => jsonRes({ id: 'room-7' })],
  ]);
  const host = new RoomsClient(p);
  await host.createRoom();
  assert.equal((await host.friends())[0].userId, 'f-1');
  await host.inviteFriend('f-1');
  const inv = calls.find(c => c.url === '/api/v1/realtime/rooms/room-1/invites');
  assert.deepEqual(JSON.parse(inv.opts.body), { toUserId: 'f-1' });
  const guest = new RoomsClient(p);
  assert.equal((await guest.incomingInvites())[0].id, 'inv-9');
  let joined = null;
  guest.on('joined', (m) => { joined = m; });
  await guest.acceptInvite('inv-9');
  assert.deepEqual(joined, { room: 'room-7', seat: 1 });
  assert.ok(MockWebSocket.last.url.includes('roomId=room-7'));
});

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
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TOK}`);
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

// ---------------------------------------------------------------------------
// Graphics settings migration
// ---------------------------------------------------------------------------

test('legacy quality tier migrates to a graphics preset; graphics round-trips', async () => {
  const { hashValue } = await import('../js/rng.js');
  mockLocation({ hash: '', search: '' });
  mockFetch([]);
  const ls = mockLocalStorage();
  const write = (save) => {
    const payload = JSON.stringify(save);
    ls.setItem('glow-strikers.save.v1', JSON.stringify({ checksum: hashValue(payload), payload }));
  };
  write({ version: 1, settings: { quality: 'medium' } });
  let p = new Platform();
  assert.equal(p.load(), true);
  assert.equal(p.settings.graphics.preset, 'balanced');
  assert.equal('quality' in p.settings, false);

  p.updateSettings({ graphics: { preset: 'ultra', bloom: 'off', render_scale: 1.5 } });
  p = new Platform();
  p.load();
  assert.deepEqual(p.settings.graphics, { preset: 'ultra', bloom: 'off', render_scale: 1.5 });

  write({ version: 1, settings: {} });
  p = new Platform();
  p.load();
  assert.equal(p.settings.graphics.preset, 'auto');
});
