/**
 * Glow Strikers — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome). Flow per pass:
 *   title → Journey (40 stages, stage 1 unlocked) → stage 1 setup → Start →
 *   countdown → a full match played through real pointer movement over the
 *   canvas (the game's primary input: hover/drag moves the mallet) until the
 *   results screen with its stats breakdown → progression persistence check.
 * The desktop pass also covers Practice (undo via the Z binding + the HUD
 * button, hint via H), the board-state narration panel, pause/resume (both
 * Esc and the HUD pause button), settings open/change/close from pause, and
 * the Hosted Play lobby's graceful offline fallback.
 *
 * How play works: a calibration scan probes screen points and reads back the
 * world coordinates the game itself reports (window.__gs.app.pointer, set by
 * the game's own pointer handler) to fit an affine world→screen map; the play
 * loop then reads window.__gs.app.session.state (puck/mallet positions — used
 * only for aiming and timing, like a player watching the arena) and issues
 * real page.mouse moves, which the game raycasts back into mallet commands.
 * No internal mutating API is ever called.
 *
 * Two passes: desktop 1280x800, then a fresh context at mobile 390x844 with
 * touch enabled. Both must pass. Fails loudly on any non-benign console
 * error / pageerror.
 *
 * Self-contained: embeds a minimal static server on an ephemeral port, plus
 * stubs for the two benign endpoints the client polls (GET /api/v1/time,
 * POST /api/v1/presence). The repo's server.js is the StarHermit
 * authoritative game server and is intentionally NOT spawned; hosted play is
 * therefore covered only up to the lobby's offline fallback message, and the
 * resulting expected WebSocket handshake console error is filtered via
 * wsOfflineNoise (see header of tools/production_game_audit.mjs for the
 * browserNoise provenance).
 *
 * Note: journey stage 1 has no clock, so the scripted player deliberately
 * plays an aggressive, leaky defensive game, and if no goal is scored for 45s
 * it shades one side of its goal until the deadlock breaks — matches reliably
 * reach a terminal score instead of stalemating. The final score is logged
 * but any outcome (win or loss) satisfies the playthrough.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

// Benign GPU/swiftshader noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;
// Expected exactly once when the lobby probe runs without server.js.
const wsOfflineNoise = /^WebSocket connection to 'ws:\/\/localhost:\d+\/ws' failed/;

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/time') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ now: Date.now() }));
    }
    if (url.pathname === '/api/v1/presence' && req.method === 'POST') {
      res.writeHead(204);
      return res.end();
    }
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end('bad path');
    }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
}

// ---------------------------------------------------------------------------
// Play policy. Coordinates are rules.js table units: x in [0,100], y in
// [0,200]; player 0 (us) defends the y=0 goal and attacks toward y=200.
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function aimFor(st) {
  const W = 100, H = 200;
  const puck = st.puck, ai = st.ai, me = st.mallet;
  const speed = Math.hypot(puck.vx, puck.vy);
  const aimX = ai.x < W / 2 ? 66 : 34; // far corner away from the AI mallet

  // Puck heading at our goal: intercept on a fixed line, one wall bounce allowed.
  if (puck.vy < -20) {
    for (const L of [24, 13]) {
      const t = (L - puck.y) / puck.vy;
      if (t <= 0) continue;
      let x = puck.x + puck.vx * t;
      if (x < 4) x = 8 - x; else if (x > 96) x = 192 - x;
      x = clamp(x, 27, 73);
      const d = Math.hypot(x - me.x, L - me.y);
      if (d / 140 < t * 0.9 || L === 13) {
        return { x: clamp(x + (aimX > W / 2 ? -2.5 : 2.5), 25, 75), y: L };
      }
    }
  }
  // Puck loose right in front of our goal: knock it sideways, away from centre.
  if (puck.y < 18 && speed < 120) {
    return { x: clamp(puck.x + (puck.x < W / 2 ? 11 : -11), 8, 92), y: clamp(puck.y, 8, 30) };
  }
  // Puck slow and deep in our half: strike through it at the open far corner.
  if (puck.y < 50 && speed < 55) {
    if (me.y < puck.y - 2) {
      const px = puck.x + puck.vx * 0.2, py = puck.y + puck.vy * 0.2;
      let ux = aimX - px, uy = 195 - py;
      const len = Math.hypot(ux, uy) || 1;
      ux /= len; uy /= len;
      return { x: clamp(px + ux * 12, 8, 92), y: clamp(py + uy * 12, 8, 93) };
    }
    // Above the puck: swing wide to get back on the goal side of it first.
    return { x: clamp(puck.x + (puck.x < W / 2 ? 18 : -18), 8, 92), y: clamp(puck.y - 14, 8, 93) };
  }
  // Otherwise stay home and shade the puck's lane.
  return { x: clamp(W / 2 + (puck.x - W / 2) * 0.35, 32, 68), y: 12 };
}

/**
 * Fit an affine world→screen map by probing screen points with real mouse
 * moves and reading back the world coordinates from the game's own pointer
 * state. Only samples landing in our half (y <= 100) are used.
 */
