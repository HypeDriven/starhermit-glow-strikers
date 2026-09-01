// Bootstrap + state machine: boot → title → mode-select → preparing →
// countdown → active ↔ paused → resolving → results → progression.
// The only mutation path into rules state is through Session commands.

import * as rules from './rules.js';
import { Session } from './session.js';
import { createAI } from './ai.js';
import { Renderer, toWorld, QUALITY_TIERS } from './render.js';
import { UI } from './ui.js';
import { AudioEngine } from './audio.js';
import { Platform } from './platform.js?v=production-qa-1';
import { HostedClient } from './net.js?v=production-qa-1';
import {
  JOURNEY, CHALLENGES, LESSONS, dailyConfig, dailyKey, validateContent,
  themeById, CONTENT_VERSION, RULESET_ID,
} from './content.js';

const DT = rules.DT;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new Platform();
platform.load();

// Launch token: read from the URL, held in memory only, never persisted.
const launchToken = new URLSearchParams(location.search).get('token') ?? null;
if (launchToken) history.replaceState(null, '', location.pathname);

let renderer = null;
try {
  renderer = new Renderer(document.getElementById('game-canvas'), platform.settings);
} catch (e) {
  document.getElementById('screens').innerHTML =
    '<section class="screen"><div class="panel"><h1>Glow Strikers</h1>' +
    '<p>This device or browser does not support WebGL, which Glow Strikers needs for its 3D arena. ' +
    'Your local progress and settings are preserved.</p></div></section>';
  throw e;
}

const audio = new AudioEngine(platform.settings, (text) => ui.caption(text));
const ui = new UI(platform, audio);
const net = new HostedClient();

applySettings();
platform.syncTime();

ui.showBoot(20, 'Loading rules…');
const contentProblems = validateContent();
if (contentProblems.length) console.warn('content validation:', contentProblems);
ui.showBoot(50, 'Validating content…');

renderer.buildArena(platform.save.progression.cosmetics.theme);
renderer.setDebug('none');
ui.showBoot(90, 'Preparing arena…');

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const app = {
  screen: 'boot',           // boot | title | list | setup | playing | paused | results | lobby | hosted
  session: null,            // local Session when playing locally
  matchCfg: null,           // content config of the current match
  mode: null,               // learn | journey | daily | practice | challenge | hosted
  ai: null,
  paused: false,
  lesson: null,             // active tutorial lesson state
  prevPos: null,
  curPos: null,
  acc: 0,
  lastFrame: performance.now(),
  pointer: { down: false, x: 50, y: 30 },
  keyTarget: null,
  pendingAchievements: [],
  hosted: { snap: null, prev: null, away: null },
};

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

function configFromContent(c) {
  return {
    seed: c.seed,
    targetScore: c.targetScore,
    timeLimitSeconds: c.timeLimitSeconds ?? 0,
    obstacles: c.obstacles ?? [],
    moveBudget: c.moveBudget ?? null,
    overtime: c.overtime !== false,
  };
}

function startMatch(contentCfg, mode, meta = {}) {
  app.matchCfg = contentCfg;
  app.mode = mode;
  app.session = new Session(configFromContent(contentCfg), {
    mode, contentId: contentCfg.id, ruleset: RULESET_ID, contentVersion: contentCfg.version ?? CONTENT_VERSION,
    ranked: !!meta.ranked,
  });
  app.ai = meta.noAI ? null : createAI({
    skill: contentCfg.ai?.skill ?? 0.5, player: 1, seed: contentCfg.seed,
  });
  app.lesson = meta.lesson ?? null;
  if (app.lesson) setupLesson(app.lesson);
  app.paused = false;
  app.acc = 0;
  app.prevPos = app.curPos = snapshotPositions(app.session.state);
  app.keyTarget = null;

  renderer.buildArena(contentCfg.themeId ?? platform.save.progression.cosmetics.theme, contentCfg.obstacles ?? []);
  renderer.transitionToPlay();
  ui.hideScreens();
  ui.showHud(true);
  ui.setScores(0, 0);
  ui.setUndoVisible(mode === 'practice' || mode === 'learn');
  ui.setBudget(app.session.state.moveBudget ? `Budget ${Math.round(app.session.state.moveBudget[0])} u` : null);
  setObjective();
  ui.banner(mode === 'learn' ? app.lesson.title : contentCfg.name ?? 'Match', false);
  audio.ensure();
  audio.startMusic();
  platform.track('start', { mode, content: contentCfg.id });
  platform.startPresence();
  app.screen = 'playing';
}

