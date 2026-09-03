// Unit, property, fuzz and golden tests for the Glow Strikers rules engine,
// session replay, AI, and content validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../js/rules.js';
import { Session } from '../js/session.js';
import { createAI } from '../js/ai.js';
import { validateContent, JOURNEY, CHALLENGES, dailyConfig, dailySeed, THEMES, LESSONS } from '../js/content.js';
import { RngStream, hashValue } from '../js/rng.js';

const T = rules;

function playToTerminal(state, { aiSkill = 0.6, maxTicks = 60 * 60 * 10, mover = null } = {}) {
  const ai = createAI({ skill: aiSkill, player: 1, seed: state.seed });
  let ticks = 0;
  while (state.phase !== T.PHASE.TERMINAL && ticks++ < maxTicks) {
    if (mover) {
      const t = mover(state);
      if (t) T.applyCommand(state, T.makeCommand(0, 'move', t));
    }
    const at = ai.update(state);
    if (at) T.applyCommand(state, T.makeCommand(1, 'move', at));
    T.step(state);
  }
  return state;
}

// ---------------------------------------------------------------- creation

test('createMatch produces a legal initial state', () => {
  const s = T.createMatch({ seed: 42 });
  assert.equal(s.phase, T.PHASE.COUNTDOWN);
  assert.equal(s.tick, 0);
  assert.deepEqual(s.scores, [0, 0]);
  assert.equal(s.puck.x, T.TABLE_W / 2);
  assert.equal(s.puck.y, T.TABLE_H / 2);
  // Mallets start inside their legal halves.
  for (const [i, m] of s.mallets.entries()) {
    const b = T.malletBounds(i);
    assert.ok(m.x >= b.minX && m.x <= b.maxX && m.y >= b.minY && m.y <= b.maxY);
  }
});

// ---------------------------------------------------------------- legality

test('legalActions reflects phase and budget', () => {
  const s = T.createMatch({ seed: 1, startPhase: 'active' });
  const la = T.legalActions(s, 0);
  assert.ok(la.actions.some(a => a.type === 'move'));

  s.phase = T.PHASE.TERMINAL;
  assert.deepEqual(T.legalActions(s, 0).actions, []);
  assert.equal(T.legalActions(s, 0).reason, 'match-over');

  const b = T.createMatch({ seed: 1, startPhase: 'active', moveBudget: [0, 0] });
  assert.equal(T.legalActions(b, 0).reason, 'move-budget-exhausted');
});

test('move command clamps into the legal half', () => {
  const s = T.createMatch({ seed: 1, startPhase: 'active' });
  const res = T.applyCommand(s, T.makeCommand(0, 'move', { x: 500, y: 500 }));
  assert.ok(res.ok);
  const b = T.malletBounds(0);
  assert.equal(s.mallets[0].tx, b.maxX);
  assert.equal(s.mallets[0].ty, b.maxY);
});

test('invalid commands are rejected with reasons and counted', () => {
  const s = T.createMatch({ seed: 1, startPhase: 'active' });
  assert.equal(T.applyCommand(s, null).reason, 'malformed-command');
  assert.equal(T.applyCommand(s, { player: 7, type: 'move', data: {} }).reason, 'unknown-player');
  assert.equal(T.applyCommand(s, { player: 0, type: 'teleport', data: {} }).reason, 'unknown-command-type');
  assert.equal(T.applyCommand(s, T.makeCommand(0, 'move', { x: NaN, y: 0 })).reason, 'bad-target');
  const b = T.createMatch({ seed: 1, startPhase: 'active', moveBudget: [0, 0] });
  const r = T.applyCommand(b, T.makeCommand(0, 'move', { x: 10, y: 10 }));
  assert.equal(r.reason, 'move-budget-exhausted');
  assert.equal(b.stats[0].invalid, 1);
});

test('malformed fuzz: no throws, no NaN, no hangs', () => {
  const rng = new RngStream(0xF00D, 9);
  for (let i = 0; i < 2000; i++) {
    const s = T.createMatch({ seed: i, startPhase: 'active', moveBudget: i % 3 ? [500, 500] : null });
    for (let j = 0; j < 50; j++) {
      const cmd = {
        player: rng.int(-2, 3),
        type: ['move', 'forfeit', 'hack', '', null, 42][rng.int(0, 5)],
        data: rng.float() < 0.5 ? { x: rng.range(-1e6, 1e6), y: rng.range(-1e6, 1e6) } : { x: NaN },
      };
      T.applyCommand(s, cmd); // must never throw
      T.step(s);
    }
    assert.ok(Number.isFinite(s.puck.x) && Number.isFinite(s.puck.y), `NaN puck at seed ${i}`);
    assert.ok(s.tick >= 0);
  }
});

