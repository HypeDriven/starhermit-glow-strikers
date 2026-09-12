// Hosted-play clients. Two transports, one surface:
//
// - HostedClient: the repo's own dev server (server.js) — JSON control frames
//   (lifecycle only) and compact binary gameplay frames (inputs out, snapshots
//   in) over /ws. Reconnects with the seat token and produces a "while you
//   were away" summary from the server's resume payload. Local dev only.
//
// - RoomsClient: StarHermit realtime rooms (host-routed). The lobby is REST
//   (create / quick-join / open / result / leave / mine); the transport is
//   ws(s)://<host>/ws/v1/realtime?roomId=&access_token= with binary frames.
//   The platform prefixes every routed binary frame with a 16-byte sender
//   participant id (stripped here); guest frames reach the host only, host
//   frames reach everyone. 8 KB/frame cap. The game's EXISTING frames ride
//   the channel unchanged: guests send their 13-byte input frames, the host
//   runs the same authoritative rules engine as server.js (browser-side) and
//   broadcasts its 32-byte snapshots; chat/ready/start/result/resumed are
//   JSON text control frames (guests: ready/chat only, <=4 KB).

import * as rules from './rules.js';
import { createAI } from './ai.js';

const PHASE_NAMES = ['countdown', 'active', 'goalPause', 'terminal'];
const SENDER_PREFIX = 16;         // bytes, platform participant id prefix
const MAX_BINARY_FRAME = 8192;    // 8 KB cap per frame
const MAX_TEXT_FRAME = 4096;      // JSON control frames stay <=4 KB
const GUEST_INPUT_INTERVAL = 40;  // <=30 msg/s
const TICK_MS = 1000 / 60;
const SNAPSHOT_EVERY = 3;         // 20 Hz snapshots
const PEER_GRACE_MS = 30 * 1000;  // guest silence before forfeit (like server.js)

/** Decode the shared 32-byte snapshot frame (see server.js encodeSnapshot). */
function decodeSnapshot(buf) {
  const v = new DataView(buf);
  if (v.byteLength !== 32 || v.getUint8(0) !== 2) return null;
  return {
    tick: v.getUint32(1, true),
    puck: { x: v.getFloat32(5, true), y: v.getFloat32(9, true) },
    mallets: [
      { x: v.getFloat32(13, true), y: v.getFloat32(17, true) },
      { x: v.getFloat32(21, true), y: v.getFloat32(25, true) },
    ],
    scores: [v.getUint8(29), v.getUint8(30)],
    phase: PHASE_NAMES[v.getUint8(31)],
  };
}

function encodeSnapshot(s) {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setUint8(0, 2);
  v.setUint32(1, s.tick >>> 0, true);
  v.setFloat32(5, s.puck.x, true); v.setFloat32(9, s.puck.y, true);
  v.setFloat32(13, s.mallets[0].x, true); v.setFloat32(17, s.mallets[0].y, true);
  v.setFloat32(21, s.mallets[1].x, true); v.setFloat32(25, s.mallets[1].y, true);
  v.setUint8(29, s.scores[0] & 0xff);
  v.setUint8(30, s.scores[1] & 0xff);
  v.setUint8(31, Math.max(0, PHASE_NAMES.indexOf(s.phase)));
  return buf;
}

/** 13-byte guest input frame: [u8 1][u32 tick][f32 x][f32 y]. */
function encodeInput(seq, x, y) {
  const buf = new ArrayBuffer(13);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint32(1, seq >>> 0, true);
  v.setFloat32(5, x, true);
  v.setFloat32(9, y, true);
  return buf;
}

function parseInput(buf) {
  const v = new DataView(buf);
  if (v.byteLength !== 13 || v.getUint8(0) !== 1) return null;
  const x = v.getFloat32(5, true), y = v.getFloat32(9, true);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < -50 || x > rules.TABLE_W + 50 || y < -50 || y > rules.TABLE_H + 50) return null;
  return { x, y };
}