function setObjective() {
  const s = app.session?.state;
  if (!s) return;
  if (app.mode === 'learn') { ui.setObjective(app.lesson.text); return; }
  const parts = [`First to ${s.targetScore}`];
  if (s.timeLimitTicks) parts.push(`beat the clock`);
  if (app.matchCfg?.shutout) parts.push('concede nothing');
  if (s.moveBudget) parts.push('limited travel budget');
  ui.setObjective(parts.join(' · '));
}

function snapshotPositions(state) {
  return {
    puck: { x: state.puck.x, y: state.puck.y },
    mallets: [{ x: state.mallets[0].x, y: state.mallets[0].y }, { x: state.mallets[1].x, y: state.mallets[1].y }],
  };
}

function endMatch() {
  const s = app.session.state;
  const breakdown = rules.resultBreakdown(s);
  app.screen = 'results';
  audio.stopMusic();

  const won = s.winner === 0;
  const draw = s.winner === -1;
  const achievements = resolveProgression(won, draw, breakdown);
  const stars = app.mode === 'journey' && won ? computeStars(app.matchCfg, breakdown) : null;

  audio.event(won ? 'win' : draw ? 'goal' : 'lose');
  ui.announce(`${headlineFor(won, draw)}. Final score ${s.scores[0]} to ${s.scores[1]}.`, true);
  platform.persist();

  const nextIdx = app.mode === 'journey' ? app.matchCfg.index + 1 : -1;
  const hasNext = nextIdx >= 0 && nextIdx < JOURNEY.length && won;
  ui.showResults({
    headline: headlineFor(won, draw),
    sub: app.matchCfg.name ?? '',
    breakdown,
    names: ['You', app.matchCfg.ai ? 'AI' : 'Opponent'],
    achievements,
    stars,
    next: hasNext ? `Next: ${JOURNEY[nextIdx].name}` : null,
    canRetry: true,
  });
  platform.track('round_end', { mode: app.mode, won, reason: s.terminalReason });
}

function headlineFor(won, draw) {
  if (app.mode === 'learn') return won || draw ? 'Lesson complete' : 'Lesson ended';
  return won ? 'Victory' : draw ? 'Draw' : 'Defeat';
}

function resolveProgression(won, draw, breakdown) {
  const p = platform.save.progression;
  const unlocked = [];
  const tryUnlock = (key) => { const a = platform.unlock(key); if (a) { unlocked.push(a); audio.event('achievement'); } };

  p.totalGoals += breakdown.players[0].goals;
  if (p.totalGoals >= 100) tryUnlock('century_goals');

  if (app.mode === 'learn') return unlocked; // lessons handle their own marking

  if (won) {
    p.wins++;
    p.currentStreak++;
    p.bestStreak = Math.max(p.bestStreak, p.currentStreak);
    tryUnlock('first_victory');
    if (p.currentStreak >= 3) tryUnlock('streak_three');
  } else if (!draw) {
    p.losses++;
    p.currentStreak = 0;
  }

  const s = app.session.state;
  const base = {
    ruleset: RULESET_ID, contentVersion: CONTENT_VERSION, seed: s.seed,
    assists: platform.settings.timingAssist ? ['timing'] : [],
    durationTicks: s.activeTicks, name: 'You',
  };

  if (app.mode === 'journey' && won) {
    if (!p.journeyCompleted.includes(app.matchCfg.id)) p.journeyCompleted.push(app.matchCfg.id);
    const stars = computeStars(app.matchCfg, breakdown);
    p.journeyStars[app.matchCfg.id] = Math.max(p.journeyStars[app.matchCfg.id] ?? 0, stars);
    if (app.matchCfg.mastery) {
      tryUnlock('journey_mastery');
      platform.submitResult('journey', { ...base, boardKey: 'mastery', score: stars * 1000 - Math.round(s.activeTicks / 60) });
    }
  }
  if (app.mode === 'daily' && !draw) {
    const key = dailyKey(platform.now());
    if (won && !p.dailyDays.includes(key)) {
      p.dailyDays.push(key);
      if (p.dailyDays.length >= 3) tryUnlock('daily_regular');
    }
    platform.submitResult('daily', { ...base, boardKey: key, score: s.scores[0] * 10 - s.scores[1] });
  }
  if (app.mode === 'challenge' && won) {
    if (!p.challengesDone.includes(app.matchCfg.id)) p.challengesDone.push(app.matchCfg.id);
    platform.submitResult('challenge', { ...base, boardKey: app.matchCfg.id, score: s.scores[0] * 10 - s.scores[1] });
  }
  return unlocked;
}

