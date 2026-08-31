# Known Issues — Glow Strikers

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and live probing of the running server in headless Chrome.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | **cannot run** — `npm error enoent Could not read package.json` (the game ships no `package.json`) |
| `node --test test/` (the command the README documents) | **FAIL** — `Error: Cannot find module '/home/albert/games/glow-strikers/test'`, 0 pass / 1 fail |
| `node --test test/*.mjs` (working invocation) | 25/25 pass, 0 failures |
| `node test/rules.test.mjs` (working invocation) | 25/25 pass, 0 failures |
| `node --check` on all modules (`js/*.js`, `server.js`, `test/rules.test.mjs`) | clean |
| `tests/e2e.mjs` | not present |
| Headless-Chrome boot + play-through (served on :39402) | Boots to title, starts a match, HUD counts down and scores; **0** console errors, 0 failed requests |
| API fuzzing (`/api/v1/*`, malformed bodies) | server stayed up |
| Corrupt-`localStorage` sweep (8 corruptions × 1 key, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

## Confirmed defects

### 1. A malformed percent-escape in the URL path kills the server process

- **File:** `server.js:57` — `let p = decodeURIComponent(url.pathname);`
- **Trigger:** `GET /%E0%A4%A HTTP/1.1` (any incomplete percent-escape).
- **Behaviour:** `decodeURIComponent` throws `URIError: URI malformed` directly inside the
  `http.createServer` listener, which has no `try`/`catch`. The process exits. Unauthenticated,
  single-request denial of service that also takes down every in-progress hosted match.
- **Expected:** a 400/404 response.
- **Evidence:** live server on :39402 —

  ```
  file:///home/albert/games/glow-strikers/server.js:57
    let p = decodeURIComponent(url.pathname);
            ^
  URIError: URI malformed
      at decodeURIComponent (<anonymous>)
      at Server.<anonymous> (file:///home/albert/games/glow-strikers/server.js:57:11)
  ```

  and `curl http://127.0.0.1:39402/` afterwards returned `000`.

### 2. The "Saves" statistic can never be greater than zero — contradictory conditions

- **File:** `js/rules.js:318-324` (`stepActive`, mallet↔puck collision)
- **Trigger:** any save at all: park a mallet in front of your own goal and let a puck heading at that
  goal strike it.
- **Behaviour:**

  ```js
  const towardOpp = i === 0 ? puck.vy > 0 : puck.vy < 0;
  if (towardOpp) {
    state.stats[i].shots++;
    // Save: intercepted a puck heading for own goal while deep in own half.
    const wasThreat = i === 0 ? (puck.vy < 0 && puck.y < TABLE_H / 3) : (puck.vy > 0 && puck.y > TABLE_H * 2 / 3);
    if (wasThreat) state.stats[i].saves++;
  }
  ```

  `wasThreat` is evaluated **inside** the `towardOpp` branch and tests the opposite sign of the same
  `puck.vy`: for `i === 0` the branch requires `puck.vy > 0` while `wasThreat` requires `puck.vy < 0`
  (and mirrored for `i === 1`). The condition is unsatisfiable, so `stats[i].saves` stays 0 forever.
  The intent was clearly to test the *incoming* velocity, but by this point `puck.vx/vy` have already
  been overwritten by the collision impulse three lines above.
- **Expected:** "Saves" is a first-class results-screen column (`js/ui.js:325`
  `['Saves', p => p.saves]`) and the Learn screen teaches it (`js/ui.js:372`: *"Blocks from deep in
  your half count as saves."*). It is also surfaced in `resultBreakdown` (`js/rules.js:468`).
- **Evidence:** direct simulation against the real engine — puck at `y=50` travelling `vy=-120` toward
  player 0's goal, mallet 0 parked at `y=40`:

  ```
  tick 1 strike by 0 puck.y= 51.0 vy= 127.0
  stats[0] = {"goals":0,"shots":1,"saves":0,"steals":0,"invalid":0,"wallBounces":0,"maxPuckSpeed":0}
  SAVES: 0   SHOTS: 1
  ```

### 3. No `package.json` — `npm test` cannot run, and the documented test command is broken

- **Files:** missing `package.json`; `README.md:35-39` documents `node --test test/`
- **Trigger:** `npm test`, or the README's command, from the game directory.
- **Behaviour:**
  - `npm test` → `npm error code ENOENT … Could not read package.json`.
  - `node --test test/` → `Error: Cannot find module '/home/albert/games/glow-strikers/test'`,
    reported as `1..1 / # fail 1`. On Node 22 a bare directory argument is resolved as a module path;
    the working forms are `node --test test/*.mjs` or `node test/rules.test.mjs`.
- **Expected:** every other game in this batch ships a `package.json` with `"type": "module"` and a
  `test` script. Without one the module type also relies on Node's ESM auto-detection rather than being
  declared.
- **Evidence:** the two error outputs above; `node --test test/*.mjs` passes 25/25, so the tests
  themselves are healthy — only the entry points are broken.

### 4. `leaveCurrentRoom` broadcasts `seat: -1` instead of the seat that was vacated

- **File:** `server.js:366-375`
- **Trigger:** a seated player sends `{"op":"leave"}` (or `create`/`join` while already in a room, both
  of which call `leaveCurrentRoom` first).
- **Behaviour:**

  ```js
  client.room = null;
  client.seat = -1;
  broadcast(room, { op: 'peer-left', seat: client.seat });
  ```

  `client.seat` is reset to `-1` on the line *before* it is read, so remaining peers always receive
  `{"op":"peer-left","seat":-1}` and cannot tell which seat opened. The disconnect path
  (`onDisconnect`, `server.js:255`) broadcasts the correct seat, so the two paths disagree.
- **Expected:** the vacated seat index, matching `onDisconnect` and the `peer-joined` message the seat
  index is paired with.
- **Evidence:** the assignment-before-use as quoted; `client.seat` has no other source in that function.

### 5. Move-limit challenges can end on a stale puck speed

- **File:** `js/rules.js:290` (`stepActive`, `const speed = …`) used at `js/rules.js:365`
- **Trigger:** a challenge with `moveBudget` where both budgets are spent and the puck enters a tick
  just below the 5-unit threshold, then is accelerated above it by a mallet or obstacle in that same tick.
- **Behaviour:** `speed` is computed immediately after integration —

  ```js
  puck.x += puck.vx * DT;
  puck.y += puck.vy * DT;
  const speed = Math.hypot(puck.vx, puck.vy);
  ```

  but the mallet collision (`js/rules.js:300`), obstacle bounce (`js/rules.js:332`) and wall bounce
  (`js/rules.js:352`) all mutate `puck.vx`/`puck.vy` afterwards. The terminal check at the bottom of the
  same function still reads the pre-collision value:

  ```js
  if (state.moveBudget && state.moveBudget[0] <= 0 && state.moveBudget[1] <= 0 && speed < 5) {
    endMatch(state, …, TERMINAL.MOVE_LIMIT, events);
  }
  ```

  so the match can be declared over while the puck is in fact still in play (and, symmetrically, can
  fail to end on the tick a wall bounce drops it below the threshold).
- **Expected:** `spec.md` §2 requires an explicit, correct terminal-state reason; the check should
  re-measure after collision resolution.
- **Evidence:** direct simulation with `moveBudget: [0, 0]` and a stationary mallet in the puck's path —

  ```
  speed entering tick = 4.800 -> speed leaving tick = 5.080
  phase = terminal | terminalReason = move-limit | struck = true
  ```

  The match was ended as "move-limit" on a tick that left the puck moving at 5.08 units/s.

### 6. Fragmented WebSocket messages are silently discarded

- **File:** `js/../server.js:112` (`readFrame` returns `fin`) and `server.js:288-303` (`handleFrame`
  never inspects it)
- **Trigger:** send a control message split into a first fragment (`FIN=0, opcode=1`) and a
  continuation (`FIN=1, opcode=0`) — legal RFC 6455 traffic that proxies and some clients produce.
- **Behaviour:** the first fragment is JSON-parsed as if complete (it fails and is dropped by the
  `try { msg = JSON.parse(...) } catch { return; }`), and the continuation frame has `op === 0`, which
  falls through `if (op !== 1 || payload.length > MAX_MESSAGE) return;`. There is no continuation
  buffer anywhere in the file, so the message is lost with no error to the client and nothing logged.
- **Expected:** RFC 6455 §5.4 requires continuation reassembly.
- **Evidence:** raw client, same message sent two ways —

  ```
  glow-strikers FRAGMENTED {"op":"create"} -> only the unsolicited {"op":"welcome",...}; no {"op":"created"}
  ```

  (`gravity-hollow/server.js` has the same gap, verified the same way.)

## Suspected — not confirmed

### 1. Binary snapshot packs player 1's score into 4 bits

- **File:** `server.js:228` — `buf.writeUInt8((s.scores[1] & 0x0f) | (phaseCode(s.phase) << 4), 30);`
- **Concern:** player 0's score gets a full byte (`s.scores[0] & 0xff`) but player 1's is masked to
  0-15, so a score of 16 would display as 0 for remote clients.
- **Why unconfirmed:** the highest `targetScore` in shipped content is 9 (`js/content.js:225`), so the
  wrap is unreachable with the content as authored. It is a latent asymmetry rather than a live bug.

### 2. Static-file boundary check is a string prefix, not a path boundary

- **File:** `server.js:59` — `if (!file.startsWith(ROOT) || file.includes(`${path.sep}.git`))`
- **Concern:** `ROOT = path.dirname(fileURLToPath(import.meta.url))` has no trailing separator, so a
  sibling directory beginning with `glow-strikers` would pass the prefix test.
- **Why unconfirmed:** no such sibling exists here and a live raw `GET /../fleet-signals/spec.md`
  returned 404. Proving the escape would require creating a directory in `~/games`.

### 3. Invalid-action accounting is incomplete

- **File:** `js/rules.js:167-177` (`applyCommand`)
- **Concern:** only `move-budget-exhausted` increments `state.stats[p].invalid`; `malformed-command`,
  `unknown-player`, `bad-target`, `match-over` and `unknown-command-type` all return without counting.
  `spec.md` §2 uses "fewer invalid actions" as a tie-break and `resultBreakdown` reports
  `invalidActions`.
- **Why unconfirmed:** the spec does not enumerate which rejections count as "invalid actions", so this
  may be a deliberate distinction between malformed transport input and illegal play.

## Checked, no defects found

- **Rules engine** (`js/rules.js`): 25 unit tests covering legality, scoring, fixed-step physics,
  serialization, state hashing, daily determinism, obstacle placement clear of goal mouths and spawn,
  and launch-scope content checks — all pass.
- **Overtime / golden goal:** `goal()` (`js/rules.js:381`) correctly ends the match on the first
  overtime goal via `if (state.inOvertime || state.scores[scorer] >= state.targetScore)`. The parallel
  branch in `checkTerminal` is unreachable but harmless.
- **Serialization round-trip** (`js/rules.js:399` / `js/rules.js:431`): `deserialize` rebuilds the RNG
  stream from `seed` and fast-forwards to `rngCursor`, so a restored state continues the same draw
  sequence.
- **Hosted-play input trust** (`server.js:381`, `handleBinary`): mallet targets are bounds-checked
  server-side, applied through the same `rules.applyCommand`, and re-clamped by `malletBounds`; the
  client's seat comes from the server-side `client.seat`, never from the frame.
- **Chat moderation** (`server.js:348`): 10 messages/minute, 200-character cap, trimmed.
- **`maxPuckSpeed` statistic:** the model review claimed a goal-scoring strike is never recorded
  because `goal()` zeroes the puck before the next tick's measurement. A direct simulation of a
  250-unit/s strike into the goal recorded `stats[0].maxPuckSpeed = 249.63`, so the statistic does
  track hard shots — treated as **not confirmed**. (Only a strike that both accelerates the puck and
  crosses the goal line inside a single tick would be missed.)
- **Corrupt / absent `localStorage`:** 8 reload cycles with `glow-strikers.save.v1` set to `''`, `'{'`,
  `'null'`, `'[]'`, `'"x"'`, `'{"v":999999}'`, `' garbage'` and `'{"version":-1,"data":null}'` all
  booted cleanly with no page errors.
- **Rapid input and resize:** 90 rapid key presses, 40 rapid clicks, five viewport changes
  (360×740 through 1600×900) and eight pause toggles mid-match produced no console errors; the match
  kept running and the canvas resized correctly.
- **Client boot and a full match in headless Chrome** produced no console errors, including after a
  viewport change to 420×800.

## Not tested

- **Hosted play over a real WebSocket connection.** The room lifecycle (create/join/reconnect token,
  `SEAT_GRACE_MS` forfeit, room janitor) was reviewed statically only — no WebSocket client was driven
  against the server, so defect 4 is confirmed from source rather than observed on the wire.
- **`js/net.js`** (139 lines) — the hosted-play client — was not exercised.
- **Three.js render correctness** (`js/render.js`): only checked for absence of runtime errors under
  SwiftShader.
- **Audio** (`js/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
- **Gamepad input path.**
