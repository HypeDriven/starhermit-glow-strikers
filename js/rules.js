// Glow Strikers rules engine — pure, deterministic, renderer-independent.
//
// Table coordinates: x in [0, TABLE_W], y in [0, TABLE_H]. Player 0 defends the
// goal on the y=0 edge and may move in y in (0, TABLE_H/2); player 1 mirrors.
// The puck is low-friction; mallets are velocity-limited toward a target point.
//
// Contract:
//  - legalActions(state, player) enumerates what a player may do right now.
//  - applyCommand(state, cmd) validates + applies a command, returning a result
//    with an explicit invalid reason. It never throws on malformed input.
//  - step(state) advances exactly one fixed tick and returns logical events.
//  - serialize/deserialize produce a stable, quantized, versioned snapshot.
//  - hash(state) is identical for identical logical states (replay testing).
//  - state.tick increases monotonically; terminal states carry a reason.

import { RngStream, hashValue } from './rng.js';

export const RULES_VERSION = 1;
export const DT = 1 / 60;                 // fixed simulation step (seconds)
export const TABLE_W = 100;
export const TABLE_H = 200;
export const MALLET_R = 7;
export const PUCK_R = 4;
export const GOAL_W = 44;
export const WALL_REST = 0.92;            // wall restitution
export const MALLET_REST = 1.06;          // mallet strike liveliness
export const PUCK_FRICTION = 0.9985;      // per-tick velocity retention
export const MAX_PUCK_SPEED = 300;        // units/second
export const DEFAULT_MALLET_SPEED = 150;  // units/second
export const COUNTDOWN_TICKS = 180;       // 3 s
export const GOAL_PAUSE_TICKS = 90;       // 1.5 s between goal and serve
export const SERVE_SPEED = 70;
export const DEFAULT_TARGET_SCORE = 5;

export const PHASE = Object.freeze({
  COUNTDOWN: 'countdown',
  ACTIVE: 'active',
  GOAL_PAUSE: 'goalPause',
  TERMINAL: 'terminal',
});

export const TERMINAL = Object.freeze({
  TARGET_SCORE: 'target-score',
  TIME_LIMIT: 'time-limit',
  OVERTIME_GOAL: 'overtime-goal',
  FORFEIT: 'forfeit',
  MOVE_LIMIT: 'move-limit',
});

// ---------------------------------------------------------------------------
// Match creation
// ---------------------------------------------------------------------------

/**
 * options: {
 *   seed, targetScore, timeLimitSeconds (0 = none),
 *   obstacles: [{x,y,r}], malletSpeeds: [s0, s1],
 *   moveBudget: [b0, b1] | null  (total mallet travel units, challenge rule),
 *   startPhase: 'countdown' | 'active' (active used by tutorials),
 *   overtime: bool (golden goal when time expires tied; default true),
 * }
 */
export function createMatch(options = {}) {
  const seed = (options.seed ?? 1) >>> 0;
  const rng = new RngStream(seed, 0);
  const state = {
    version: RULES_VERSION,
    seed,
    tick: 0,
    phase: options.startPhase === 'active' ? PHASE.ACTIVE : PHASE.COUNTDOWN,
    phaseTicks: options.startPhase === 'active' ? 0 : COUNTDOWN_TICKS,
    terminalReason: null,
    winner: -1,
    targetScore: options.targetScore ?? DEFAULT_TARGET_SCORE,
    timeLimitTicks: Math.round((options.timeLimitSeconds ?? 0) / DT),
    overtime: options.overtime !== false,
    inOvertime: false,
    config: {
      obstacles: (options.obstacles ?? []).map(o => ({ x: o.x, y: o.y, r: o.r })),
      malletSpeeds: options.malletSpeeds ?? [DEFAULT_MALLET_SPEED, DEFAULT_MALLET_SPEED],
    },
    puck: { x: TABLE_W / 2, y: TABLE_H / 2, vx: 0, vy: 0 },
    mallets: [
      { x: TABLE_W / 2, y: TABLE_H * 0.22, tx: TABLE_W / 2, ty: TABLE_H * 0.22, vx: 0, vy: 0 },
      { x: TABLE_W / 2, y: TABLE_H * 0.78, tx: TABLE_W / 2, ty: TABLE_H * 0.78, vx: 0, vy: 0 },
    ],
    scores: [0, 0],
    stats: [
      { goals: 0, shots: 0, saves: 0, steals: 0, invalid: 0, wallBounces: 0, maxPuckSpeed: 0 },
      { goals: 0, shots: 0, saves: 0, steals: 0, invalid: 0, wallBounces: 0, maxPuckSpeed: 0 },
    ],
    moveBudget: options.moveBudget ? [options.moveBudget[0], options.moveBudget[1]] : null,
    serveToward: -1,      // set during goal pause
    servePending: false,  // puck is centered, waiting to be served
    lastTouch: -1,
    activeTicks: 0,       // authoritative elapsed time (ticks in active play)
    rngCursor: 0,         // number of draws consumed; rng rebuilt from seed+cursor
  };
  // Keep a live stream alongside the cursor (same draws, deterministic).
  state._rng = rng;
  return state;
}