function computeStars(cfg, breakdown) {
  let stars = 1;
  const s = app.session.state;
  if (s.scores[0] - s.scores[1] >= (cfg.par?.winBy ?? 2)) stars++;
  if (!cfg.timeLimitSeconds || s.activeTicks / 60 <= (cfg.par?.underSeconds ?? 120)) stars++;
  return stars;
}

// ---------------------------------------------------------------------------
// Tutorial lessons
// ---------------------------------------------------------------------------

function setupLesson(lesson) {
  const s = app.session.state;
  app.lessonState = { travel: 0, survived: 0, sawWall: false, done: false, lastX: s.mallets[0].x, lastY: s.mallets[0].y };
  const setup = lesson.setup ?? {};
  if (setup.puck) Object.assign(s.puck, setup.puck);
  if (lesson.goal.kind === 'match') {
    s.targetScore = lesson.goal.targetScore;
    app.ai = createAI({ skill: 0.25, player: 1, seed: s.seed });
  } else {
    app.ai = null;
    s.targetScore = 99; // lessons end via their goal, not the score
  }
}

function updateLesson(evts) {
  const L = app.lesson, ls = app.lessonState, s = app.session.state;
  if (!L || ls.done) return;
  const m = s.mallets[0];
  ls.travel += Math.hypot(m.x - ls.lastX, m.y - ls.lastY);
  ls.lastX = m.x; ls.lastY = m.y;

  let done = false, failed = false;
  switch (L.goal.kind) {
    case 'travel': done = ls.travel >= L.goal.amount; break;
    case 'strike': done = evts.some(e => e.type === 'strike' && e.player === 0); break;
    case 'survive':
      ls.survived = s.activeTicks;
      done = ls.survived >= L.goal.ticks;
      failed = evts.some(e => e.type === 'goal' && e.scorer === 1);
      ui.setObjective(`${L.text} (${Math.max(0, Math.ceil((L.goal.ticks - ls.survived) / 60))}s left)`);
      break;
    case 'goal': done = evts.some(e => e.type === 'goal' && e.scorer === 0); break;
    case 'wall-then-cross': {
      if (evts.some(e => e.type === 'wall')) ls.sawWall = true;
      if (ls.sawWall && s.puck.y > rules.TABLE_H / 2 && s.puck.vy > 0) done = true;
      break;
    }
    case 'match': done = s.phase === rules.PHASE.TERMINAL; break;
  }

  if (failed) {
    ls.done = true;
    ui.banner('Try again', true);
    setTimeout(() => startLesson(L), 1200);
    return;
  }
  if (done && L.goal.kind !== 'match') {
    ls.done = true;
    completeLesson(L);
  } else if (done && L.goal.kind === 'match') {
    completeLesson(L); // match lesson resolves through normal results too
  }
}

function completeLesson(lesson) {
  const p = platform.save.progression;
  if (!p.lessonsDone.includes(lesson.id)) {
    p.lessonsDone.push(lesson.id);
    platform.persist();
  }
  platform.track('tutorial_step', { id: lesson.id });
  if (LESSONS.every(l => p.lessonsDone.includes(l.id))) {
    platform.settings.tutorialDone = true;
    const a = platform.unlock('quick_learner');
    if (a) ui.toast(`Achievement: ${a.name}`);
  }
  if (lesson.goal.kind !== 'match') {
    ui.banner('Lesson complete!', true);
    audio.event('win');
    setTimeout(() => {
      const idx = LESSONS.indexOf(lesson);
      const next = LESSONS[idx + 1];
      ui.showResults({
        headline: 'Lesson complete',
        sub: lesson.title,
        breakdown: rules.resultBreakdown(app.session.state),
        names: ['You', '—'],
        next: next ? `Next: ${next.title}` : null,
      });
      app.screen = 'results';
    }, 900);
  }
}

// ---------------------------------------------------------------------------
// Input: pointer, keyboard, gamepad
// ---------------------------------------------------------------------------

const canvas = renderer.canvas;

function inputAllowed() {
  return (app.screen === 'playing' && !app.paused) || app.screen === 'hosted';
}