export class HostedClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.room = null;
    this.seat = -1;
    this.token = null;
    this.name = 'Player';
    this.prevSnap = null;
    this.snap = null;
    this.snapAt = 0;
    this.prevSnapAt = 0;
    this.handlers = {};        // op -> fn(msg)
    this.onSnapshot = null;    // fn(snap, prevSnap, alphaInfo)
    this.onChat = null;
    this._reconnects = 0;
    this._awaySummary = null;
    this._sendTick = 0;
  }

  on(op, fn) { this.handlers[op] = fn; return this; }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return Promise.resolve();
    // No static-host refusal here: offline play simply falls through to the
    // lobby's honest "no host server" state when the socket cannot open.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      const fail = () => reject(new Error('connect-failed'));
      ws.onerror = fail;
      ws.onclose = () => {
        this.connected = false;
        if (this.room) this._scheduleReconnect();
      };
      ws.onopen = () => {
        this.connected = true;
        this._reconnects = 0;
        this.ws = ws;
        // hello doubles as resume when we hold a seat token.
        this.send({ op: 'hello', name: this.name, room: this.room, token: this.token });
        resolve();
      };
      ws.onmessage = (e) => this._onMessage(e);
    });
  }

  _scheduleReconnect() {
    if (this._reconnects >= 5) return this.handlers['disconnected']?.();
    const delay = Math.min(8000, 500 * 2 ** this._reconnects++);
    this.handlers['reconnecting']?.({ attempt: this._reconnects, delay });
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  createRoom() { this.send({ op: 'create' }); }
  joinRoom(code) { this.send({ op: 'join', room: code }); }
  startVsAI() { this.send({ op: 'start-vs-ai' }); }
  leave() {
    this.send({ op: 'leave' });
    this.room = null; this.seat = -1; this.token = null;
    this.snap = this.prevSnap = null;
    this.ws?.close();
  }
  sendChat(text) { this.send({ op: 'chat', text }); }

  /** Compact binary input frame: [u8 1][u32 tick][f32 x][f32 y]. */
  sendInput(x, y) {
    if (this.ws?.readyState !== 1) return;
    const buf = new ArrayBuffer(13);
    const v = new DataView(buf);
    v.setUint8(0, 1);
    v.setUint32(1, ++this._sendTick, true);
    v.setFloat32(5, x, true);
    v.setFloat32(9, y, true);
    this.ws.send(buf);
  }

  _onMessage(e) {
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.op) {
        case 'created': case 'joined':
          this.room = msg.room; this.seat = msg.seat; this.token = msg.token;
          break;
        case 'resumed':
          this.room = msg.room; this.seat = msg.seat;
          this._awaySummary = msg.missed
            ? `While you were away: score ${msg.missed.scores[0]}–${msg.missed.scores[1]}, tick ${msg.missed.tick}.`
            : null;
          break;
        case 'chat':
          this.onChat?.(msg);
          break;
      }
      this.handlers[msg.op]?.(msg);
      return;
    }
    // Binary snapshot frame.
    const snap = decodeSnapshot(e.data);
    if (!snap) return;
    this.prevSnap = this.snap;
    this.prevSnapAt = this.snapAt;
    this.snap = snap;
    this.snapAt = performance.now();
    this.onSnapshot?.(this.snap, this.prevSnap, this.snapshotInterval());
  }

  /** Interpolation interval derived from observed snapshot cadence. */
  snapshotInterval() {
    const d = this.snapAt - this.prevSnapAt;
    return d > 10 && d < 500 ? d : 50;
  }

  takeAwaySummary() {
    const s = this._awaySummary;
    this._awaySummary = null;
    return s;
  }
}

// ---------------------------------------------------------------------------
// RoomsClient — StarHermit realtime rooms (host-routed). Same surface as
// HostedClient so js/main.js wiring is unchanged.
// ---------------------------------------------------------------------------

export class RoomsClient {
  constructor(platform) {
    this.platform = platform;     // provides token, gameSlug, api(), displayName
    this.ws = null;
    this.connected = false;
    this.room = null;             // platform room id
    this.seat = -1;               // 0 = host, 1 = guest
    this.isHost = false;
    this.name = 'Player';
    this.prevSnap = null;
    this.snap = null;
    this.snapAt = 0;
    this.prevSnapAt = 0;
    this.handlers = {};           // op -> fn(msg)
    this.onSnapshot = null;       // fn(snap, prevSnap, alphaInfo)
    this.onChat = null;
    this._reconnects = 0;
    this._awaySummary = null;
    this._sendTick = 0;
    this._lastInputAt = 0;
    this._guestSender = null;     // participant id prefix of the current guest
    this._guestName = 'Opponent';
    this.hostSim = null;          // host-side authoritative simulation
  }

  get token() { return this.platform.token; }

  on(op, fn) { this.handlers[op] = fn; return this; }

  _api(path, opts = {}) { return this.platform.api(path, opts); }

  // --- lobby (REST) -----------------------------------------------------------