function rngDraw(state) {
  state.rngCursor++;
  return state._rng.float();
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

export function malletBounds(player) {
  const half = TABLE_H / 2;
  return player === 0
    ? { minX: MALLET_R, maxX: TABLE_W - MALLET_R, minY: MALLET_R, maxY: half - MALLET_R }
    : { minX: MALLET_R, maxX: TABLE_W - MALLET_R, minY: half + MALLET_R, maxY: TABLE_H - MALLET_R };
}

/**
 * Enumerate legal actions for a player. Tutorials and hints consume this same
 * API; nothing about legality is duplicated elsewhere.
 * Returns { actions: [...], reason? } — reason explains why actions is empty.
 */
export function legalActions(state, player) {
  if (state.phase === PHASE.TERMINAL) {
    return { actions: [], reason: 'match-over' };
  }
  if (state.phase === PHASE.COUNTDOWN) {
    return { actions: [{ type: 'move', bounds: malletBounds(player) }], reason: null };
  }
  if (state.phase === PHASE.GOAL_PAUSE) {
    return { actions: [{ type: 'move', bounds: malletBounds(player) }], reason: null };
  }
  // ACTIVE
  if (state.moveBudget && state.moveBudget[player] <= 0) {
    return { actions: [], reason: 'move-budget-exhausted' };
  }
  return { actions: [{ type: 'move', bounds: malletBounds(player) }], reason: null };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

let cmdSeq = 0;
export function makeCommand(player, type, data = {}, id = null) {
  return { id: id ?? `c${++cmdSeq}`, player, type, data };
}

/**
 * Validate and apply one command. Returns { ok, reason?, events? }.
 * Invalid commands are counted against the issuing player (fair-play metric)
 * and never mutate puck/score state.
 */
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    return { ok: false, reason: 'malformed-command' };
  }
  const p = cmd.player;
  if (p !== 0 && p !== 1) return { ok: false, reason: 'unknown-player' };
  if (state.phase === PHASE.TERMINAL) return { ok: false, reason: 'match-over' };

  switch (cmd.type) {
    case 'move': {
      const { x, y } = cmd.data ?? {};
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-target' };
      if (state.phase === PHASE.ACTIVE && state.moveBudget && state.moveBudget[p] <= 0) {
        state.stats[p].invalid++;
        return { ok: false, reason: 'move-budget-exhausted' };
      }
      const b = malletBounds(p);
      const m = state.mallets[p];
      m.tx = Math.min(b.maxX, Math.max(b.minX, x));
      m.ty = Math.min(b.maxY, Math.max(b.minY, y));
      return { ok: true };
    }
    case 'forfeit': {
      state.winner = 1 - p;
      state.phase = PHASE.TERMINAL;
      state.terminalReason = TERMINAL.FORFEIT;
      return { ok: true, events: [{ type: 'terminal', reason: TERMINAL.FORFEIT, winner: state.winner }] };
    }
    default:
      return { ok: false, reason: 'unknown-command-type' };
  }
}