canvas.addEventListener('pointerdown', (e) => {
  if (!inputAllowed()) return;
  audio.ensure();
  canvas.setPointerCapture(e.pointerId);
  app.pointer.down = true;
  pointerMove(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (!inputAllowed()) return;
  if (!app.pointer.down && (platform.settings.holdToAim || e.pointerType !== 'mouse')) return;
  pointerMove(e);
});
function pointerMove(e) {
  const r = canvas.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
  const hit = renderer.pick(nx, ny);
  if (!hit) return;
  app.pointer.x = hit.x; app.pointer.y = hit.y;
  issueMove(0, hit.x, hit.y);
  renderer.showTargetMarker(hit.x, hit.y, app.pointer.down);
}
canvas.addEventListener('pointerup', (e) => {
  app.pointer.down = false;
  renderer.showTargetMarker(0, 0, false);
});
canvas.addEventListener('lostpointercapture', () => {
  app.pointer.down = false;
  renderer.showTargetMarker(0, 0, false);
});

const keysHeld = new Set();
window.addEventListener('keydown', (e) => {
  const k = platform.settings.keys;
  if (e.code === k.pause) {
    e.preventDefault();
    if (app.screen === 'playing') pauseGame();
    else if (app.screen === 'paused') resumeGame();
    return;
  }
  if (app.screen === 'hosted') {
    // hosted: keyboard/gamepad input allowed; undo/camera/hint handled below
  } else if (app.screen !== 'playing' || app.paused) return;
  if (e.code === k.undo) { doUndo(); return; }
  if (e.code === k.camera) { renderer.transitionToPlay(); return; }
  if (e.code === k.hint) { giveHint(); return; }
  if ([k.up, k.down, k.left, k.right].includes(e.code)) {
    e.preventDefault();
    keysHeld.add(e.code);
    if (!app.keyTarget && app.session) {
      app.keyTarget = { x: app.session.state.mallets[0].x, y: app.session.state.mallets[0].y };
    }
  }
});
window.addEventListener('keyup', (e) => keysHeld.delete(e.code));
window.addEventListener('blur', () => keysHeld.clear());

function currentMalletPos() {
  if (app.session) return app.session.state.mallets[0];
  if (net.snap) return net.snap.mallets[net.seat];
  return null;
}

function keyboardStep() {
  if (!keysHeld.size) return;
  const k = platform.settings.keys;
  const moves = [k.up, k.down, k.left, k.right];
  if (!moves.some(c => keysHeld.has(c))) return;
  if (!app.keyTarget) {
    const m = currentMalletPos();
    if (!m) return;
    app.keyTarget = { x: m.x, y: m.y };
  }
  const speed = 140 * DT;
  if (keysHeld.has(k.up)) app.keyTarget.y += speed;
  if (keysHeld.has(k.down)) app.keyTarget.y -= speed;
  if (keysHeld.has(k.left)) app.keyTarget.x -= speed;
  if (keysHeld.has(k.right)) app.keyTarget.x += speed;
  issueMove(0, app.keyTarget.x, app.keyTarget.y);
  renderer.showTargetMarker(app.keyTarget.x, app.keyTarget.y, true);
}

let padPrev = {};
function gamepadStep() {
  const gp = navigator.getGamepads?.()[0];
  if (!gp) return;
  const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
  if (Math.abs(ax) > 0.15 || Math.abs(ay) > 0.15) {
    if (!app.keyTarget) {
      const m = currentMalletPos();
      if (m) app.keyTarget = { x: m.x, y: m.y };
    }
    if (app.keyTarget) {
      app.keyTarget.x += ax * 140 * DT;
      app.keyTarget.y += ay * 140 * DT;
      issueMove(0, app.keyTarget.x, app.keyTarget.y);
    }
  }
  const start = gp.buttons[9]?.pressed;
  if (start && !padPrev.start && app.screen === 'playing') pauseGame();
  padPrev.start = start;
}

function issueMove(player, x, y) {
  if (app.mode === 'hosted') { net.sendInput(x, y); return; }
  const res = app.session?.move(player, x, y);
  if (res && !res.ok && res.reason !== 'duplicate') {
    if (res.reason === 'move-budget-exhausted') {
      ui.caption('Move budget exhausted');
      audio.event('invalid');
    }
  }
}

function giveHint() {
  const s = app.session?.state;
  if (!s) return;
  const legal = rules.legalActions(s, 0);
  if (!legal.actions.length) { ui.caption('No legal moves right now.'); return; }
  const puck = s.puck;
  const hint = puck.y < rules.TABLE_H / 2
    ? 'The puck is in your half — meet it with your mallet to strike.'
    : 'The puck is away. Guard your goal and track the puck.';
  ui.caption(hint);
  ui.announce(hint, false);
}

// ---------------------------------------------------------------------------
// Pause / resume / visibility
// ---------------------------------------------------------------------------

function pauseGame() {
  if (app.screen !== 'playing') return;
  if (app.mode === 'hosted') return; // hosted clock is authoritative; use lobby to leave
  app.paused = true;
  app.screen = 'paused';
  ui.showPause(`${app.matchCfg.name ?? 'Match'} — ${app.mode}`);
}

function resumeGame() {
  app.paused = false;
  app.screen = 'playing';
  ui.hideScreens();
  ui.showHud(true);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (app.screen === 'playing' && app.mode !== 'hosted') pauseGame(); // backgrounding pauses solo sim
    audio.suspend();
  } else {
    audio.ensure();
  }
});

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function doUndo() {
  if (!(app.mode === 'practice' || app.mode === 'learn')) return;
  if (app.session?.undo()) {
    app.prevPos = app.curPos = snapshotPositions(app.session.state);
    ui.setScores(app.session.state.scores[0], app.session.state.scores[1]);
    ui.caption('Undone');
  } else {
    ui.caption('Nothing to undo');
  }
}