async function calibrate(page, vw, vh) {
  const probe = async (sx, sy) => {
    const before = await page.evaluate(() => ({ x: window.__gs.app.pointer.x, y: window.__gs.app.pointer.y }));
    await page.mouse.move(sx, sy);
    await page.waitForTimeout(50);
    const after = await page.evaluate(() => ({ x: window.__gs.app.pointer.x, y: window.__gs.app.pointer.y }));
    if (after.x === before.x && after.y === before.y) return null; // pick ray missed the table
    return after;
  };
  const samples = [];
  for (const fy of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.88]) {
    for (const fx of [0.18, 0.34, 0.5, 0.66, 0.82]) {
      const hit = await probe(fx * vw, fy * vh);
      if (hit && hit.x >= 0 && hit.x <= 100 && hit.y >= 0 && hit.y <= 100) {
        samples.push({ sx: fx * vw, sy: fy * vh, x: hit.x, y: hit.y });
      }
    }
  }
  if (samples.length < 6) throw new Error(`calibration failed: only ${samples.length} table hits`);
  // Least-squares world = [a b c]·[sx sy 1] per axis (3-parameter Gaussian elimination).
  const lstsq = (key) => {
    let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sn = 0, Tx = 0, Ty = 0, T = 0;
    for (const p of samples) {
      Sxx += p.sx * p.sx; Sxy += p.sx * p.sy; Sx += p.sx;
      Syy += p.sy * p.sy; Sy += p.sy; Sn++;
      Tx += p[key] * p.sx; Ty += p[key] * p.sy; T += p[key];
    }
    const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, Sn]];
    const B = [Tx, Ty, T];
    for (let i = 0; i < 3; i++) {
      let piv = i;
      for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      [A[i], A[piv]] = [A[piv], A[i]]; [B[i], B[piv]] = [B[piv], B[i]];
      for (let j = i + 1; j < 3; j++) {
        const m = A[j][i] / A[i][i];
        for (let k = i; k < 3; k++) A[j][k] -= m * A[i][k];
        B[j] -= m * B[i];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s = B[i];
      for (let k = i + 1; k < 3; k++) s -= A[i][k] * x[k];
      x[i] = s / A[i][i];
    }
    return x;
  };
  const X = lstsq('x'), Y = lstsq('y');
  const det = X[0] * Y[1] - X[1] * Y[0];
  const toScreen = (wx, wy) => ({
    sx: (Y[1] * (wx - X[2]) - X[1] * (wy - Y[2])) / det,
    sy: (-Y[0] * (wx - X[2]) + X[0] * (wy - Y[2])) / det,
  });
  let maxErr = 0;
  for (const p of samples) {
    const s = toScreen(p.x, p.y);
    maxErr = Math.max(maxErr, Math.hypot(s.sx - p.sx, s.sy - p.sy));
  }
  console.log(`  calibration: ${samples.length} samples, max fit error ${maxErr.toFixed(1)}px`);
  if (maxErr > 30) throw new Error(`calibration fit too poor: ${maxErr.toFixed(1)}px`);
  return toScreen;
}

