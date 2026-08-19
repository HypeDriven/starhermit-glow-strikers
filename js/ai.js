// Deterministic AI controller. Consumes the same legal-action/command API as
// human input; skill tunes reaction cadence, aim error and prediction depth.

import { TABLE_W, TABLE_H, MALLET_R, PUCK_R, GOAL_W, legalActions, malletBounds } from './rules.js';
import { RngStream } from './rng.js';

export function createAI({ skill = 0.5, player = 1, seed = 1 }) {
  const rng = new RngStream(seed ^ 0xA11CE, 7);
  const home = player === 1 ? TABLE_H * 0.82 : TABLE_H * 0.18;
  const goalY = player === 1 ? TABLE_H - MALLET_R : MALLET_R;
  let aimErrX = 0, aimErrY = 0, lastDecision = -1;

  // Lower skill = fewer decisions per second and larger aim error.
  const decisionInterval = Math.max(1, Math.round(12 - skill * 10)); // ticks
  const errorScale = (1 - skill) * 14;
  const prediction = 0.2 + skill * 0.6; // seconds of puck lead

  return {
    player,
    /** Returns a 'move' command target {x,y} or null if no legal action. */
    update(state) {
      const legal = legalActions(state, player);
      if (!legal.actions.length) return null;
      if (state.tick - lastDecision < decisionInterval) return null;
      lastDecision = state.tick;

      // Re-roll aim error occasionally (deterministic stream).
      if (state.tick % 90 === 0) {
        aimErrX = (rng.float() - 0.5) * errorScale;
        aimErrY = (rng.float() - 0.5) * errorScale * 0.5;
      }

      const puck = state.puck;
      const myGoalSide = player === 1;
      const puckOnMySide = myGoalSide ? puck.y > TABLE_H / 2 : puck.y < TABLE_H / 2;
      const puckComing = myGoalSide ? puck.vy > 10 : puck.vy < -10;

      let tx, ty;
      if (puckOnMySide) {
        // Intercept: aim at where the puck will be, slightly behind it, so the
        // mallet's forward motion strikes toward the opponent's goal.
        const px = puck.x + puck.vx * prediction * (0.4 + 0.6 * skill);
        const py = puck.y + puck.vy * prediction * (0.4 + 0.6 * skill);
        const toOppX = TABLE_W / 2 - px;
        const toOppY = (myGoalSide ? 0 : TABLE_H) - py;
        const len = Math.hypot(toOppX, toOppY) || 1;
        const behind = MALLET_R + PUCK_R - 1;
        tx = px - (toOppX / len) * behind + aimErrX;
        ty = py - (toOppY / len) * behind + aimErrY;
      } else if (puckComing) {
        // Defensive positioning on the goal line, tracking puck x with lag.
        const guard = GOAL_W / 2 + MALLET_R - 2;
        tx = TABLE_W / 2 + Math.max(-guard, Math.min(guard, puck.x - TABLE_W / 2)) * (0.55 + skill * 0.4);
        ty = goalY;
      } else {
        // Idle: drift toward home, shading the puck's lane.
        tx = TABLE_W / 2 + (puck.x - TABLE_W / 2) * 0.3;
        ty = home;
      }

      const b = malletBounds(player);
      return {
        x: Math.min(b.maxX, Math.max(b.minX, tx)),
        y: Math.min(b.maxY, Math.max(b.minY, ty)),
      };
    },
  };
}
