// Versioned content: themes, journey stages, tutorial lessons, challenges,
// and the daily ruleset. All content is data with identifier, seed, initial
// state modifiers, goals, allowed mechanics, par values and theme.

import { TABLE_W, TABLE_H } from './rules.js';

export const CONTENT_VERSION = 1;
export const RULESET_ID = 'glow-strikers/core';

// ---------------------------------------------------------------------------
// Visual themes (presentation only — never affect rules)
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    id: 'neon-dusk', name: 'Neon Dusk',
    bg: 0x070a18, floor: 0x0a0e22, table: 0x101736, line: 0x3d5a99,
    rail: 0x38e6ff, goal0: 0xff5c8a, goal1: 0x38e6ff,
    puck: 0xf2f6ff, mallet0: 0xff5c8a, mallet1: 0x38e6ff, accent: 0xffd166,
    bloom: 0.9,
  },
  {
    id: 'solar-foundry', name: 'Solar Foundry',
    bg: 0x140a06, floor: 0x1c0f08, table: 0x241407, line: 0x8a5a2a,
    rail: 0xffb02e, goal0: 0xff4545, goal1: 0xffb02e,
    puck: 0xfff3dd, mallet0: 0xff4545, mallet1: 0xffb02e, accent: 0x7ef0c1,
    bloom: 0.8,
  },
  {
    id: 'verdant-grid', name: 'Verdant Grid',
    bg: 0x04120c, floor: 0x071a10, table: 0x0b2417, line: 0x2c7a4b,
    rail: 0x51ff9e, goal0: 0xffe066, goal1: 0x51ff9e,
    puck: 0xeafff3, mallet0: 0xffe066, mallet1: 0x51ff9e, accent: 0xff8fb3,
    bloom: 0.85,
  },
  {
    id: 'violet-abyss', name: 'Violet Abyss',
    bg: 0x0b0616, floor: 0x100a20, table: 0x180f30, line: 0x5a3d99,
    rail: 0xb06bff, goal0: 0x5cf2ff, goal1: 0xb06bff,
    puck: 0xf3eaff, mallet0: 0x5cf2ff, mallet1: 0xb06bff, accent: 0xffd166,
    bloom: 1.0,
  },
  {
    id: 'glacier-line', name: 'Glacier Line',
    bg: 0x081018, floor: 0x0b1620, table: 0x10202e, line: 0x3d6a8a,
    rail: 0x9adcff, goal0: 0xff9e5c, goal1: 0x9adcff,
    puck: 0xffffff, mallet0: 0xff9e5c, mallet1: 0x9adcff, accent: 0xb4ff6b,
    bloom: 0.7,
  },
];

export function themeById(id) {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}

// ---------------------------------------------------------------------------
// Obstacle layouts (symmetric so stages stay fair)
// ---------------------------------------------------------------------------

function mirrored(obstacles) {
  // Mirror across the centre line y = TABLE_H/2 for fairness.
  const out = [];
  for (const o of obstacles) {
    out.push({ x: o.x, y: o.y, r: o.r });
    const my = TABLE_H - o.y;
    if (Math.abs(my - o.y) > 1e-6) out.push({ x: o.x, y: my, r: o.r });
  }
  return out;
}

export const OBSTACLE_LAYOUTS = {
  none: [],
  // Centre spawn (50,100) and both goal mouths must stay clear — the offline
  // validator and tests enforce this.
  pillars: mirrored([{ x: 30, y: 70, r: 7 }, { x: TABLE_W - 30, y: 70, r: 7 }]),
  gates: mirrored([{ x: 22, y: TABLE_H / 2, r: 6 }, { x: TABLE_W - 22, y: TABLE_H / 2, r: 6 }]),
  diamonds: mirrored([{ x: 25, y: 62, r: 5 }, { x: TABLE_W - 25, y: 62, r: 5 }]),
  cross: mirrored([{ x: TABLE_W / 2, y: 50, r: 5.5 }]),
  hive: mirrored([{ x: 20, y: 45, r: 4 }, { x: TABLE_W - 20, y: 45, r: 4 }, { x: TABLE_W / 2, y: 72, r: 6 }]),
};