/** Play the current match via real pointer moves until the results screen. */
async function playMatch(page, toScreen, vw, vh, { maxMs = 480000 } = {}) {
  const t0 = Date.now();
  let lastLog = 0, lastScores = '0,0', lastChange = Date.now(), staleNoted = false;
  while (Date.now() - t0 < maxMs) {
    const st = await page.evaluate(() => {
      const s = window.__gs?.app?.session?.state;
      if (!s) return { screen: window.__gs?.app?.screen };
      return {
        screen: window.__gs.app.screen, phase: s.phase, scores: [...s.scores],
        winner: s.winner, tick: s.tick,
        puck: { x: s.puck.x, y: s.puck.y, vx: s.puck.vx, vy: s.puck.vy },
        mallet: { x: s.mallets[0].x, y: s.mallets[0].y },
        ai: { x: s.mallets[1].x, y: s.mallets[1].y },
      };
    });
    if (!st || st.screen === 'results' || st.phase === 'terminal') return st;
    // Stage 1 has no clock: if play stalls with no goals, deliberately shade
    // one side of the goal and stop intercepting until the deadlock breaks.
    const stale = Date.now() - lastChange > 45000;
    if (stale && !staleNoted) {
      staleNoted = true;
      console.log('  no goals for 45s — opening a lane to break the stalemate');
    }
    const t = stale ? { x: 34, y: 12 } : aimFor(st);
    const s = toScreen(t.x, t.y);
    await page.mouse.move(clamp(s.sx, 4, vw - 4), clamp(s.sy, 4, vh - 4));
    const sc = st.scores.join(',');
    if (sc !== lastScores) {
      lastScores = sc;
      lastChange = Date.now();
      staleNoted = false;
      console.log(`  score: you ${st.scores[0]} — opp ${st.scores[1]} (tick ${st.tick})`);
    }
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      console.log(`  playing… tick ${st.tick}, puck (${st.puck.x.toFixed(0)},${st.puck.y.toFixed(0)})`);
    }
    await page.waitForTimeout(30);
  }
  throw new Error(`match did not reach a results screen within ${maxMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

const shot = (stage, label) => `/tmp/glow-strikers-e2e-${stage}-${label}.png`;

async function newPassPage(browser, label, viewport, hasTouch) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (browserNoise.test(text) || wsOfflineNoise.test(text)) return;
    errors.push(`console: ${text}`);
  });
  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${label}] ${name}`);
  };
  return { context, page, errors, step };
}

async function gotoTitle(page, base, label) {
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#screen-title', { timeout: 15000 });
  await page.waitForFunction(() => window.__gs?.app?.screen === 'title');
  const h1 = await page.textContent('#screen-title h1');
  if (!/GLOW STRIKERS/.test(h1)) throw new Error(`unexpected title: ${h1}`);
  await page.screenshot({ path: shot('title', label) });
}

async function startJourneyStage1(page) {
  await page.getByRole('button', { name: /^Journey/ }).click();
  await page.waitForSelector('.list-item');
  await page.locator('.list-item:not([disabled])').first().click();
  await page.getByRole('heading', { name: /Stage 1:/ }).waitFor();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => window.__gs.app.screen === 'playing');
  await page.waitForSelector('#hud:not([hidden])');
  await page.waitForFunction(
    () => window.__gs.app.session?.state.phase === 'active', null, { timeout: 15000 });
}

async function assertResults(page, label) {
  await page.waitForSelector('section[aria-label="Match results"]', { timeout: 10000 });
  await page.waitForSelector('table.breakdown');
  const rows = await page.locator('table.breakdown tbody tr').count();
  if (rows !== 7) throw new Error(`expected 7 breakdown rows, got ${rows}`);
  const h2 = await page.locator('section[aria-label="Match results"] h2').textContent();
  if (!/Victory|Defeat|Draw|Lesson/.test(h2)) throw new Error(`unexpected headline: ${h2}`);
  await page.screenshot({ path: shot('results', label) });
  return h2;
}

