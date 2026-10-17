// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics
// from the title screen, starts Practice and sweeps the real pointer across the near half of the table
// so the mallet strikes the puck — rails glow, bursts fire, the trail and ambient motes animate.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__gs?.app?.screen === 'title', null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('game-canvas').dataset.gfxPreset === p, preset);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForSelector('#screen-title');
}

export async function start(page) {
  await page.getByRole('button', { name: 'Practice', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => window.__gs.app.screen === 'playing');
  await page.waitForFunction(() => window.__gs.app.session?.state.phase === 'active', null, { timeout: 20000 });
  const vp = page.viewportSize();
  let stopped = false;
  page.once('close', () => { stopped = true; });
  (async () => {
    let t = 0;
    while (!stopped) {
      try {
        if (await page.evaluate(() => window.__gs.app.screen === 'results')) {
          await page.getByRole('button', { name: /Play again|Retry|Rematch/ }).first().click({ timeout: 2000 }).catch(() => {});
        }
        t += 0.35;
        const x = vp.width * (0.5 + 0.3 * Math.sin(t));
        const y = vp.height * (0.62 + 0.14 * Math.sin(t * 1.7));
        await page.mouse.move(x, y, { steps: 4 });
      } catch { /* page closing */ }
      await new Promise((r) => setTimeout(r, 60));
    }
  })();
  await page.waitForTimeout(800);
}