// ---------------------------------------------------------------- physics

test('mallet cannot cross the centre line', () => {
  const s = T.createMatch({ seed: 3, startPhase: 'active' });
  T.applyCommand(s, T.makeCommand(0, 'move', { x: 50, y: T.TABLE_H }));
  for (let i = 0; i < 600; i++) T.step(s);
  assert.ok(s.mallets[0].y <= T.TABLE_H / 2 - T.MALLET_R + 1e-9);
});

test('puck friction slows it but never reverses it; speed is capped', () => {
  const s = T.createMatch({ seed: 4, startPhase: 'active' });
  s.puck.x = 20; s.puck.vx = 10000; s.puck.vy = 0;
  T.step(s);
  const sp = Math.hypot(s.puck.vx, s.puck.vy);
  assert.ok(sp <= T.MAX_PUCK_SPEED + 1e-9);
  const before = sp;
  for (let i = 0; i < 3; i++) T.step(s); // open ice: no walls reached yet
  const after = Math.hypot(s.puck.vx, s.puck.vy);
  assert.ok(after < before);
  assert.ok(s.puck.vx >= 0);
});

test('a puck into the goal mouth scores; elsewhere it bounces', () => {
  const s = T.createMatch({ seed: 5, startPhase: 'active' });
  s.puck.x = T.TABLE_W / 2; s.puck.y = 30; s.puck.vx = 0; s.puck.vy = -100; // dead centre
  let goal = null;
  for (let i = 0; i < 120 && !goal; i++) goal = T.step(s).find(e => e.type === 'goal');
  assert.ok(goal, 'expected a goal');
  assert.equal(goal.scorer, 1); // player 1 scores in player 0's goal
  assert.deepEqual(s.scores, [0, 1]);
  assert.equal(s.phase, T.PHASE.GOAL_PAUSE);

  const b = T.createMatch({ seed: 5, startPhase: 'active' });
  b.puck.x = 5; b.puck.y = 30; b.puck.vx = 0; b.puck.vy = -100; // corner — not a goal
  let g = null;
  for (let i = 0; i < 120 && !g; i++) g = T.step(b).find(e => e.type === 'goal') ?? null;
  assert.equal(g, null);
  assert.ok(b.puck.vy > 0, 'puck should have bounced off the end wall');
});

test('conceder receives the serve after a goal', () => {
  const s = T.createMatch({ seed: 6, startPhase: 'active' });
  s.puck.x = T.TABLE_W / 2; s.puck.y = 30; s.puck.vy = -120;
  for (let i = 0; i < 60; i++) T.step(s);
  assert.equal(s.serveToward, 0); // player 0 conceded, player 0 receives
  for (let i = 0; i < T.GOAL_PAUSE_TICKS + 5; i++) T.step(s);
  assert.equal(s.phase, T.PHASE.ACTIVE);
  assert.ok(s.puck.vy < 0, 'serve should travel toward player 0');
});

// ---------------------------------------------------------------- terminal

test('target score ends the match with the right winner and reason', () => {
  const s = T.createMatch({ seed: 7, startPhase: 'active', targetScore: 2 });
  const events = [];
  for (let g = 0; g < 2; g++) {
    s.puck.x = T.TABLE_W / 2; s.puck.y = 30; s.puck.vx = 0; s.puck.vy = -150;
    s.phase = T.PHASE.ACTIVE;
    while (s.phase === T.PHASE.ACTIVE) events.push(...T.step(s));
    while (s.phase === T.PHASE.GOAL_PAUSE) events.push(...T.step(s));
  }
  assert.equal(s.phase, T.PHASE.TERMINAL);
  assert.equal(s.terminalReason, T.TERMINAL.TARGET_SCORE);
  assert.equal(s.winner, 1);
  assert.ok(events.some(e => e.type === 'terminal'));
});