// ---------------------------------------------------------------------------
// Main loop: fixed-step simulation + interpolated rendering
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - app.lastFrame) / 1000);
  app.lastFrame = now;

  if (app.screen === 'playing' && !app.paused && app.session) {
    const speed = platform.settings.timingAssist && app.mode !== 'hosted' ? 0.85 : 1;
    app.acc += dt * speed;
    let events = [];
    while (app.acc >= DT) {
      app.acc -= DT;
      keyboardStep();
      gamepadStep();
      if (app.ai) {
        const t = app.ai.update(app.session.state);
        if (t) app.session.move(1, t.x, t.y);
      }
      app.prevPos = app.curPos;
      app.session.tick();
      app.curPos = snapshotPositions(app.session.state);
      events = app.session.drainEvents();
      if (events.length) handleEvents(events);
      if (app.lesson && !app.lessonState.done) updateLesson(events);
    }
    updateHud();
  } else if (app.mode === 'hosted' && net.snap) {
    // Hosted: inputs stream to the authoritative server; we interpolate
    // between the last two snapshots it broadcasts.
    keyboardStep();
    gamepadStep();
    app.prevPos = net.prevSnap ? posFromSnap(net.prevSnap) : posFromSnap(net.snap);
    app.curPos = posFromSnap(net.snap);
    const interval = net.snapshotInterval();
    app.acc = Math.min(interval, performance.now() - net.snapAt) / interval;
  }

  const alpha = app.session ? app.acc / DT : app.acc;
  if (app.curPos) {
    renderer.render(dt, app.prevPos, app.curPos, Math.min(1, Math.max(0, alpha)), app.session?.state ?? null);
    if (app.session?.state) {
      const p = app.session.state.puck;
      audio.setMusicIntensity(Math.min(1, Math.hypot(p.vx, p.vy) / 220));
    }
  }
  updateBoardState(now);
}

function posFromSnap(snap) {
  return { puck: { ...snap.puck }, mallets: [{ ...snap.mallets[0] }, { ...snap.mallets[1] }] };
}

function handleEvents(events) {
  const s = app.session.state;
  for (const e of events) {
    switch (e.type) {
      case 'countdown':
        ui.banner(String(e.remaining));
        audio.event('countdown', { remaining: e.remaining });
        break;
      case 'serve': ui.banner('GO'); audio.event('go'); break;
      case 'strike': {
        const [wx, wz] = toWorld(s.puck.x, s.puck.y);
        renderer.feedback('strike', { x: wx, y: 0, z: wz }, 2);
        audio.event('strike', { speed: e.speed });
        vibrate(8);
        break;
      }
      case 'wall': {
        const [wx, wz] = toWorld(e.x, e.y);
        renderer.feedback('wall', { x: wx, y: 0, z: wz }, 1);
        audio.event('wall');
        break;
      }
      case 'obstacle': {
        const [wx, wz] = toWorld(e.x, e.y);
        renderer.feedback('obstacle', { x: wx, y: 0, z: wz }, 2);
        audio.event('obstacle');
        break;
      }
      case 'goal': {
        const side = e.scorer === 0 ? 1 : 0; // scored in the far goal for scorer 0
        const [wx, wz] = toWorld(rules.TABLE_W / 2, side === 1 ? rules.TABLE_H : 0);
        renderer.feedback('goal', { x: wx, y: 0, z: wz }, 3);
        audio.event('goal', { scorer: e.scorer });
        ui.setScores(e.scores[0], e.scores[1]);
        ui.banner(e.scorer === 0 ? 'GOAL!' : 'Conceded', true);
        vibrate(e.scorer === 0 ? [30, 40, 30] : 60);
        if (app.matchCfg?.shutout && e.scorer === 1 && app.mode === 'challenge') {
          app.session.forfeit(0); // perfect-wall constraint violated
        }
        break;
      }
      case 'overtime': ui.banner('OVERTIME'); audio.event('overtime'); break;
      case 'budget-exhausted':
        if (e.player === 0) { ui.caption('Move budget exhausted — defend with what you have'); audio.event('budget'); }
        break;
      case 'terminal':
        renderer.feedback('terminal', null, 4);
        endMatch();
        break;
    }
  }
}

