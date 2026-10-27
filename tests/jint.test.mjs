// server.js in the platform's own script sandbox: the StarHermit platform's
// script worker (Platform.ScriptRunner, Jint, strict mode) under the default
// per-invocation budgets (250 ms, 32 MB, 5M statements). A hosted match
// against the room's AI seat is played to its result at the script's 30 Hz
// tick; every invocation must succeed well within the budgets (the tick runs
// two 60 Hz rules steps and the AI). Skipped when the worker is not built here
// (SH_SCRIPT_RUNNER names its dll; default
// ~/sh/starhermit/src/Platform.ScriptRunner/bin/Debug/net8.0). After
// crown-draughts' tests/jint.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DLL = process.env.SH_SCRIPT_RUNNER
  || join(homedir(), 'sh/starhermit/src/Platform.ScriptRunner/bin/Debug/net8.0/Platform.ScriptRunner.dll');
const SOURCE = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
let dotnet = false;
try { execFileSync('dotnet', ['--list-runtimes'], { stdio: 'pipe' }); dotnet = true; } catch { dotnet = false; }
const skip = !dotnet || !existsSync(DLL) ? 'the platform script worker is not built here' : false;

function worker() {
  const p = spawn('dotnet', [DLL], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
      buf = buf.subarray(4 + n);
      waiters.shift()(msg);
    }
  });
  const next = () => new Promise((r) => waiters.push(r));
  const ready = next();
  let sent = false;
  return {
    ready,
    async invoke(entryPoint, ctx) {
      const body = Buffer.from(JSON.stringify({
        op: 'invoke', scriptKey: 'glow-strikers', source: sent ? null : SOURCE,
        gameId: '00000000-0000-0000-0000-0000000000a5', slug: 'glow-strikers', scriptVersion: 1,
        cpuMillis: 250, memoryBytes: 32 * 1024 * 1024, maxStatements: 5_000_000,
        entryPoint, context: JSON.stringify(ctx),
      }));
      sent = true;
      const head = Buffer.alloc(4);
      head.writeInt32LE(body.length);
      p.stdin.write(Buffer.concat([head, body]));
      const r = await next();
      if (r.needSource) { sent = false; return this.invoke(entryPoint, ctx); }
      assert.ok(r.ok, `${entryPoint}: ${r.failure} ${r.message || ''}`);
      const value = JSON.parse(r.return);
      assert.ok(value.ok, `${entryPoint} refused: ${value.error}`);
      return { value, ms: r.elapsedMillis };
    },
    close() { p.stdin.end(); },
  };
}

test('server.js referees a whole hosted match inside the platform sandbox and budgets', { skip, timeout: 900_000 }, async () => {
  const w = worker();
  try {
    await w.ready;
    const roster = [{ userId: 'a', name: 'Ada', team: 0, slot: 0, ai: false }, { userId: null, name: 'Bot', team: 1, slot: 0, ai: true }];
    const presence = { a: { online: true, left: false } };
    let now = 5_000_000;
    const ctx = (extra) => ({ now, random: 0.42, sessionId: 's', playerStates: {}, players: [{ id: 'a', name: 'Ada', elo: 1200 }], room: { roomId: 'r', metadata: {}, roster }, presence, ...extra });
    let { value } = await w.invoke('createSession', ctx({ sessionState: null }));
    let ss = value.sessionState, result = null, worst = 0, total = 0, n = 0, last = null;
    for (let i = 0; i < 20000 && !result; i++) {
      now += 33;
      const inputs = last ? [{ from: 'a', data: { type: 'input', realtime: true, x: last.p[0], y: Math.min(90, last.p[1]) } }] : [];
      const r = await w.invoke('onTick', ctx({ sessionState: ss, inputs }));
      worst = Math.max(worst, r.ms); total += r.ms; n++;
      ss = r.value.sessionState;
      last = (r.value.broadcast || []).map((b) => b.data).find((d) => d.type === 'snap') || last;
      if (r.value.result) result = r.value;
    }
    assert.ok(result, 'the match ended');
    console.log(`# ${n} ticks: mean ${(total / n).toFixed(2)} ms, slowest ${worst} ms (budget 250)`);
    assert.ok(worst < 150, 'every tick well inside 250 ms');
  } finally { w.close(); }
});