async function desktopPass(browser, base) {
  const VW = 1280, VH = 800;
  const { context, page, errors, step } = await newPassPage(
    browser, 'desktop', { width: VW, height: VH }, false);

  await step('load → title screen', () => gotoTitle(page, base, 'desktop'));

  await step('journey list: 40 stages, only stage 1 unlocked', async () => {
    await page.getByRole('button', { name: /^Journey/ }).click();
    await page.waitForSelector('.list-item');
    const total = await page.locator('.list-item').count();
    if (total !== 40) throw new Error(`expected 40 stages, got ${total}`);
    const enabled = await page.locator('.list-item:not([disabled])').count();
    if (enabled !== 1) throw new Error(`expected 1 unlocked stage, got ${enabled}`);
    await page.screenshot({ path: shot('journey', 'desktop') });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForSelector('#screen-title');
  });

  await step('stage 1 setup → start → countdown → active', async () => {
    await page.getByRole('button', { name: /^Journey/ }).click();
    await page.locator('.list-item:not([disabled])').first().click();
    await page.getByRole('heading', { name: /Stage 1:/ }).waitFor();
    await page.screenshot({ path: shot('setup', 'desktop') });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(() => window.__gs.app.screen === 'playing');
    await page.waitForSelector('#hud:not([hidden])');
    await page.screenshot({ path: shot('countdown', 'desktop') });
    await page.waitForFunction(
      () => window.__gs.app.session?.state.phase === 'active', null, { timeout: 15000 });
  });

  await step('HUD shows objective and clock', async () => {
    const objective = await page.textContent('#hud-objective');
    if (!/First to 5/.test(objective)) throw new Error(`unexpected objective: ${objective}`);
    const clock = await page.textContent('#hud-clock');
    if (!/^\d+:\d\d$/.test(clock)) throw new Error(`unexpected clock: ${clock}`);
  });

  let final = null;
  await step('play journey stage 1 to a results screen (real pointer play)', async () => {
    await page.waitForTimeout(1200); // let the camera finish its play transition
    const toScreen = await calibrate(page, VW, VH);
    await page.screenshot({ path: shot('play', 'desktop') });
    final = await playMatch(page, toScreen, VW, VH);
    if (!final || final.screen !== 'results') {
      throw new Error(`expected results screen, got ${JSON.stringify(final)}`);
    }
    console.log(`  final: you ${final.scores?.[0]} — opp ${final.scores?.[1]} (winner: ${final.winner})`);
  });

  await step('results screen with full breakdown', async () => {
    const h2 = await assertResults(page, 'desktop');
    console.log(`  headline: ${h2}`);
  });

  await step('progression persisted to localStorage', async () => {
    const save = await page.evaluate(() => {
      const raw = localStorage.getItem('glow-strikers.save.v1');
      return raw ? JSON.parse(raw) : null;
    });
    if (!save?.payload) throw new Error('save not persisted');
    const p = JSON.parse(save.payload).progression;
    console.log(`  wins=${p.wins} losses=${p.losses} journeyCompleted=${JSON.stringify(p.journeyCompleted)}`);
    if (final.winner === 0 && !p.journeyCompleted.includes('j01')) {
      throw new Error('won stage 1 but j01 not recorded as completed');
    }
    if (final.winner === 1 && p.losses < 1) throw new Error('loss not recorded');
  });

  await step('practice: undo (Z key + HUD button) and hint (H)', async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.waitForSelector('#screen-title');
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    await page.getByRole('heading', { name: 'Practice', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(
      () => window.__gs.app.session?.state.phase === 'active', null, { timeout: 15000 });
    if (await page.locator('#btn-undo').isHidden()) throw new Error('undo hidden in practice');
    // move a little so the state diverges from the snapshots
    await page.mouse.move(500, 500);
    await page.waitForTimeout(400);
    await page.mouse.move(700, 600);
    // wait for a point safely after an undo-snapshot boundary (every 60 ticks)
    await page.waitForFunction(() => {
      const s = window.__gs.app.session?.state;
      return s && s.phase === 'active' && s.tick > 60 && (s.tick % 60) >= 10 && (s.tick % 60) <= 45;
    }, null, { timeout: 20000 });
    const t1 = await page.evaluate(() => window.__gs.app.session.state.tick);
    await page.keyboard.press('z');
    await page.waitForFunction(
      () => document.getElementById('captions').textContent === 'Undone', null, { timeout: 5000 });
    const t2 = await page.evaluate(() => window.__gs.app.session.state.tick);
    if (!(t2 < t1)) throw new Error(`undo did not rewind (tick ${t1} → ${t2})`);
    console.log(`  undo rewound tick ${t1} → ${t2}`);
    await page.click('#btn-undo'); // HUD button path too
    await page.waitForFunction(
      () => document.getElementById('captions').textContent === 'Undone', null, { timeout: 5000 });
    await page.keyboard.press('h');
    const hint = await page.textContent('#captions');
    if (!hint) throw new Error('hint produced no caption');
    console.log(`  hint: ${hint}`);
    await page.screenshot({ path: shot('practice', 'desktop') });
  });

  await step('board-state panel narrates the match', async () => {
    await page.click('#btn-boardstate');
    await page.waitForSelector('#boardstate-panel:not([hidden])');
    await page.waitForFunction(() => {
      const s = window.__gs.app.session?.state;
      const t = document.getElementById('boardstate-text').textContent;
      return s && t.includes(`Score: you ${s.scores[0]}, opponent ${s.scores[1]}`);
    }, null, { timeout: 5000 });
    const text = await page.textContent('#boardstate-text');
    console.log(`  board state: ${text.slice(0, 80)}…`);
  });

  await step('pause via Esc → resume via button', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Paused', exact: true }).waitFor();
    await page.screenshot({ path: shot('pause', 'desktop') });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(() => window.__gs.app.screen === 'playing');
    if (await page.locator('#hud').isHidden()) throw new Error('HUD hidden after resume');
  });

  await step('settings from pause: change palette/contrast/motion, back out', async () => {
    await page.click('#btn-pause');
    await page.getByRole('heading', { name: 'Paused', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.check('#set-reducedMotion');
    await page.check('#set-highContrast');
    await page.selectOption('#set-palette', 'deuteranopia');
    const applied = await page.evaluate(() => ({
      motion: document.body.classList.contains('reduced-motion'),
      contrast: document.body.classList.contains('high-contrast'),
      palette: document.body.classList.contains('palette-deuteranopia'),
    }));
    if (!applied.motion || !applied.contrast || !applied.palette) {
      throw new Error('settings not applied: ' + JSON.stringify(applied));
    }
    await page.screenshot({ path: shot('settings', 'desktop') });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('heading', { name: 'Paused', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(() => window.__gs.app.screen === 'playing');
  });

  await step('leave match → hosted lobby shows offline fallback → title', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Leave Match', exact: true }).click();
    await page.waitForSelector('#screen-title');
    await page.getByRole('button', { name: /^Hosted Play/ }).click();
    await page.getByRole('heading', { name: 'Hosted Play', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('section[aria-label="Hosted play lobby"] p.dim');
      return el && /No host server reachable/.test(el.textContent);
    }, null, { timeout: 10000 });
    await page.screenshot({ path: shot('lobby-offline', 'desktop') });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForSelector('#screen-title');
  });

  await context.close();
  return errors;
}

async function mobilePass(browser, base) {
  const VW = 390, VH = 844;
  const { context, page, errors, step } = await newPassPage(
    browser, 'mobile', { width: VW, height: VH }, true);

  await step('load → title screen', () => gotoTitle(page, base, 'mobile'));

  await step('journey stage 1 → active, HUD fits small viewport', async () => {
    await startJourneyStage1(page);
    if (await page.locator('#hud').isHidden()) throw new Error('HUD hidden on mobile');
    const pauseBox = await page.locator('#btn-pause').boundingBox();
    if (!pauseBox || pauseBox.width < 30 || pauseBox.height < 30) {
      throw new Error('pause button missing/too small on mobile');
    }
  });

  await step('play to a results screen on mobile viewport', async () => {
    await page.waitForTimeout(1200); // camera transition
    const toScreen = await calibrate(page, VW, VH);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: shot('play', 'mobile') });
    const final = await playMatch(page, toScreen, VW, VH);
    if (!final || final.screen !== 'results') {
      throw new Error(`expected results screen, got ${JSON.stringify(final)}`);
    }
    console.log(`  final: you ${final.scores?.[0]} — opp ${final.scores?.[1]} (winner: ${final.winner})`);
    await assertResults(page, 'mobile');
  });

  await step('retry → pause via HUD button → resume → leave to title', async () => {
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(
      () => window.__gs.app.session?.state.phase === 'active', null, { timeout: 15000 });
    await page.click('#btn-pause');
    await page.getByRole('heading', { name: 'Paused', exact: true }).waitFor();
    await page.screenshot({ path: shot('pause', 'mobile') });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(() => window.__gs.app.screen === 'playing');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Leave Match', exact: true }).click();
    await page.waitForSelector('#screen-title');
  });

  await context.close();
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const server = createServer();
let browser = null;
const allErrors = [];
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://localhost:${server.address().port}`;
  console.log(`serving ${ROOT} on ${base}`);

  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  allErrors.push(...await desktopPass(browser, base));
  if (allErrors.length) {
    throw new Error('page errors after desktop pass:\n' + allErrors.join('\n'));
  }
  allErrors.push(...await mobilePass(browser, base));
  if (allErrors.length) {
    throw new Error('page errors:\n' + allErrors.join('\n'));
  }
  console.log('\nE2E PASS — glow-strikers, desktop + mobile, no page errors');
} catch (e) {
  console.error(`\nE2E FAIL — ${e.message ?? e}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