test('time limit resolves; ties go to golden-goal overtime', () => {
  const s = T.createMatch({ seed: 8, startPhase: 'active', timeLimitSeconds: 2 });
  for (let i = 0; i < 60 * 3; i++) T.step(s);
  assert.ok(s.inOvertime, 'tied expiry should enter overtime');
  s.puck.x = T.TABLE_W / 2; s.puck.y = T.TABLE_H - 30; s.puck.vy = 150;
  while (s.phase !== T.PHASE.TERMINAL) T.step(s);
  assert.equal(s.terminalReason, T.TERMINAL.OVERTIME_GOAL);
  assert.equal(s.winner, 0);

  const nt = T.createMatch({ seed: 8, startPhase: 'active', timeLimitSeconds: 2, overtime: false });
  for (let i = 0; i < 60 * 3; i++) T.step(nt);
  assert.equal(nt.phase, T.PHASE.TERMINAL);
  assert.equal(nt.terminalReason, T.TERMINAL.TIME_LIMIT);
  assert.equal(nt.winner, -1); // draw
});

test('forfeit ends the match immediately', () => {
  const s = T.createMatch({ seed: 9, startPhase: 'active' });
  const res = T.applyCommand(s, T.makeCommand(0, 'forfeit'));
  assert.ok(res.ok);
  assert.equal(s.winner, 1);
  assert.equal(s.terminalReason, T.TERMINAL.FORFEIT);
});

test('tick increases monotonically', () => {
  const s = T.createMatch({ seed: 10 });
  let last = -1;
  for (let i = 0; i < 1000; i++) {
    T.step(s);
    assert.ok(s.tick > last);
    last = s.tick;
  }
});

// ---------------------------------------------------------------- serialization & determinism

test('serialize/deserialize round-trips and preserves future simulation', () => {
  const s = T.createMatch({ seed: 11 });
  for (let i = 0; i < 500; i++) T.step(s);
  T.applyCommand(s, T.makeCommand(0, 'move', { x: 20, y: 40 }));
  for (let i = 0; i < 200; i++) T.step(s);
  const snap = T.serialize(s);
  const hashA = T.hash(s);
  const restored = T.deserialize(JSON.parse(JSON.stringify(snap)));
  assert.equal(T.hash(restored), hashA);
  // Futures match too (rng cursor restored).
  for (let i = 0; i < 300; i++) { T.step(s); T.step(restored); }
  assert.equal(T.hash(restored), T.hash(s));
});

test('deserialization rejects foreign versions', () => {
  assert.throws(() => T.deserialize({ version: 999 }));
});

test('property: same seed + same commands produce identical hashes', () => {
  for (const seed of [1, 12345, 999999]) {
    const runs = [0, 1].map(() => {
      const s = T.createMatch({ seed, obstacles: [{ x: 50, y: 100, r: 8 }] });
      const rng = new RngStream(seed, 5);
      const hashes = [];
      for (let i = 0; i < 1800; i++) {
        if (i % 30 === 0) {
          T.applyCommand(s, T.makeCommand(0, 'move', { x: rng.range(10, 90), y: rng.range(10, 90) }));
          T.applyCommand(s, T.makeCommand(1, 'move', { x: rng.range(10, 90), y: rng.range(110, 190) }));
        }
        T.step(s);
        if (i % 300 === 0) hashes.push(T.hash(s));
      }
      return hashes;
    });
    assert.deepEqual(runs[0], runs[1], `seed ${seed} diverged`);
  }
});

test('replay envelope verifies end-to-end', () => {
  const cfg = { seed: 777, targetScore: 2, obstacles: [] };
  const session = new Session(cfg, { mode: 'practice' });
  const ai = createAI({ skill: 0.6, player: 1, seed: 777 });
  const rng = new RngStream(77, 1);
  let guard = 0;
  while (session.state.phase !== T.PHASE.TERMINAL && guard++ < 60 * 60 * 8) {
    if (guard % 20 === 0) session.move(0, rng.range(10, 90), rng.range(10, 90));
    const t = ai.update(session.state);
    if (t) session.move(1, t.x, t.y);
    session.tick();
  }
  assert.equal(session.state.phase, T.PHASE.TERMINAL);
  const result = Session.verifyReplay(session.replay);
  assert.ok(result.ok, `replay diverged at tick ${result.atTick}`);
});

