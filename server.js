// Glow Strikers authoritative server (zero-dependency Node).
//   node server.js [port]
//
// Serves the static distribution, GET /api/v1/time for clock sync, and runs
// hosted rooms over a minimal RFC 6455 WebSocket implementation. Rooms run the
// same pure rules engine as the client; the server owns the simulation, so
// client clocks, scores and physics claims are never trusted.
//
// Frame protocol on /ws:
//   JSON control frames: lifecycle only (hello/create/join/leave/chat/result…).
//   Binary gameplay frames (little-endian):
//     client -> server  [u8 type=1][u32 tick][f32 x][f32 y]        (mallet target)
//     server -> client  [u8 type=2][u32 tick][f32 puck x,y]
//                       [f32 m0 x,y][f32 m1 x,y][u8 s0][u8 s1][u8 phase][u8 winner]

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rules from './js/rules.js';
import { createAI } from './js/ai.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8000);
const TICK_MS = 1000 / 60;
const SNAPSHOT_EVERY = 3;         // 20 Hz snapshots
const MAX_MESSAGE = 4096;
const ROOM_TTL_MS = 30 * 60 * 1000;
const SEAT_GRACE_MS = 30 * 1000;  // reconnect window

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// HTTP: static distribution + tiny API
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1/time') {
    return json(res, { now: Date.now() });
  }
  if (url.pathname === '/api/v1/presence' && req.method === 'POST') {
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/v1/rooms') {
    return json(res, { openRooms: [...rooms.values()].filter(r => r.seats.some(s => !s)).map(r => r.code) });
  }

  // Static files, confined to ROOT; index.html as default.
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}.git`)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
});

function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket layer (text + binary, ping/pong, close)
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const client = {
    socket, id: crypto.randomBytes(6).toString('hex'),
    room: null, seat: -1, name: 'Player', alive: true,
    buffer: Buffer.alloc(0), rate: { count: 0, resetAt: Date.now() + 1000 },
    chatTimes: [],
  };
  socket.on('data', (d) => {
    client.buffer = Buffer.concat([client.buffer, d]);
    if (client.buffer.length > 1 << 20) return closeClient(client); // flood guard
    let frame;
    while ((frame = readFrame(client))) handleFrame(client, frame);
  });
  socket.on('close', () => onDisconnect(client));
  socket.on('error', () => onDisconnect(client));
  onConnect(client);
});

function readFrame(client) {
  const b = client.buffer;
  if (b.length < 2) return null;
  const fin = (b[0] & 0x80) !== 0;
  const op = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const maskOff = off;
  if (masked) off += 4;
  if (b.length < off + len) return null;
  let payload = b.subarray(off, off + len);
  if (masked) {
    const mask = b.subarray(maskOff, maskOff + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  client.buffer = b.subarray(off + len);
  return { fin, op, payload };
}

function sendFrame(client, op, payload) {
  if (!client.alive) return;
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | op, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { client.socket.write(Buffer.concat([header, payload])); } catch { onDisconnect(client); }
}

function sendJSON(client, obj) { sendFrame(client, 1, Buffer.from(JSON.stringify(obj))); }
function sendBinary(client, buf) { sendFrame(client, 2, buf); }

// ---------------------------------------------------------------------------
// Rooms: lobby, seating, authoritative simulation, reconnect, chat
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room

function roomCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += abc[crypto.randomInt(abc.length)];
  return code;
}

function createRoom(host) {
  const code = roomCode();
  const room = {
    code, createdAt: Date.now(), seats: [null, null], tokens: [null, null],
    state: null, ai: null, loop: null, inputs: [null, null],
    started: false, result: null, lastSnapshot: null,
  };
  rooms.set(code, room);
  seatPlayer(room, host, 0);
  return room;
}

function seatPlayer(room, client, seat) {
  room.seats[seat] = client;
  room.tokens[seat] = client.id;
  client.room = room;
  client.seat = seat;
}

function startMatch(room, withAI = false) {
  const seed = crypto.randomInt(2 ** 31);
  room.state = rules.createMatch({ seed, targetScore: 5, timeLimitSeconds: 180 });
  room.started = true;
  room.ai = withAI ? createAI({ skill: 0.55, player: 1, seed }) : null;
  room.inputs = [null, null];
  broadcast(room, { op: 'start', seed, withAI });
  let ticks = 0;
  room.loop = setInterval(() => {
    if (!room.state) return;
    const s = room.state;
    // Apply the latest queued inputs as validated commands (idempotent per tick).
    for (let i = 0; i < 2; i++) {
      if (room.inputs[i]) {
        rules.applyCommand(s, rules.makeCommand(i, 'move', room.inputs[i], `r${room.code}-t${s.tick}-p${i}`));
        room.inputs[i] = null;
      }
    }
    if (room.ai) {
      const t = room.ai.update(s);
      if (t) rules.applyCommand(s, rules.makeCommand(1, 'move', t, `r${room.code}-ai-${s.tick}`));
    }
    rules.step(s);
    if (++ticks % SNAPSHOT_EVERY === 0) {
      room.lastSnapshot = encodeSnapshot(s);
      broadcastBinary(room, room.lastSnapshot);
    }
    if (s.phase === rules.PHASE.TERMINAL) {
      clearInterval(room.loop);
      room.loop = null;
      room.result = {
        breakdown: rules.resultBreakdown(s),
        finalHash: rules.hash(s),
        durationTicks: s.activeTicks,
        seed,
      };
      broadcast(room, { op: 'result', result: room.result }); // server-authoritative result
    }
  }, TICK_MS);
}

function encodeSnapshot(s) {
  const buf = Buffer.alloc(31);
  buf.writeUInt8(2, 0);
  buf.writeUInt32LE(s.tick >>> 0, 1);
  buf.writeFloatLE(s.puck.x, 5); buf.writeFloatLE(s.puck.y, 9);
  buf.writeFloatLE(s.mallets[0].x, 13); buf.writeFloatLE(s.mallets[0].y, 17);
  buf.writeFloatLE(s.mallets[1].x, 21); buf.writeFloatLE(s.mallets[1].y, 25);
  buf.writeUInt8(s.scores[0] & 0xff, 29);
  buf.writeUInt8((s.scores[1] & 0x0f) | (phaseCode(s.phase) << 4), 30);
  return buf;
}

const PHASE_CODES = { countdown: 0, active: 1, goalPause: 2, terminal: 3 };
function phaseCode(p) { return PHASE_CODES[p] ?? 0; }

function broadcast(room, obj) {
  for (const c of room.seats) if (c?.alive) sendJSON(c, obj);
}
function broadcastBinary(room, buf) {
  for (const c of room.seats) if (c?.alive) sendBinary(c, buf);
}

// ---------------------------------------------------------------------------
// Connection lifecycle + message validation
// ---------------------------------------------------------------------------

function onConnect(client) {
  sendJSON(client, { op: 'welcome', id: client.id, now: Date.now() });
}

function onDisconnect(client) {
  if (!client.alive) return;
  client.alive = false;
  const room = client.room;
  if (room && room.seats[client.seat] === client) {
    room.seats[client.seat] = null; // seat reserved by token for SEAT_GRACE_MS
    broadcast(room, { op: 'peer-left', seat: client.seat, graceSeconds: SEAT_GRACE_MS / 1000 });
    setTimeout(() => {
      if (room.seats[client.seat] === null && rooms.has(room.code)) {
        if (room.started && !room.result && room.state) {
          rules.applyCommand(room.state, rules.makeCommand(client.seat, 'forfeit', {}, `forfeit-${client.seat}`));
        }
        if (!room.seats.some(Boolean)) destroyRoom(room);
        else broadcast(room, { op: 'peer-abandoned', seat: client.seat });
      }
    }, SEAT_GRACE_MS);
  }
}

function destroyRoom(room) {
  clearInterval(room.loop);
  rooms.delete(room.code);
}

function closeClient(client) {
  try { client.socket.end(); } catch {}
  onDisconnect(client);
}

function handleFrame(client, frame) {
  const { op, payload } = frame;
  if (op === 8) return closeClient(client);          // close
  if (op === 9) return sendFrame(client, 10, payload); // ping -> pong
  if (op === 10) return;                               // pong

  // Rate limit: 120 frames/second per client.
  const now = Date.now();
  if (now > client.rate.resetAt) { client.rate.count = 0; client.rate.resetAt = now + 1000; }
  if (++client.rate.count > 120) return;

  if (op === 2) return handleBinary(client, payload);
  if (op !== 1 || payload.length > MAX_MESSAGE) return;

  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
  if (!msg || typeof msg.op !== 'string') return;

  switch (msg.op) {
    case 'hello':
      if (typeof msg.name === 'string') client.name = msg.name.slice(0, 24);
      // Reconnect: a valid seat token resumes the seat with a fresh snapshot.
      if (typeof msg.room === 'string' && typeof msg.token === 'string') {
        const room = rooms.get(msg.room.toUpperCase());
        const seat = room?.tokens.indexOf(msg.token) ?? -1;
        if (room && seat >= 0 && room.seats[seat] === null) {
          seatPlayer(room, client, seat);
          const missed = room.state ? { scores: [...room.state.scores], tick: room.state.tick } : null;
          sendJSON(client, { op: 'resumed', room: room.code, seat, missed, result: room.result });
          broadcast(room, { op: 'peer-joined', seat, name: client.name });
          if (room.lastSnapshot) sendBinary(client, room.lastSnapshot);
          return;
        }
      }
      sendJSON(client, { op: 'ready', name: client.name });
      return;

    case 'create': {
      leaveCurrentRoom(client);
      const room = createRoom(client);
      sendJSON(client, { op: 'created', room: room.code, seat: 0, token: client.id });
      return;
    }

    case 'join': {
      leaveCurrentRoom(client);
      const room = rooms.get(String(msg.room ?? '').toUpperCase());
      if (!room) return sendJSON(client, { op: 'error', error: 'room-not-found' });
      if (room.started) return sendJSON(client, { op: 'error', error: 'match-in-progress' });
      const seat = room.seats.findIndex(s => !s);
      if (seat < 0) return sendJSON(client, { op: 'error', error: 'room-full' });
      seatPlayer(room, client, seat);
      sendJSON(client, { op: 'joined', room: room.code, seat, token: client.id });
      broadcast(room, { op: 'peer-joined', seat, name: client.name });
      if (room.seats.every(Boolean)) startMatch(room, false);
      return;
    }

    case 'start-vs-ai': {
      const room = client.room;
      if (!room || room.started || room.seats[0] !== client) return;
      startMatch(room, true);
      return;
    }

    case 'leave':
      leaveCurrentRoom(client);
      sendJSON(client, { op: 'left' });
      return;

    case 'chat': {
      const room = client.room;
      if (!room) return;
      // Moderated, capped composer: 10 messages/minute, length-bounded.
      client.chatTimes = client.chatTimes.filter(t => now - t < 60000);
      if (client.chatTimes.length >= 10) return sendJSON(client, { op: 'error', error: 'chat-rate-limited' });
      client.chatTimes.push(now);
      const text = String(msg.text ?? '').slice(0, 200).trim();
      if (!text) return;
      broadcast(room, { op: 'chat', from: client.name, seat: client.seat, text });
      return;
    }

    default:
      return; // unknown control ops are ignored, never fatal
  }
}

function leaveCurrentRoom(client) {
  const room = client.room;
  if (!room) return;
  if (room.seats[client.seat] === client) room.seats[client.seat] = null;
  if (room.tokens[client.seat] === client.id) room.tokens[client.seat] = null;
  client.room = null;
  client.seat = -1;
  broadcast(room, { op: 'peer-left', seat: client.seat });
  if (!room.seats.some(Boolean)) destroyRoom(room);
}

/** Binary gameplay frames: mallet target input only. Bounds-checked here and
 *  re-validated by the rules engine — client physics claims are never trusted. */
function handleBinary(client, payload) {
  if (payload.length !== 13 || payload[0] !== 1) return;
  const room = client.room;
  if (!room?.started || client.seat < 0) return;
  const x = payload.readFloatLE(5), y = payload.readFloatLE(9);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < -50 || x > rules.TABLE_W + 50 || y < -50 || y > rules.TABLE_H + 50) return;
  room.inputs[client.seat] = { x, y };
}

// Room janitor: expire abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > ROOM_TTL_MS || (!room.seats.some(Boolean) && now - room.createdAt > 60000)) {
      destroyRoom(room);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`Glow Strikers server: http://localhost:${PORT}`);
});
