// Plays the web package in Chrome on the GPU (~/games/tools/gpu-chrome.mjs;
// the loader index.html that `npm run package` writes), past
// ~/games/tools/engine-web-smoke.mjs's start: at a desktop viewport (Enter on
// the focused Play and Start, the arrow keys and a mouse drag move the
// mallet, Escape pauses), at a phone viewport (the same by keys, then a
// finger dragging the mallet over the table) and at a phone held sideways,
// failing on console errors or warnings or the runtime's error screen.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names; it answers
// the platform clock /api/v1/time), the engine itself from wiki.starhermit.com
// as the loader pins it. playwright-core is resolved from GAME_DIR's
// node_modules or any sibling game's.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/plain', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.opus': 'audio/ogg', '.ogg': 'audio/ogg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { launchChrome } = await import(join(homedir(), 'games/tools/gpu-chrome.mjs'));
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
const start = [['key', 'Enter'], ['shot', 'setup'], ['key', 'Enter'], ['wait', 4500], ['hold', 'ArrowUp', 600], ['hold', 'ArrowLeft', 500], ['shot', 'play']];
const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 }, steps: [['shot', 'title'], ...start, ['drag', [0.5, 0.75], [0.35, 0.65]], ['shot', 'dragged'], ['key', 'Escape'], ['shot', 'pause']] },
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true, steps: [['shot', 'title'], ...start, ['touchdrag', [0.5, 0.75], [0.3, 0.7]], ['shot', 'dragged'], ['key', 'Escape'], ['shot', 'pause']] },
  { name: 'landscape', viewport: { width: 844, height: 390 }, mobile: true, steps: [['shot', 'title'], ...start, ['touchdrag', [0.5, 0.8], [0.6, 0.7]], ['shot', 'dragged'], ['key', 'Escape'], ['shot', 'pause']] },
];
try {
  for (const v of views) {
    const ctx = await browser.newContext({ viewport: v.viewport, isMobile: !!v.mobile, hasTouch: !!v.mobile, deviceScaleFactor: v.mobile ? 3 : 1 });
    const page = await ctx.newPage();
    const problems = [];
    const environment = /^No available adapters\.$|GL Driver Message|Automatic fallback to software WebGL/;
    page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text())) problems.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: 'load' });
    const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit ?? ''), null, { timeout: 90000 }).then(() => true, () => false);
    await page.waitForTimeout(4000);
    const cdp = v.mobile ? await ctx.newCDPSession(page) : null;
    const at = ([x, y]) => [v.viewport.width * x, v.viewport.height * y];
    for (const [op, a, b] of v.steps) {
      if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(120); await page.keyboard.up(a); }
      if (op === 'hold') { await page.keyboard.down(a); await page.waitForTimeout(b); await page.keyboard.up(a); }
      if (op === 'wait') { await page.waitForTimeout(a); continue; }
      if (op === 'drag') {
        const [x0, y0] = at(a), [x1, y1] = at(b);
        await page.mouse.move(x0, y0); await page.mouse.down();
        for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12); await page.waitForTimeout(40); }
        await page.mouse.up();
      }
      if (op === 'touchdrag') {
        const [x0, y0] = at(a), [x1, y1] = at(b);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
        for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 12, y: y0 + ((y1 - y0) * i) / 12 }] }); await page.waitForTimeout(40); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
      await page.waitForTimeout(1500);
    }
    const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
    const ok = started && state !== 'error' && problems.length === 0;
    failed ||= !ok;
    console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
    for (const p of problems) console.log(`  ${p}`);
    await ctx.close();
  }
} finally { await close(); server.close(); }
process.exit(failed ? 1 : 0);
