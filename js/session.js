// Session: owns the mutable rules state and is the only path that mutates it —
// every change goes through a validated command or a fixed-step tick.
// Also owns the replay envelope, periodic state hashes, and practice undo.

import * as rules from './rules.js';
import { hashValue } from './rng.js';

const SNAPSHOT_EVERY = 60;      // undo snapshot cadence (ticks)
const HASH_EVERY = 60;          // replay hash cadence

export class Session {
  /**
   * config: rules.createMatch options
   * meta:   { mode, contentId, ruleset, contentVersion, ranked }
   */
  constructor(config, meta = {}) {
    this.meta = { mode: meta.mode ?? 'practice', contentId: meta.contentId ?? 'custom', ...meta };
    this.state = rules.createMatch(config);
    this.replay = {
      schema: 1,
      build: RULESET_BUILD,
      ruleset: meta.ruleset ?? 'glow-strikers/core',
      contentVersion: meta.contentVersion ?? 1,
      contentId: this.meta.contentId,
      seed: this.state.seed,
      config: JSON.parse(JSON.stringify(config)), // full match options for replay
      initialHash: rules.hash(this.state),
      startedAtTick: 0,
      commands: [],   // { tick, player, type, data, id }
      hashes: [],     // { tick, hash }
      result: null,
    };
    this._snapshots = [];       // for undo (practice/learn only)
    this._seenCommands = new Set();
    this._lastTargets = [null, null];
    this.events = [];           // drained by the app each frame
  }

  /** Issue a move command; dedupe by command id and unchanged target. */
  move(player, x, y, id) {
    if (id && this._seenCommands.has(id)) return { ok: false, reason: 'duplicate' };
    const qx = Math.round(x * 4) / 4, qy = Math.round(y * 4) / 4;
    const last = this._lastTargets[player];
    if (last && last.x === qx && last.y === qy) return { ok: true, deduped: true };
    const cmd = rules.makeCommand(player, 'move', { x: qx, y: qy }, id);
    const res = rules.applyCommand(this.state, cmd);
    if (res.ok) {
      this._lastTargets[player] = { x: qx, y: qy };
      if (id) this._seenCommands.add(id);
      this.replay.commands.push({ tick: this.state.tick, player, type: 'move', data: { x: qx, y: qy }, id: cmd.id });
    }
    return res;
  }

  forfeit(player) {
    const res = rules.applyCommand(this.state, rules.makeCommand(player, 'forfeit'));
    if (res.events) this.events.push(...res.events);
    return res;
  }

  /** Advance one fixed tick; events accumulate in this.events. */
  tick() {
    const evts = rules.step(this.state);
    if (evts.length) this.events.push(...evts);
    if (this.state.tick % SNAPSHOT_EVERY === 0) {
      this._snapshots.push(rules.serialize(this.state));
      if (this._snapshots.length > 40) this._snapshots.shift();
    }
    if (this.state.tick % HASH_EVERY === 0) {
      this.replay.hashes.push({ tick: this.state.tick, hash: rules.hash(this.state) });
    }
    if (this.state.phase === rules.PHASE.TERMINAL && !this.replay.result) {
      this.replay.result = rules.resultBreakdown(this.state);
      this.replay.finalHash = rules.hash(this.state);
    }
    return evts;
  }

  /** Practice/learn undo: restore the most recent periodic snapshot. */
  canUndo() { return this._snapshots.length > 0 && this.state.phase !== rules.PHASE.TERMINAL; }
  undo() {
    const snap = this._snapshots.pop();
    if (!snap) return false;
    this.state = rules.deserialize(snap);
    this._lastTargets = [null, null];
    return true;
  }

  snapshot() { return rules.serialize(this.state); }
  hash() { return rules.hash(this.state); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  /**
   * Deterministic replay: rebuild from the envelope's seed + ordered commands
   * and verify every recorded state hash matches.
   */
  static verifyReplay(envelope, configFactory = (env) => env.config) {
    const state = rules.createMatch(configFactory(envelope));
    const byTick = new Map();
    for (const c of envelope.commands) {
      if (!byTick.has(c.tick)) byTick.set(c.tick, []);
      byTick.get(c.tick).push(c);
    }
    const hashes = new Map(envelope.hashes.map(h => [h.tick, h.hash]));
    const maxTick = Math.max(envelope.hashes.at(-1)?.tick ?? 0, ...envelope.commands.map(c => c.tick)) + 600;
    let tick = 0;
    while (tick <= maxTick) {
      for (const c of byTick.get(tick) ?? []) rules.applyCommand(state, c);
      rules.step(state);
      tick = state.tick;
      if (hashes.has(tick) && rules.hash(state) !== hashes.get(tick)) {
        return { ok: false, atTick: tick };
      }
      if (state.phase === rules.PHASE.TERMINAL) break;
    }
    if (envelope.finalHash && rules.hash(state) !== envelope.finalHash) {
      return { ok: false, atTick: state.tick, final: true };
    }
    return { ok: true };
  }
}

export const RULESET_BUILD = '1.0.0';

/** Fast non-cryptographic integrity tag for saves (corruption detection). */
export function checksum(text) { return hashValue(text); }