// ---------------------------------------------------------------------------
// Journey: 40 authored stages (index 0..39), mastery stage every 8th.
// Difficulty grows through AI skill, layouts, time pressure and budgets —
// measured by solution depth / time pressure / motor precision, not just
// bigger numbers.
// ---------------------------------------------------------------------------

function buildJourney() {
  const stages = [];
  const layoutOrder = ['none', 'none', 'pillars', 'gates', 'diamonds', 'cross', 'hive'];
  for (let i = 0; i < 40; i++) {
    const mastery = (i + 1) % 8 === 0;
    const band = Math.floor(i / 8);             // 0..4 concept bands
    const within = i % 8;
    const layout = layoutOrder[Math.min(band + (within >= 6 ? 1 : 0), layoutOrder.length - 1)];
    const aiSkill = Math.min(0.95, 0.18 + i * 0.02 + (mastery ? 0.08 : 0));
    const timeLimit = band >= 2 ? Math.max(75, 150 - i * 2) : 0;
    const budget = band >= 3 && within % 3 === 2 ? Math.max(2600, 5200 - i * 60) : 0;
    const targetScore = mastery ? 7 : 5;
    stages.push({
      id: `j${String(i + 1).padStart(2, '0')}`,
      index: i,
      version: CONTENT_VERSION,
      name: stageName(i, mastery),
      seed: 0xC0FFEE + i * 7919,
      ruleset: RULESET_ID,
      themeId: THEMES[band % THEMES.length].id,
      targetScore,
      timeLimitSeconds: timeLimit,
      moveBudget: budget ? [budget, 0] : null,  // budget constrains the player only
      obstacles: OBSTACLE_LAYOUTS[layout],
      ai: { skill: aiSkill },
      mechanics: mechanicsFor(band, layout, timeLimit, budget),
      par: { winBy: mastery ? 3 : 2, underSeconds: timeLimit ? Math.round(timeLimit * 0.8) : 120 },
      mastery,
      tutorialFlags: i === 0 ? ['move', 'strike'] : [],
    });
  }
  return stages;
}

function stageName(i, mastery) {
  const names = [
    'First Light', 'Open Ice', 'Centre Pillar', 'Twin Gates', 'Diamond Drift', 'Crossfire', 'Hive Mind', 'Mastery: Dawn',
    'Low Orbit', 'Quick Strike', 'Pillar Run', 'Gate Crash', 'Sharp Angles', 'Hot Cross', 'Deep Hive', 'Mastery: Flux',
    'Cold Start', 'Ninety Seconds', 'Clock Watcher', 'Gated Sprint', 'Diamond Sprint', 'Timed Cross', 'Hive Sprint', 'Mastery: Surge',
    'Lean Budget', 'Measured Play', 'Frugal Gates', 'Cheap Diamonds', 'Thin Ice', 'Economy Cross', 'Hive Thrift', 'Mastery: Ledger',
    'Full Press', 'Endgame Lights', 'Pillar Master', 'Gate Master', 'Diamond Master', 'Cross Master', 'Hive Master', 'Mastery: Apex',
  ];
  return mastery ? names[i] : names[i];
}

function mechanicsFor(band, layout, timeLimit, budget) {
  const m = ['strike', 'defend'];
  if (layout !== 'none') m.push('obstacles');
  if (timeLimit) m.push('time-pressure');
  if (budget) m.push('move-budget');
  if (band >= 4) m.push('combined');
  return m;
}

export const JOURNEY = buildJourney();

// ---------------------------------------------------------------------------
// Learn: interactive lessons; each requires the player to perform the action.
// Goals are evaluated against live rules state by the tutorial controller.
// ---------------------------------------------------------------------------