// ---------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------

function clampSpeed(vx, vy, max) {
  const s = Math.hypot(vx, vy);
  if (s > max) { const k = max / s; return [vx * k, vy * k]; }
  return [vx, vy];
}

function endMatch(state, winner, reason, events) {
  state.winner = winner;
  state.phase = PHASE.TERMINAL;
  state.terminalReason = reason;
  events.push({ type: 'terminal', reason, winner });
}

function checkTerminal(state, events) {
  const [a, b] = state.scores;
  if (a >= state.targetScore || b >= state.targetScore) {
    endMatch(state, a > b ? 0 : 1, state.inOvertime ? TERMINAL.OVERTIME_GOAL : TERMINAL.TARGET_SCORE, events);
    return;
  }
  if (state.timeLimitTicks > 0 && state.activeTicks >= state.timeLimitTicks && !state.inOvertime) {
    if (a !== b || !state.overtime) {
      endMatch(state, a === b ? -1 : (a > b ? 0 : 1), TERMINAL.TIME_LIMIT, events);
    } else {
      state.inOvertime = true;
      events.push({ type: 'overtime' });
    }
  }
}

export function step(state) {
  const events = [];
  if (state.phase === PHASE.TERMINAL) return events;
  state.tick++;

  if (state.phase === PHASE.COUNTDOWN) {
    if (--state.phaseTicks <= 0) {
      state.phase = PHASE.ACTIVE;
      serve(state, state.serveToward >= 0 ? state.serveToward : (rngDraw(state) < 0.5 ? 0 : 1), events);
    } else if (state.phaseTicks % 60 === 0) {
      events.push({ type: 'countdown', remaining: state.phaseTicks / 60 });
    }
  } else if (state.phase === PHASE.GOAL_PAUSE) {
    if (--state.phaseTicks <= 0) {
      state.phase = PHASE.ACTIVE;
      serve(state, state.serveToward, events);
    }
  } else if (state.phase === PHASE.ACTIVE) {
    state.activeTicks++;
    stepActive(state, events);
    if (state.phase === PHASE.ACTIVE) checkTerminal(state, events);
  }
  return events;
}

function serve(state, toward, events) {
  const p = state.puck;
  p.x = TABLE_W / 2; p.y = TABLE_H / 2;
  // Seeded serve angle: biased toward the player who receives the serve.
  const angle = (rngDraw(state) - 0.5) * (Math.PI / 3);
  const dir = toward === 0 ? -1 : 1; // toward player 0 = negative y
  p.vx = Math.sin(angle) * SERVE_SPEED;
  p.vy = Math.cos(angle) * SERVE_SPEED * dir;
  state.servePending = false;
  state.serveToward = -1;
  events.push({ type: 'serve', toward });
}