function updateHud() {
  const s = app.session?.state;
  if (!s) return;
  const ticks = s.timeLimitTicks && !s.inOvertime
    ? Math.max(0, s.timeLimitTicks - s.activeTicks)
    : s.activeTicks;
  const sec = Math.floor(ticks / 60);
  ui.setClock(s.inOvertime ? 'OT' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
  if (s.moveBudget) ui.setBudget(`Budget ${Math.round(s.moveBudget[0])} u`);
  ui.setScores(s.scores[0], s.scores[1]);
}

let lastBoardUpdate = 0;
function updateBoardState(now) {
  if (now - lastBoardUpdate < 500) return;
  lastBoardUpdate = now;
  const panel = document.getElementById('boardstate-panel');
  if (panel.hidden || !app.session) return;
  const s = app.session.state;
  const dir = s.puck.vy < -10 ? 'toward your goal' : s.puck.vy > 10 ? 'toward the far goal' : 'nearly still';
  ui.setBoardState(
    `Score: you ${s.scores[0]}, opponent ${s.scores[1]}. ` +
    `Puck at column ${Math.round(s.puck.x)} of 100, row ${Math.round(s.puck.y)} of 200, moving ${dir} ` +
    `at ${Math.round(Math.hypot(s.puck.vx, s.puck.vy))} units per second. ` +
    `Your mallet at column ${Math.round(s.mallets[0].x)}, row ${Math.round(s.mallets[0].y)}.`
  );
}

function vibrate(pattern) {
  if (platform.settings.haptics) navigator.vibrate?.(pattern);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const difficultyPresets = [
  { name: 'Relaxed', skill: 0.25 }, { name: 'Club', skill: 0.5 }, { name: 'Pro', skill: 0.75 }, { name: 'Legend', skill: 0.92 },
];
let pendingPractice = difficultyPresets[1];

function goTitle() {
  app.screen = 'title';
  app.mode = null;
  app.session = null;
  app.lesson = null;
  app.paused = false;
  audio.stopMusic();
  ui.showHud(false);
  ui.showTitle();
  renderer.buildArena(platform.save.progression.cosmetics.theme);
}

function startLesson(lesson) {
  startMatch(
    { id: lesson.id, name: lesson.title, seed: 0x1EA22 + LESSONS.indexOf(lesson), targetScore: 99, obstacles: [], themeId: 'neon-dusk', ai: null },
    'learn',
    { lesson, noAI: true },
  );
}

ui.on('quick-play', () => {
  const cfg = {
    id: 'quick', name: 'Quick Match', seed: (Math.random() * 2 ** 31) >>> 0,
    targetScore: 5, timeLimitSeconds: 0, obstacles: [], ai: { skill: 0.5 },
    themeId: platform.save.progression.cosmetics.theme,
  };
  ui.showSetup({
    title: 'Quick Match', description: 'First to 5 against a Club-strength opponent. Unranked.',
    targetScore: 5, timeLimitSeconds: 0, ranked: false, players: '1 vs AI',
    content: cfg,
  });
});
ui.on('start-daily', () => {
  const d = dailyConfig(platform.now());
  const secs = platform.secondsUntilNextDaily();
  ui.showSetup({
    title: d.name,
    description: `One shared seed for everyone today. Ranked. Next daily in ${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m${platform.timeSynced ? '' : ' (clock unsynced)'}.`,
    targetScore: d.targetScore, timeLimitSeconds: d.timeLimitSeconds, ranked: true, players: '1 vs AI',
    content: d,
  });
});
ui.on('show-journey', () => ui.showJourney());
ui.on('show-challenges', () => ui.showChallenges());
ui.on('show-learn', () => ui.showLearn());
ui.on('show-practice', () => {
  ui.showSetup({
    title: 'Practice',
    description: 'Unranked. Restart and undo freely; no effect on rating.',
    targetScore: 5, timeLimitSeconds: 0, ranked: false, players: '1 vs AI',
    extras: (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-row';
      const label = document.createElement('label');
      label.textContent = 'Difficulty';
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Difficulty');
      difficultyPresets.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = d.name;
        if (i === 1) o.selected = true;
        sel.append(o);
      });
      sel.addEventListener('change', () => (pendingPractice = difficultyPresets[Number(sel.value)]));
      wrap.append(label, sel);
      return wrap;
    })(),
    content: null, // built at begin
  });
});
ui.on('start-journey', (stage) => {
  ui.showSetup({
    title: `Stage ${stage.index + 1}: ${stage.name}`,
    description: `${stage.mechanics.join(', ')}. ${stage.mastery ? 'Mastery stage — posts to the leaderboard.' : ''}`.trim(),
    targetScore: stage.targetScore, timeLimitSeconds: stage.timeLimitSeconds, ranked: stage.mastery, players: '1 vs AI',
    content: stage,
  });
});
ui.on('start-challenge', (c) => {
  ui.showSetup({
    title: c.name, description: c.description,
    targetScore: c.targetScore, timeLimitSeconds: c.timeLimitSeconds ?? 0, ranked: true, players: '1 vs AI',
    content: c,
  });
});
ui.on('start-lesson', (lesson) => startLesson(lesson));