test('undo restores a prior snapshot', () => {
  const session = new Session({ seed: 55 }, { mode: 'practice' });
  for (let i = 0; i < 130; i++) session.tick();
  assert.ok(session.canUndo());
  const before = session.state.tick;
  assert.ok(session.undo());
  assert.ok(session.state.tick < before);
  assert.ok(Number.isFinite(session.state.puck.x));
});

// ---------------------------------------------------------------- golden sessions

test('golden: easy/medium/hard AI matches always terminate with sane state', () => {
  for (const [name, skill] of [['easy', 0.2], ['medium', 0.5], ['hard', 0.85]]) {
    const s = T.createMatch({ seed: 100 + skill * 100, targetScore: 3, timeLimitSeconds: 300 });
    playToTerminal(s, { aiSkill: skill, mover: (st) => ({ x: st.puck.x, y: Math.min(st.puck.y, T.TABLE_H / 2 - T.MALLET_R) }) });
    assert.equal(s.phase, T.PHASE.TERMINAL, name);
    assert.ok(s.scores[0] + s.scores[1] >= 1, name);
    const bd = T.resultBreakdown(s);
    assert.ok(bd.players.every(p => p.goals >= 0 && p.invalidActions >= 0));
  }
});

test('golden: interrupted session resumes from snapshot', () => {
  const s = T.createMatch({ seed: 4242, targetScore: 3 });
  const ai = createAI({ skill: 0.5, player: 1, seed: 4242 });
  for (let i = 0; i < 2000; i++) {
    const t = ai.update(s);
    if (t) T.applyCommand(s, T.makeCommand(1, 'move', t));
    T.step(s);
  }
  const snap = JSON.parse(JSON.stringify(T.serialize(s)));
  const resumed = T.deserialize(snap);
  for (let i = 0; i < 500; i++) {
    const t = ai.update(s); if (t) T.applyCommand(s, T.makeCommand(1, 'move', t));
    const t2 = ai.update(resumed); if (t2) T.applyCommand(resumed, T.makeCommand(1, 'move', t2));
    T.step(s); T.step(resumed);
  }
  assert.equal(T.hash(s), T.hash(resumed));
});

// ---------------------------------------------------------------- content

test('content validation passes', () => {
  assert.deepEqual(validateContent(), []);
});

test('journey has 40 stages with mastery every 8th and sane difficulty ramp', () => {
  assert.equal(JOURNEY.length, 40);
  assert.ok(JOURNEY[7].mastery && JOURNEY[39].mastery && !JOURNEY[0].mastery);
  assert.ok(JOURNEY[39].ai.skill > JOURNEY[0].ai.skill);
  assert.ok(JOURNEY.every(s => Number.isInteger(s.seed)));
});

test('daily config is stable per UTC day and differs across days', () => {
  const d1 = new Date(Date.UTC(2026, 0, 15, 3, 30));
  const d1b = new Date(Date.UTC(2026, 0, 15, 23, 59));
  const d2 = new Date(Date.UTC(2026, 0, 16));
  assert.equal(dailySeed(d1), dailySeed(d1b));
  assert.notEqual(dailySeed(d1), dailySeed(d2));
  assert.equal(dailyConfig(d1).id, dailyConfig(d1b).id);
});

test('all obstacles in shipped content are clear of goal mouths and spawn', () => {
  for (const c of [...JOURNEY, ...CHALLENGES]) {
    for (const o of c.obstacles ?? []) {
      const nearGoal = Math.abs(o.x - T.TABLE_W / 2) < 26 && (o.y < 30 || o.y > T.TABLE_H - 30);
      assert.ok(!nearGoal, `${c.id} obstacle blocks a goal`);
      assert.ok(Math.hypot(o.x - T.TABLE_W / 2, o.y - T.TABLE_H / 2) >= o.r + 10, `${c.id} obstacle on spawn`);
    }
  }
});

test('launch scope: >=40 stages, 5 themes, >=5 lessons, daily, challenges', () => {
  assert.ok(JOURNEY.length >= 40);
  assert.ok(THEMES.length >= 5);
  assert.ok(LESSONS.length >= 5);
  assert.ok(CHALLENGES.length >= 5);
  assert.ok(dailyConfig().seed > 0);
});