function stepActive(state, events) {
  const puck = state.puck;

  // --- mallets move toward their targets, speed-limited ---
  for (let i = 0; i < 2; i++) {
    const m = state.mallets[i];
    const maxStep = state.config.malletSpeeds[i] * DT;
    let dx = m.tx - m.x, dy = m.ty - m.y;
    const dist = Math.hypot(dx, dy);
    let stepLen = Math.min(dist, maxStep);
    if (state.moveBudget) {
      const remaining = state.moveBudget[i];
      if (remaining <= 0) stepLen = 0;
      else if (stepLen > remaining) stepLen = remaining;
      state.moveBudget[i] -= stepLen;
      if (state.moveBudget[i] <= 0 && remaining > 0) {
        state.moveBudget[i] = 0;
        events.push({ type: 'budget-exhausted', player: i });
      }
    }
    const ox = m.x, oy = m.y;
    if (dist > 1e-9 && stepLen > 0) {
      m.x += (dx / dist) * stepLen;
      m.y += (dy / dist) * stepLen;
    }
    m.vx = (m.x - ox) / DT;
    m.vy = (m.y - oy) / DT;
  }

  // --- puck integration (clamp before integrating to prevent tunnelling) ---
  puck.vx *= PUCK_FRICTION;
  puck.vy *= PUCK_FRICTION;
  [puck.vx, puck.vy] = clampSpeed(puck.vx, puck.vy, MAX_PUCK_SPEED);
  puck.x += puck.vx * DT;
  puck.y += puck.vy * DT;
  const speed = Math.hypot(puck.vx, puck.vy);
  if (state.lastTouch >= 0 && speed > state.stats[state.lastTouch].maxPuckSpeed) {
    state.stats[state.lastTouch].maxPuckSpeed = speed;
  }

  // --- mallet <-> puck collision (stable order: player 0 then 1) ---
  for (let i = 0; i < 2; i++) {
    const m = state.mallets[i];
    const dx = puck.x - m.x, dy = puck.y - m.y;
    const rr = MALLET_R + PUCK_R;
    const d2 = dx * dx + dy * dy;
    if (d2 < rr * rr && d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      puck.x = m.x + nx * rr; // depenetrate
      puck.y = m.y + ny * rr;
      const rvx = puck.vx - m.vx, rvy = puck.vy - m.vy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        puck.vx -= (1 + MALLET_REST) * vn * nx;
        puck.vy -= (1 + MALLET_REST) * vn * ny;
        [puck.vx, puck.vy] = clampSpeed(puck.vx, puck.vy, MAX_PUCK_SPEED);
        // Stats: a strike toward the opponent's goal.
        const towardOpp = i === 0 ? puck.vy > 0 : puck.vy < 0;
        if (towardOpp) {
          state.stats[i].shots++;
          // Save: intercepted a puck heading for own goal while deep in own half.
          const wasThreat = i === 0 ? (puck.vy < 0 && puck.y < TABLE_H / 3) : (puck.vy > 0 && puck.y > TABLE_H * 2 / 3);
          if (wasThreat) state.stats[i].saves++;
        } else if (state.lastTouch === 1 - i) {
          state.stats[i].steals++;
        }
        state.lastTouch = i;
        events.push({ type: 'strike', player: i, speed: Math.hypot(puck.vx, puck.vy) });
      }
    }
  }

  // --- static obstacles ---
  for (const o of state.config.obstacles) {
    const dx = puck.x - o.x, dy = puck.y - o.y;
    const rr = o.r + PUCK_R;
    const d2 = dx * dx + dy * dy;
    if (d2 < rr * rr && d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      puck.x = o.x + nx * rr;
      puck.y = o.y + ny * rr;
      const vn = puck.vx * nx + puck.vy * ny;
      if (vn < 0) {
        puck.vx -= 2 * vn * nx;
        puck.vy -= 2 * vn * ny;
        events.push({ type: 'obstacle', x: o.x, y: o.y });
      }
    }
  }

  // --- walls and goals ---
  const goalHalf = GOAL_W / 2;
  // Side walls
  if (puck.x < PUCK_R) { puck.x = PUCK_R; if (puck.vx < 0) { puck.vx = -puck.vx * WALL_REST; bounce(state, events); } }
  else if (puck.x > TABLE_W - PUCK_R) { puck.x = TABLE_W - PUCK_R; if (puck.vx > 0) { puck.vx = -puck.vx * WALL_REST; bounce(state, events); } }
  // End walls / goal mouths
  if (puck.y < PUCK_R) {
    if (Math.abs(puck.x - TABLE_W / 2) < goalHalf && puck.vy < 0) return goal(state, 1, events); // player 1 scores in player 0's goal
    if (puck.vy < 0) { puck.y = PUCK_R; puck.vy = -puck.vy * WALL_REST; bounce(state, events); }
  } else if (puck.y > TABLE_H - PUCK_R) {
    if (Math.abs(puck.x - TABLE_W / 2) < goalHalf && puck.vy > 0) return goal(state, 0, events);
    if (puck.vy > 0) { puck.y = TABLE_H - PUCK_R; puck.vy = -puck.vy * WALL_REST; bounce(state, events); }
  }

  // Move-limit terminal check (challenge rule): both budgets spent and puck slow.
  if (state.moveBudget && state.moveBudget[0] <= 0 && state.moveBudget[1] <= 0 && speed < 5) {
    const [a, b] = state.scores;
    endMatch(state, a === b ? -1 : (a > b ? 0 : 1), TERMINAL.MOVE_LIMIT, events);
  }
}