  /** Host: create a 1v1 room and open it for quick-join. */
  async createRoom() {
    const res = await this._api('/api/v1/realtime/rooms', {
      method: 'POST',
      body: JSON.stringify({
        teamCount: 1,
        seatsPerTeam: 2,
        metadata: { gameSlug: this.platform.gameSlug, mode: '1v1' },
      }),
    });
    if (!res.ok) throw new Error('rooms-unavailable');
    const room = await res.json();
    this.room = room?.id ?? room?.roomId ?? null;
    if (!this.room) throw new Error('rooms-unavailable');
    this.isHost = true;
    this.seat = 0;
    await this._api(`/api/v1/realtime/rooms/${encodeURIComponent(this.room)}/open`, { method: 'POST' })
      .catch(() => { /* open is best-effort; quick-join may still work */ });
    await this._connectWs();
    this.handlers['created']?.({ room: this.room, seat: 0 });
  }

  /** Guest: quick-join any open table for this game (404 = none open). */
  async quickJoin() {
    const res = await this._api('/api/v1/realtime/rooms/quick-join', {
      method: 'POST',
      body: JSON.stringify({ gameSlug: this.platform.gameSlug, seats: 1 }),
    });
    if (res.status === 404) {
      this.handlers['error']?.({ error: 'no-open-tables' });
      return false;
    }
    if (!res.ok) throw new Error('rooms-unavailable');
    const room = await res.json();
    this.room = room?.roomId ?? room?.id ?? room?.room?.id ?? null;
    if (!this.room) throw new Error('rooms-unavailable');
    this.isHost = false;
    this.seat = 1;
    await this._connectWs();
    this.handlers['joined']?.({ room: this.room, seat: 1 });
    return true;
  }

  /** Friends list for invites (lobby may offer these later). */
  async friends() {
    try {
      const res = await this._api('/api/v1/me/friends');
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : (data?.friends ?? []);
    } catch {
      return [];
    }
  }

  // --- transport ----------------------------------------------------------------