export const LESSONS = [
  {
    id: 'learn-move', title: 'Move the mallet',
    text: 'Drag (or use the arrow keys) to move your glowing mallet anywhere in your half. Move it 40 units to continue.',
    goal: { kind: 'travel', amount: 40 },
    setup: {},
  },
  {
    id: 'learn-strike', title: 'Strike the puck',
    text: 'Push your mallet into the puck to strike it toward the far goal.',
    goal: { kind: 'strike' },
    setup: { puck: { x: 50, y: 70 } },
  },
  {
    id: 'learn-defend', title: 'Defend your goal',
    text: 'The puck is coming at your goal. Block it — do not let it in for 6 seconds.',
    goal: { kind: 'survive', ticks: 360 },
    setup: { puck: { x: 50, y: 120, vx: 12, vy: -110 } },
  },
  {
    id: 'learn-score', title: 'Score a goal',
    text: 'Score in the glowing goal at the far end. Use the rails for bank shots.',
    goal: { kind: 'goal' },
    setup: {},
  },
  {
    id: 'learn-rails', title: 'Use the rails',
    text: 'Bounce the puck off a side rail before it reaches the far half.',
    goal: { kind: 'wall-then-cross' },
    setup: { puck: { x: 30, y: 60 } },
  },
  {
    id: 'learn-match', title: 'Play a short match',
    text: 'First to 2 goals wins. Put it all together.',
    goal: { kind: 'match', targetScore: 2 },
    setup: { match: true },
  },
];

// ---------------------------------------------------------------------------
// Challenge modes: constrained goals. All deterministic and seeded.
// ---------------------------------------------------------------------------

export const CHALLENGES = [
  {
    id: 'ch-blitz', name: 'Blitz Clock', version: CONTENT_VERSION,
    description: 'Win 3–0 before the 60-second clock runs out.',
    seed: 0xB1172, targetScore: 3, timeLimitSeconds: 60, overtime: false,
    obstacles: OBSTACLE_LAYOUTS.none, ai: { skill: 0.45 }, themeId: 'solar-foundry',
    constraint: 'speed',
  },
  {
    id: 'ch-ledger', name: 'Tight Ledger', version: CONTENT_VERSION,
    description: 'Your mallet has a travel budget of 1500 units. Win 2–0 before it runs dry.',
    seed: 0x1ED6E2, targetScore: 2, timeLimitSeconds: 0,
    moveBudget: [1500, 0], obstacles: OBSTACLE_LAYOUTS.none, ai: { skill: 0.3 },
    themeId: 'glacier-line', constraint: 'budget',
  },
  {
    id: 'ch-pinball', name: 'Pinball Hive', version: CONTENT_VERSION,
    description: 'A crowded hive of bumpers. First to 4 in the chaos.',
    seed: 0x9BA11, targetScore: 4, timeLimitSeconds: 0,
    obstacles: OBSTACLE_LAYOUTS.hive, ai: { skill: 0.55 }, themeId: 'verdant-grid',
    constraint: 'layout',
  },
  {
    id: 'ch-shutout', name: 'Perfect Wall', version: CONTENT_VERSION,
    description: 'Win 3–0: any conceded goal ends the run.',
    seed: 0x5EED5, targetScore: 3, timeLimitSeconds: 0, shutout: true,
    obstacles: OBSTACLE_LAYOUTS.none, ai: { skill: 0.5 }, themeId: 'violet-abyss',
    constraint: 'shutout',
  },
  {
    id: 'ch-marathon', name: 'Long Night', version: CONTENT_VERSION,
    description: 'First to 9 against a sharp opponent. Stamina test.',
    seed: 0xAA7700, targetScore: 9, timeLimitSeconds: 0,
    obstacles: OBSTACLE_LAYOUTS.pillars, ai: { skill: 0.75 }, themeId: 'neon-dusk',
    constraint: 'endurance',
  },
  {
    id: 'ch-gates', name: 'Needle Gates', version: CONTENT_VERSION,
    description: 'Narrow gate bumpers guard the centre. First to 5, 90 seconds max.',
    seed: 0x6A7E5, targetScore: 5, timeLimitSeconds: 90,
    obstacles: OBSTACLE_LAYOUTS.gates, ai: { skill: 0.6 }, themeId: 'solar-foundry',
    constraint: 'layout-time',
  },
];