ui.on('begin', (cfg) => {
  let content = cfg.content;
  if (!content) {
    content = {
      id: 'practice', name: `Practice — ${pendingPractice.name}`, seed: (Math.random() * 2 ** 31) >>> 0,
      targetScore: 5, timeLimitSeconds: 0, obstacles: [], ai: { skill: pendingPractice.skill },
      themeId: platform.save.progression.cosmetics.theme, version: CONTENT_VERSION,
    };
  }
  startMatch(content, modeOf(content, cfg));
});

function modeOf(content, cfg) {
  if (content.id === 'practice' || content.id === 'quick') return 'practice';
  if (content.id?.startsWith('j')) return 'journey';
  if (content.id?.startsWith('daily')) return 'daily';
  if (content.id?.startsWith('ch-')) return 'challenge';
  return 'practice';
}

ui.on('back', () => goTitle());
ui.on('pause', () => pauseGame());
ui.on('resume', () => resumeGame());
ui.on('restart', () => startMatch(app.matchCfg, app.mode, { lesson: app.lesson, noAI: app.mode === 'learn' }));
ui.on('retry', () => {
  platform.track('retry', { content: app.matchCfg?.id });
  startMatch(app.matchCfg, app.mode, { lesson: app.lesson, noAI: app.mode === 'learn' });
});
ui.on('next', () => {
  if (app.mode === 'learn') {
    const idx = LESSONS.indexOf(app.lesson);
    if (LESSONS[idx + 1]) return startLesson(LESSONS[idx + 1]);
    return goTitle();
  }
  if (app.mode === 'journey' && app.matchCfg.index + 1 < JOURNEY.length) {
    return ui.emit('start-journey', JOURNEY[app.matchCfg.index + 1]) ?? ui.showJourney();
  }
  goTitle();
});
ui.on('leave', () => {
  if (app.mode === 'hosted') net.leave();
  goTitle();
});
ui.on('undo', () => doUndo());

ui.on('show-settings', (opts) => ui.showSettings(opts ?? {}));
ui.on('settings-back', (opts) => {
  applySettings();
  if (opts?.from === 'pause') ui.showPause(app.matchCfg?.name ?? 'Match');
  else goTitle();
});
ui.on('show-help', (opts) => ui.showHelp(opts ?? {}));
ui.on('help-back', (opts) => {
  if (opts?.from === 'pause') ui.showPause(app.matchCfg?.name ?? 'Match');
  else goTitle();
});
ui.on('show-achievements', () => ui.showAchievements());
ui.on('show-leaderboard', () => {
  ui.showLeaderboard(
    platform.getBoard('daily', dailyKey(platform.now())),
    platform.getBoard('journey'),
  );
});
ui.on('replay-tutorial', () => ui.showLearn());
ui.on('settings-changed', () => applySettings());

function applySettings() {
  const s = platform.settings;
  document.body.classList.toggle('reduced-motion', s.reducedMotion);
  document.body.classList.toggle('high-contrast', s.highContrast);
  document.body.classList.remove('palette-deuteranopia', 'palette-protanopia', 'palette-tritanopia');
  if (s.palette !== 'default') document.body.classList.add(`palette-${s.palette}`);
  document.documentElement.style.setProperty('--text-scale', s.textScale);
  audio.applyVolumes();
  if (s.quality !== 'auto') renderer.setQuality(s.quality);
}