  _wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/v1/realtime?roomId=${encodeURIComponent(this.room)}&access_token=${encodeURIComponent(this.token)}`;
  }

  _connectWs() {
    if (this.ws && this.ws.readyState <= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl());
      ws.binaryType = 'arraybuffer';
      const fail = () => reject(new Error('connect-failed'));
      ws.onerror = fail;
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        if (was && this.room) this._scheduleReconnect();
      };
      ws.onopen = () => {
        this.connected = true;
        this._reconnects = 0;
        this.ws = ws;
        if (!this.isHost) this._sendControl({ op: 'ready' }); // guests: ready/chat only
        resolve();
      };
      ws.onmessage = (e) => this._onMessage(e);
    });
  }

  _scheduleReconnect() {
    if (this._reconnects >= 5) return this.handlers['disconnected']?.();
    const delay = Math.min(8000, 500 * 2 ** this._reconnects++);
    this.handlers['reconnecting']?.({ attempt: this._reconnects, delay });
    setTimeout(() => {
      this._api('/api/v1/realtime/rooms/mine')
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const m = await res.json();
          const rid = m?.roomId ?? m?.id ?? m?.room?.id ?? null;
          if (!rid) throw new Error('not-in-room');
          this.room = rid;
          await this._connectWs();
          if (!this.isHost && this.snap) {
            this.handlers['resumed']?.({ room: this.room, seat: this.seat });
          }
        })
        .catch(() => this._scheduleReconnect());
    }, delay);
  }

  _sendControl(obj) {
    const text = JSON.stringify(obj);
    if (text.length > MAX_TEXT_FRAME) return;
    if (this.ws?.readyState === 1) this.ws.send(text);
  }

  _sendBinary(buf) {
    if (buf.byteLength > MAX_BINARY_FRAME) return;   // 8 KB cap
    if (this.ws?.readyState === 1) this.ws.send(buf);
  }

  leave() {
    const room = this.room;
    this.hostSim = null;
    this.snap = this.prevSnap = null;
    this.room = null;
    this.seat = -1;
    this.isHost = false;
    this._guestSender = null;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    if (room) {
      this._api(`/api/v1/realtime/rooms/${encodeURIComponent(room)}/leave`, { method: 'POST' })
        .catch(() => { /* seat is released by the room TTL anyway */ });
    }
  }

  // --- gameplay -----------------------------------------------------------------

  /** Host: begin the authoritative match (empty seat runs the server AI). */
  startVsAI() { this._beginMatch(true); }

  _beginMatch(withAI) {
    if (!this.isHost || this.hostSim) return;
    const seed = (Math.random() * 2 ** 31) >>> 0;
    this.hostSim = {
      seed,
      withAI,
      state: rules.createMatch({ seed, targetScore: 5, timeLimitSeconds: 180 }),
      ai: withAI ? createAI({ skill: 0.55, player: 1, seed }) : null,
      inputs: [null, null],
      ticks: 0,
      acc: 0,
      lastInputAt: Date.now(),
      lastSnapshot: null,
      forfeited: false,
      finished: false,
    };
    this._guestSender = null;
    this._sendControl({ op: 'start', seed, withAI });
    this.handlers['start']?.({ seed, withAI });
  }

  /**
   * Host: advance the authoritative simulation. Called from the main loop
   * with the elapsed frame time in ms; broadcasts 32-byte snapshots at 20 Hz
   * through the same local decode path the guests use.
   */
  stepHost(dtMs) {
    const sim = this.hostSim;
    if (!sim || sim.finished) return;
    sim.acc += dtMs;
    let guard = 0;
    while (sim.acc >= TICK_MS && guard++ < 8) {
      sim.acc -= TICK_MS;
      const s = sim.state;
      for (let i = 0; i < 2; i++) {
        if (sim.inputs[i]) {
          rules.applyCommand(s, rules.makeCommand(i, 'move', sim.inputs[i], `r${this.room}-t${s.tick}-p${i}`));
          sim.inputs[i] = null;
        }
      }
      if (sim.ai) {
        const t = sim.ai.update(s);
        if (t) rules.applyCommand(s, rules.makeCommand(1, 'move', t, `r${this.room}-ai-${s.tick}`));
      }
      rules.step(s);
      if (++sim.ticks % SNAPSHOT_EVERY === 0) {
        const frame = encodeSnapshot(s);
        sim.lastSnapshot = frame;
        this._sendBinary(frame);           // host -> everyone
        this._onSnapshotPayload(frame);    // host renders through the same path
      }
      // Guest liveness: mirror server.js's 30 s seat grace with a forfeit.
      if (!sim.withAI && !sim.forfeited && s.phase === rules.PHASE.ACTIVE
          && Date.now() - sim.lastInputAt > PEER_GRACE_MS) {
        sim.forfeited = true;
        rules.applyCommand(s, rules.makeCommand(1, 'forfeit', {}, 'forfeit-1'));
        this.handlers['peer-abandoned']?.({ seat: 1 });
      }
      if (s.phase === rules.PHASE.TERMINAL) {
        this._finishMatch();
        break;
      }
    }
  }

  _finishMatch() {
    const sim = this.hostSim;
    if (!sim || sim.finished) return;
    sim.finished = true;
    const s = sim.state;
    const result = {
      breakdown: rules.resultBreakdown(s),
      finalHash: rules.hash(s),
      durationTicks: s.activeTicks,
      seed: sim.seed,
    };
    this._sendControl({ op: 'result', result });
    if (this.room) {
      this._api(`/api/v1/realtime/rooms/${encodeURIComponent(this.room)}/result`, {
        method: 'POST',
        body: JSON.stringify({ result }),
      }).catch(() => { /* result broadcast already delivered the outcome */ });
    }
    this.handlers['result']?.({ result });
  }

  sendChat(text) {
    const clean = String(text ?? '').slice(0, 200).trim();
    if (!clean) return;
    this._sendControl({ op: 'chat', text: clean });
    if (this.isHost) {
      // Host chat is local truth; broadcast with attribution for guests.
      const msg = { from: this.name, seat: 0, text: clean };
      this.handlers['chat']?.(msg);
    }
  }

  /** Compact binary input frame: [u8 1][u32 tick][f32 x][f32 y]. */
  sendInput(x, y) {
    if (this.isHost) {
      if (this.hostSim && Number.isFinite(x) && Number.isFinite(y)) this.hostSim.inputs[0] = { x, y };
      return;
    }
    const now = Date.now();
    if (now - this._lastInputAt < GUEST_INPUT_INTERVAL) return;   // <=30 msg/s
    if (this.ws?.readyState !== 1) return;
    this._lastInputAt = now;
    this.ws.send(encodeInput(++this._sendTick, x, y));
  }

  // --- receive --------------------------------------------------------------------

  _onMessage(e) {
    if (typeof e.data === 'string') return this._onControl(e.data);
    const buf = new Uint8Array(e.data);
    if (buf.byteLength <= SENDER_PREFIX) return;
    const payload = buf.slice(SENDER_PREFIX);        // strip 16-byte sender id
    if (payload.byteLength > MAX_BINARY_FRAME) return;
    if (this.isHost) return this._onGuestBinary(buf.slice(0, SENDER_PREFIX), payload);
    this._onSnapshotPayload(payload.buffer);
  }

  _onSnapshotPayload(buf) {
    const snap = decodeSnapshot(buf);
    if (!snap) return;
    this.prevSnap = this.snap;
    this.prevSnapAt = this.snapAt;
    this.snap = snap;
    this.snapAt = performance.now();
    this.onSnapshot?.(this.snap, this.prevSnap, this.snapshotInterval());
  }

  _onGuestBinary(senderIdBytes, payload) {
    const input = parseInput(payload.buffer);
    if (!input || !this.hostSim) return;
    const sender = Array.from(senderIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    if (this.hostSim.withAI || this.hostSim.finished) {
      // A latecomer cannot be seated in a running (or AI) match.
      if (sender !== this._guestSender) this._sendControl({ op: 'error', error: 'match-in-progress' });
      return;
    }
    if (this._guestSender && sender !== this._guestSender) {
      // A (possibly reconnected) guest replaced the previous sender: resume.
      this._sendResume();
    }
    this._guestSender = sender;
    this.hostSim.lastInputAt = Date.now();
    this.hostSim.inputs[1] = input;
  }

  _sendResume() {
    const sim = this.hostSim;
    if (!sim) return;
    const missed = sim.state ? { scores: [...sim.state.scores], tick: sim.state.tick } : null;
    this._sendControl({ op: 'resumed', room: this.room, seat: 1, missed });
    if (sim.lastSnapshot) this._sendBinary(sim.lastSnapshot);
  }

  _onControl(text) {
    if (text.length > MAX_TEXT_FRAME) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.op === 'string') return this._onOp(msg);
    // Roster/presence pushes (platform shape): drive lobby arrival only.
    const list = msg.participants ?? msg.roster ?? msg.members ?? (Array.isArray(msg) ? msg : null);
    if (Array.isArray(list)) this._onRoster(list);
  }

  _onRoster(list) {
    const others = list.filter(p => p && typeof p === 'object');
    const names = others.map(p => p.nickname ?? p.name ?? p.displayName).filter(Boolean);
    if (this.isHost) {
      const guest = names[0] ?? (others.length ? 'Opponent' : null);
      if (guest) this._guestName = guest;
      if (!this.hostSim) {
        // Lobby: the first arrival fills seat 1 and the match begins.
        if (others.length) {
          this.handlers['peer-joined']?.({ name: this._guestName, seat: 1 });
          this._beginMatch(false);
        }
      } else if (!this.hostSim.withAI && !this.hostSim.finished && !others.length) {
        this.handlers['peer-left']?.({ seat: 1 });
      }
    } else if (!others.length && this.room) {
      this.handlers['peer-left']?.({ seat: 0 }); // host gone
    }
  }

  _onOp(msg) {
    switch (msg.op) {
      case 'ready':
        // Guest (re)announced itself while a match runs: catch it up.
        if (this.isHost && this.hostSim && !this.hostSim.withAI && !this.hostSim.finished) this._sendResume();
        else if (this.isHost && this.hostSim?.withAI) this._sendControl({ op: 'error', error: 'match-in-progress' });
        break;
      case 'chat':
        if (this.isHost) {
          const clean = String(msg.text ?? '').slice(0, 200).trim();
          if (!clean) return;
          const out = { from: this._guestName, seat: 1, text: clean };
          this._sendControl({ op: 'chat', from: out.from, seat: 1, text: clean }); // host -> everyone
          this.handlers['chat']?.(out);
        } else {
          this.onChat?.(msg);
          this.handlers['chat']?.(msg);
        }
        break;
      case 'start':
        this.handlers['start']?.(msg);
        break;
      case 'result':
        this.handlers['result']?.(msg);
        break;
      case 'resumed':
        this._awaySummary = msg.missed
          ? `While you were away: score ${msg.missed.scores[0]}–${msg.missed.scores[1]}, tick ${msg.missed.tick}.`
          : null;
        this.handlers['resumed']?.(msg);
        break;
      case 'error':
        this.handlers['error']?.(msg);
        break;
      default:
        this.handlers[msg.op]?.(msg);
    }
  }

  /** Interpolation interval derived from observed snapshot cadence. */
  snapshotInterval() {
    const d = this.snapAt - this.prevSnapAt;
    return d > 10 && d < 500 ? d : 50;
  }

  takeAwaySummary() {
    const s = this._awaySummary;
    this._awaySummary = null;
    return s;
  }
}
