// server.js, the one platform script, run as the platform runs it: a fresh
// context per invocation, every ctx and return value through JSON, the sender
// named by the host. Hosted matches (room-bound sessions) are refereed whole —
// a human against the room's AI seat, two humans, forged and out-of-range
// input, a forfeit command, a player who left the room — and solo scores are
// range-checked for the high-score board as score-script.js did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../server.js', import.meta.url));
const SCRIPT = new vm.Script(readFileSync(FILE, 'utf8'), { filename: 'server.js' });
const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function invoke(entry, ctx) {
  const sb = {};
  vm.createContext(sb);
  SCRIPT.runInContext(sb);
  return json(sb.game[entry](json(ctx)));
}

function match({ roster, presence, steps = 20000, input = null, onTick = null }) {
  let now = 1_000_000;
  const room = { roomId: 'r1', metadata: { mode: '1v1' }, roster };
  const players = roster.filter((r) => !r.ai).map((r) => ({ id: r.userId, name: r.name, elo: 1200 }));
  let out = invoke('createSession', { now, random: 0.37, sessionId: 's', players, room, presence, sessionState: null });
  assert.ok(out.ok);
  let ss = out.sessionState, result = null, snaps = 0, last = null, i = 0;
  for (; i < steps && !result; i++) {
    now += 33;
    const inputs = input ? input(i, last) : [];
    out = invoke('onTick', { now, random: 0.5, sessionId: 's', players, room, presence, sessionState: ss, inputs });
    assert.ok(out.ok, out.error);
    ss = out.sessionState;
    for (const b of out.broadcast ?? []) {
      assert.equal(b.to, 'all');
      if (b.data.type === 'snap') { snaps++; last = b.data; assert.ok(JSON.stringify(b.data).length < 16000); }
    }
    if (out.result) result = out;
    onTick?.(i, ss);
  }
  return { result, ss, snaps, last, ticks: i, now, room, players, presence };
}

const H = (id, team, name = id) => ({ userId: id, name, team, slot: 0, ai: false });
const AI = (team) => ({ userId: null, name: 'Rafa Vento', team, slot: 0, ai: true });

test('the RULES block is current with js/', () => {
  execFileSync('node', [fileURLToPath(new URL('../tools/build-server.mjs', import.meta.url)), '--check'], { stdio: 'pipe' });
});

test('a hosted match against the room\'s AI seat is played to a server result', () => {
  const { result, last, snaps } = match({
    roster: [H('alice', 0), AI(1)], presence: { alice: { online: true, left: false } },
    // alice shadows the puck from her half
    input: (i, s) => (s ? [{ from: 'alice', data: { type: 'input', realtime: true, x: s.p[0], y: Math.min(90, s.p[1]) } }] : []),
  });
  assert.ok(result, 'the match ended');
  assert.ok(snaps > 100);
  const over = result.broadcast.find((b) => b.data.type === 'over').data;
  assert.equal(result.result.teamScores.join(), over.scores.join());
  assert.ok(Math.max(...over.scores) === 5 || over.reason === 'time-limit');
  assert.equal(result.result.winnerUserId, over.winner === 0 ? 'alice' : null);
  assert.equal(last.ph, 'terminal');
  assert.equal(result.sessionState.summary.status, 'finished');
});

test('two humans: the countdown waits for both sockets; input moves only the sender\'s mallet, inside their half', () => {
  const presence = { a: { online: true, left: false }, b: { online: false, left: false } };
  let seenWaiting = 0, firstActive = -1;
  const r = match({
    roster: [H('a', 0), H('b', 1)], presence, steps: 400,
    input: (i, s) => {
      if (s?.ph === 'waiting') seenWaiting++;
      if (i === 60) presence.b.online = true;
      if (s && s.ph !== 'waiting' && firstActive < 0) firstActive = i;
      // b forges a target in a's half and claims to be a: only b's own mallet moves, clamped to its half.
      return [{ from: 'b', data: { x: 50, y: 10, seat: 0, from: 'a' } }, { from: 'mallory', data: { x: 5, y: 5 } }];
    },
  });
  assert.ok(seenWaiting >= 50, 'waited for b');
  assert.ok(firstActive >= 60);
  const m = r.last.m;
  assert.ok(m[3] >= 100 + 7 - 1e-9, `b stays in its half (${m[3]})`);
  assert.equal(m[0], 50); // a did not move
});

test('a forfeit command and a player who left both end the match for the other side', () => {
  const presence = { a: { online: true, left: false }, b: { online: true, left: false } };
  const r = match({ roster: [H('a', 0), H('b', 1)], presence, steps: 30 });
  const ctx = { now: r.now + 33, random: 0.1, sessionId: 's', players: r.players, room: r.room, presence, sessionState: r.ss };
  const out = invoke('onPlayerMessage', { ...ctx, message: { from: 'b', data: { type: 'forfeit' } } });
  assert.equal(out.result.winnerSeat, 0);
  assert.equal(out.result.reason, 'forfeit');
  assert.equal(invoke('onPlayerMessage', { ...ctx, message: { from: 'zed', data: { type: 'forfeit' } } }).ok, false);

  presence.a.left = true;
  const left = invoke('onTick', { ...ctx, inputs: [] });
  assert.equal(left.result.winnerSeat, 1);
});

test('sync answers the sender with the table and a snapshot', () => {
  const presence = { a: { online: true, left: false } };
  const r = match({ roster: [H('a', 0, 'Ada'), AI(1)], presence, steps: 5 });
  const out = invoke('onPlayerMessage', { now: r.now, random: 0, sessionId: 's', players: r.players, room: r.room, presence, sessionState: r.ss, message: { from: 'a', data: { type: 'sync' } } });
  const [table, snap] = out.broadcast;
  assert.deepEqual(table.to, ['a']);
  assert.equal(table.data.type, 'table');
  assert.deepEqual(table.data.seats.map((s) => [s.name, s.ai]), [['Ada', false], ['Rafa Vento', true]]);
  assert.equal(snap.data.type, 'snap');
});

test('solo score posting: range-checked against the high-score board, then the session ends', () => {
  const ss = invoke('createSession', { now: 1, random: 0, players: [{ id: 'u' }], sessionState: null }).sessionState;
  assert.equal(ss.kind, 'score');
  const ok = invoke('onPlayerMessage', { now: 2, sessionState: ss, message: { from: 'u', data: { type: 'result', scores: { 'high-score': 47 } } } });
  assert.deepEqual(ok.scores, { 'high-score': { u: 47 } });
  assert.ok(ok.result);
  assert.deepEqual(ok.broadcast[0].data.accepted, ['high-score']);
  const bad = invoke('onPlayerMessage', { now: 2, sessionState: ss, message: { from: 'u', data: { type: 'result', scores: { 'high-score': 100 } } } });
  assert.deepEqual(bad.scores, {});
  assert.equal(invoke('onTick', { now: 3, sessionState: ss }).ok, true);
});