// ---------------------------------------------------------------------------
// Hosted play
// ---------------------------------------------------------------------------

const lobby = { chat: [], status: 'Connect to create or join a room.', roomCode: null, players: [], canStartAI: false };

function refreshLobby() {
  ui.showLobby({
    status: lobby.status,
    roomCode: lobby.roomCode,
    players: lobby.players,
    chat: lobby.chat.slice(-30),
    canStartAI: lobby.canStartAI,
  });
}

ui.on('show-lobby', async () => {
  app.screen = 'lobby';
  lobby.status = 'Connecting…';
  refreshLobby();
  try {
    await net.connect();
    lobby.status = 'Connected. Create a room or join with a code.';
  } catch {
    lobby.status = 'No host server reachable. Run `node server.js` and reload, or play solo modes.';
  }
  refreshLobby();
});
ui.on('lobby-create', () => { net.name = 'You'; net.createRoom(); });
ui.on('lobby-join', (code) => { if (code) net.joinRoom(code); });
ui.on('lobby-start-ai', () => net.startVsAI());
ui.on('lobby-leave', () => { net.leave(); lobby.roomCode = null; lobby.players = []; goTitle(); });
ui.on('lobby-chat', (text) => net.sendChat(text));

net.on('created', (m) => {
  lobby.roomCode = m.room;
  lobby.players = ['You (seat 1)', '— waiting —'];
  lobby.canStartAI = true;
  lobby.status = 'Room created. Share the code, or start against the AI.';
  refreshLobby();
});
net.on('joined', (m) => {
  lobby.roomCode = m.room;
  lobby.players = ['Host (seat 1)', 'You (seat 2)'];
  lobby.status = 'Joined. Waiting for the match to start…';
  refreshLobby();
});
net.on('peer-joined', (m) => {
  lobby.players = ['You (seat 1)', `${m.name} (seat 2)`];
  lobby.canStartAI = false;
  lobby.status = `${m.name} joined. Match starting…`;
  if (app.screen === 'lobby') refreshLobby();
});
net.on('peer-left', () => {
  if (app.screen === 'hosted') ui.toast('Opponent disconnected — they have 30s to return.');
});
net.on('peer-abandoned', () => ui.toast('Opponent left the match.'));
net.on('error', (m) => { lobby.status = `Error: ${m.error}`; if (app.screen === 'lobby') refreshLobby(); });
net.on('reconnecting', (m) => ui.toast(`Reconnecting (attempt ${m.attempt})…`));
net.on('resumed', () => {
  const away = net.takeAwaySummary();
  if (away) ui.toast(away); // "while you were away" summary
});
net.on('chat', (m) => {
  lobby.chat.push(m);
  if (app.screen === 'lobby') refreshLobby();
  else ui.toast(`${m.from}: ${m.text.slice(0, 60)}`);
});
net.on('start', (m) => {
  app.mode = 'hosted';
  app.session = null;
  app.matchCfg = { id: `hosted-${net.room}`, name: `Hosted · Room ${net.room}`, seed: m.seed, targetScore: 5 };
  app.screen = 'hosted';
  app.acc = 0;
  renderer.buildArena(platform.save.progression.cosmetics.theme, []);
  renderer.transitionToPlay();
  ui.hideScreens();
  ui.showHud(true);
  ui.setScores(0, 0);
  ui.setObjective('First to 5 · hosted · server-authoritative');
  audio.ensure();
  audio.startMusic();
});
net.onSnapshot = (snap, prev) => {
  if (app.screen !== 'hosted') return;
  ui.setScores(snap.scores[0], snap.scores[1]);
  const sec = Math.floor(snap.tick / 60);
  ui.setClock(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
};
net.on('result', (m) => {
  app.screen = 'results';
  audio.stopMusic();
  const b = m.result.breakdown;
  const me = net.seat, opp = 1 - net.seat;
  const won = b.winner === me;
  audio.event(won ? 'win' : 'lose');
  ui.showResults({
    headline: won ? 'Victory' : b.winner === -1 ? 'Draw' : 'Defeat',
    sub: `Hosted room ${net.room} · authoritative hash ${m.result.finalHash}`,
    breakdown: { ...b, players: [b.players[me], b.players[opp]] },
    names: ['You', 'Opponent'],
    canRetry: false,
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

ui.showBoot(100, 'Ready');
goTitle();
requestAnimationFrame(frame);

// Debug/testing hook (no gameplay privileges — read and scripted-input only).
window.__gs = { app, platform, rules, ui, net };