// ---------------------------------------------------------------------------
// Daily: one shared seed + ruleset per UTC day (immutable once published).
// ---------------------------------------------------------------------------

export function dailySeed(date = new Date()) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
  return ((y * 10000 + m * 100 + d) * 2654435761) >>> 0;
}

export function dailyKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function dailyConfig(date = new Date()) {
  const seed = dailySeed(date);
  const layouts = Object.keys(OBSTACLE_LAYOUTS);
  const layout = layouts[seed % layouts.length];
  return {
    id: `daily-${dailyKey(date)}`,
    version: CONTENT_VERSION,
    name: `Daily — ${dailyKey(date)}`,
    seed,
    ruleset: RULESET_ID,
    themeId: THEMES[seed % THEMES.length].id,
    targetScore: 5,
    timeLimitSeconds: 120,
    obstacles: OBSTACLE_LAYOUTS[layout],
    ai: { skill: 0.55 + (seed % 30) / 100 },
    moveBudget: null,
    excluded: false, // a defective day would be flagged here, never silently replaced
  };
}

// ---------------------------------------------------------------------------
// Offline content validation: legality, reachable goals, bounded duration,
// no soft locks. Run at boot in dev and in tests.
// ---------------------------------------------------------------------------

export function validateContent() {
  const problems = [];
  const seen = new Set();

  const checkObstacles = (owner, obstacles) => {
    for (const o of obstacles) {
      if (!(o.r > 0 && o.r < 20)) problems.push(`${owner}: obstacle radius out of range`);
      if (o.x < o.r || o.x > TABLE_W - o.r || o.y < o.r || o.y > TABLE_H - o.r) {
        problems.push(`${owner}: obstacle (${o.x},${o.y}) outside table`);
      }
      // Goal mouths and the centre spawn must stay reachable.
      if (Math.abs(o.x - TABLE_W / 2) < 26 && (o.y < 30 || o.y > TABLE_H - 30)) {
        problems.push(`${owner}: obstacle blocks a goal approach`);
      }
      if (Math.hypot(o.x - TABLE_W / 2, o.y - TABLE_H / 2) < o.r + 10) {
        problems.push(`${owner}: obstacle overlaps the centre spawn`);
      }
    }
  };

  for (const s of JOURNEY) {
    if (seen.has(s.id)) problems.push(`duplicate stage id ${s.id}`);
    seen.add(s.id);
    if (!(s.targetScore >= 1)) problems.push(`${s.id}: bad target score`);
    if (s.timeLimitSeconds && s.timeLimitSeconds < 30) problems.push(`${s.id}: unbounded/too-short time limit`);
    if (!THEMES.some(t => t.id === s.themeId)) problems.push(`${s.id}: unknown theme ${s.themeId}`);
    checkObstacles(s.id, s.obstacles);
  }
  for (const c of CHALLENGES) {
    if (seen.has(c.id)) problems.push(`duplicate challenge id ${c.id}`);
    seen.add(c.id);
    checkObstacles(c.id, c.obstacles);
  }
  checkObstacles('daily-sample', dailyConfig(new Date(Date.UTC(2026, 0, 1))).obstacles);
  if (LESSONS.length < 5) problems.push('not enough lessons');
  if (THEMES.length < 5) problems.push('need at least five themes');
  return problems;
}

// ---------------------------------------------------------------------------
// Achievements (stable lowercase keys, idempotent unlocks)
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = [
  { key: 'first_victory', name: 'First Victory', description: 'Win your first match.' },
  { key: 'quick_learner', name: 'Quick Learner', description: 'Complete every tutorial lesson.' },
  { key: 'streak_three', name: 'Heating Up', description: 'Win three matches in a row.' },
  { key: 'journey_mastery', name: 'Mastery Proven', description: 'Beat any Mastery stage in Journey.' },
  { key: 'century_goals', name: 'Century of Light', description: 'Score 100 goals across all play.' },
  { key: 'daily_regular', name: 'Daily Regular', description: 'Complete the Daily challenge on three different days.' },
];