function bounce(state, events) {
  if (state.lastTouch >= 0) state.stats[state.lastTouch].wallBounces++;
  events.push({ type: 'wall', x: state.puck.x, y: state.puck.y });
}

function goal(state, scorer, events) {
  state.scores[scorer]++;
  state.stats[scorer].goals++;
  state.lastTouch = -1;
  const p = state.puck;
  p.x = TABLE_W / 2; p.y = TABLE_H / 2; p.vx = 0; p.vy = 0;
  events.push({ type: 'goal', scorer, scores: [...state.scores] });
  if (state.inOvertime || state.scores[scorer] >= state.targetScore) {
    endMatch(state, scorer, state.inOvertime ? TERMINAL.OVERTIME_GOAL : TERMINAL.TARGET_SCORE, events);
    return;
  }
  // Conceder receives the serve.
  state.serveToward = 1 - scorer;
  state.phase = PHASE.GOAL_PAUSE;
  state.phaseTicks = GOAL_PAUSE_TICKS;
}

// ---------------------------------------------------------------------------
// Serialization / hashing (quantized, versioned, stable)
// ---------------------------------------------------------------------------

export function serialize(state) {
  return {
    version: state.version,
    seed: state.seed,
    tick: state.tick,
    phase: state.phase,
    phaseTicks: state.phaseTicks,
    terminalReason: state.terminalReason,
    winner: state.winner,
    targetScore: state.targetScore,
    timeLimitTicks: state.timeLimitTicks,
    overtime: state.overtime,
    inOvertime: state.inOvertime,
    // Positions/velocities are stored as exact simulation units (JSON
    // round-trips doubles exactly); scores and counters are integers.
    // Values are formatted only in presentation.
    config: {
      obstacles: state.config.obstacles.map(o => ({ ...o })),
      malletSpeeds: [...state.config.malletSpeeds],
    },
    puck: { ...state.puck },
    mallets: state.mallets.map(m => ({ ...m })),
    scores: [...state.scores],
    stats: state.stats.map(s => ({ ...s })),
    moveBudget: state.moveBudget ? [...state.moveBudget] : null,
    serveToward: state.serveToward,
    servePending: state.servePending,
    lastTouch: state.lastTouch,
    activeTicks: state.activeTicks,
    rngCursor: state.rngCursor,
  };
}

export function deserialize(snap) {
  if (!snap || snap.version !== RULES_VERSION) {
    throw new Error(`unsupported snapshot version: ${snap && snap.version}`);
  }
  const state = {
    ...snap,
    config: {
      obstacles: snap.config.obstacles.map(o => ({ ...o })),
      malletSpeeds: [...snap.config.malletSpeeds],
    },
    puck: { ...snap.puck },
    mallets: snap.mallets.map(m => ({ ...m })),
    scores: [...snap.scores],
    stats: snap.stats.map(s => ({ ...s })),
    moveBudget: snap.moveBudget ? [...snap.moveBudget] : null,
  };
  // Rebuild the rng stream and fast-forward to the cursor.
  state._rng = new RngStream(state.seed, 0);
  for (let i = 0; i < state.rngCursor; i++) state._rng.float();
  return state;
}

/** Stable hash of the logical state (used by replay verification). */
export function hash(state) {
  return hashValue(serialize(state));
}

/** Score breakdown for the results screen — components, not one total. */
export function resultBreakdown(state) {
  return {
    winner: state.winner,
    reason: state.terminalReason,
    players: [0, 1].map(i => ({
      player: i,
      goals: state.stats[i].goals,
      shots: state.stats[i].shots,
      saves: state.stats[i].saves,
      steals: state.stats[i].steals,
      invalidActions: state.stats[i].invalid,
      wallBounces: state.stats[i].wallBounces,
      maxPuckSpeed: Math.round(state.stats[i].maxPuckSpeed),
      elapsedTicks: state.activeTicks,
    })),
  };
}
