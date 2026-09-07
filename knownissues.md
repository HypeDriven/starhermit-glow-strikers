# Known Issues — Glow Strikers

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and live probing of the running server in headless Chrome.

Re-verification pass 2026-09-04. Confirmed defects 1-6 re-checked against the current source: all six
were already fixed (uncommitted working-tree changes that match each documented "Expected"), so none
required new code. See the **Resolved** section below.

Review pass 2026-09-07 (Kimi Code). Fresh read of the full client + server source after the 09-04
re-verification. New defects found and fixed; two previously "suspected" items are now resolved.
See **Resolved (2026-09-07)** below.

## Test results (2026-09-07)

| Check | Result |
| --- | --- |
| `npm test` (`node --test tests/rules.test.mjs`) | **PASS** — 25/25 |
| `npm run test:e2e` (`node tests/e2e.mjs`) | **PASS** — desktop + mobile playthroughs, no page errors |
| `node --check` on all edited modules | clean |
| Live `server.js` probe (HTTP 400/traversal, WS room, vs-AI match, 32-byte snapshots, input round-trip) | **PASS** |
| Headless-Chrome hosted-pause smoke (Match Menu via Esc + HUD button, sim continues, settings round-trip, leave) | **PASS** |

## Confirmed defects

None open.

## Resolved (2026-09-07)

### A. Adaptive music never recovers after the tab is backgrounded — FIXED

- **Was:** `js/audio.js` `tickMusic()` returned early whenever `ctx.state !== 'running'` without
  rescheduling, so the first suspended tick (e.g. `visibilitychange` → `audio.suspend()`) permanently
  killed the music loop while `musicState.playing` stayed true, blocking any restart.
- **Fix:** the scheduler now re-arms its timer and skips the beat while suspended, so music resumes
  with the AudioContext.

### B. The HUD pause button and Esc were dead controls in hosted matches — FIXED

- **Was:** `js/main.js` `pauseGame()` returned early for `mode === 'hosted'`; pressing the pause
  button or Esc did nothing (violating one-input acknowledgment), and there was no in-match path to
  settings/help/leave. The pause menu's Restart, had it been reachable, would have started a bogus
  local match in hosted mode.
- **Fix:** pause in hosted mode now opens a "Match Menu" overlay (Back to Match / Settings / Help /
  Leave Match; no Restart — the match is server-owned) while the authoritative sim keeps running.
  `resumeGame()` restores the `hosted` screen, keyboard/gamepad input is gated to the live screen,
  and `ui.on('restart')` is guarded against hosted/null sessions.

### C. Lesson fail/complete timers fired after the player left the lesson — FIXED

- **Was:** `js/main.js` `updateLesson()`/`completeLesson()` used bare `setTimeout`s (1200/900 ms);
  leaving to the title within the delay still triggered `startLesson()` or the results screen.
- **Fix:** both callbacks now verify the session token and screen before acting.

### D. Static-file confinement used a bare string prefix — FIXED (was "Suspected #2")

- **Was:** `server.js` `file.startsWith(ROOT)` would pass a sibling directory whose name begins with
  `glow-strikers`.
- **Fix:** boundary check is now `file === ROOT || file.startsWith(ROOT + path.sep)`.

### E. Binary snapshot packed player 1's score into 4 bits — FIXED (was "Suspected #1")

- **Was:** `server.js` `encodeSnapshot` masked `scores[1]` to 0-15 to share a byte with the phase.
- **Fix:** the snapshot is now 32 bytes — `scores[1]` gets a full byte and the phase its own byte;
  `js/net.js` decodes the new layout. Both ends live in this repo, so the wire change is atomic.

### F. Dead imports in `js/main.js` — FIXED

- Removed unused `QUALITY_TIERS`, `themeById`, and `CHALLENGES` imports.

## Test results (2026-09-04)

| Check | Result |
| --- | --- |
| `npm test` | **PASS** — 25/25 pass, 0 failures (`node --test tests/rules.test.mjs` via the `test` script) |
| `npm run test:e2e` (`node tests/e2e.mjs`) | **PASS** — `E2E PASS — glow-strikers, desktop + mobile, no page errors` (2026-09-04) |
| `node --test tests/*.mjs` (working documented invocation) | 25/25 pass, 0 failures |
| `node --check` on all modules (`js/*.js`, `server.js`, `tests/rules.test.mjs`) | clean |
| Headless-Chrome boot + play-through (served on :39402) | Boots to title, starts a match, HUD counts down and scores; **0** console errors, 0 failed requests |
| API fuzzing (`/api/v1/*`, malformed bodies) | server stayed up |
| Corrupt-`localStorage` sweep (8 corruptions × 1 key, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

## Resolved (2026-08-20 fixes, verified 2026-09-04)

### 1. A malformed percent-escape in the URL path kills the server process — RESOLVED

- **Fixed:** `server.js:59-63` wraps `decodeURIComponent(url.pathname)` in `try/catch`; a `URIError`
  now returns `400 bad path` instead of crashing the `http.createServer` listener.
- **Verified:** replays `GET /%E0%A4%A` against the running server — responds 400, process stays
  alive; the unauthenticated single-request DoS is closed.

### 2. The "Saves" statistic can never be greater than zero — RESOLVED

- **Fixed:** `js/rules.js:314` captures the puck's pre-collision incoming velocity into `inVy`, and
  `js/rules.js:325` uses `inVy` (instead of the already-overwritten `puck.vy`) to decide `wasThreat`.
  Position is still read at the intercept. The save condition is now satisfiable.
- **Verified:** 25/25 unit tests pass; the direct simulation from the original evidence now records a
  save for a deep interception.

### 3. No `package.json` — `npm test` cannot run, and the documented test command is broken — RESOLVED

- **Fixed:** a `package.json` is now present with `"type": "module"`, a `test` script
  (`node --test tests/rules.test.mjs`) and a `test:e2e` script; `README.md:35-36` documents
  `npm test` / `npm run test:e2e` instead of the broken `node --test tests/`.
- **Verified:** `npm test` runs and passes 25/25.

### 4. `leaveCurrentRoom` broadcasts `seat: -1` instead of the seat that was vacated — RESOLVED

- **Fixed:** `server.js:404,409` capture `const vacated = client.seat` *before* `client.seat` is reset
  to `-1`, and broadcast `{ op: 'peer-left', seat: vacated }` — matching the `onDisconnect` path
  (`server.js:263`) and the paired `peer-joined` seat index.

### 5. Move-limit challenges can end on a stale puck speed — RESOLVED

- **Fixed:** `js/rules.js:372` re-measures the puck speed with `const finalSpeed = Math.hypot(...)`
  *after* mallet/obstacle/wall collision resolution, and the move-limit check (`js/rules.js:373`)
  now uses `finalSpeed` instead of the pre-collision `speed`.
- **Verified:** the original evidence simulation no longer declares "move-limit" while the puck leaves
  the tick moving at 5.08 units/s; the check reflects the post-collision speed.

### 6. Fragmented WebSocket messages are silently discarded — RESOLVED

- **Fixed:** `server.js:286-311` adds `handleIncoming`, a full RFC 6455 §5.4 continuation reassembler
  (buffers fragmented data messages until `FIN=1`, caps total size at `MAX_MESSAGE`, passes control
  frames through). `server.js:112` now dispatches to `handleIncoming` instead of `handleFrame`.
- **Verified:** the raw-client fragmented `{"op":"create"}` test now receives the expected
  `{"op":"created"}` response.

## Suspected — not confirmed

### ~~1. Binary snapshot packs player 1's score into 4 bits~~ — FIXED 2026-09-07

- Resolved; see "Resolved (2026-09-07)" item E. The snapshot is now 32 bytes with a full byte
  each for `scores[1]` and the phase.

### ~~2. Static-file boundary check is a string prefix, not a path boundary~~ — FIXED 2026-09-07

- Resolved; see "Resolved (2026-09-07)" item D. The check now uses a `ROOT + path.sep` boundary.

### 3. Invalid-action accounting is incomplete

- **File:** `js/rules.js:167-177` (`applyCommand`)
- **Concern:** only `move-budget-exhausted` increments `state.stats[p].invalid`; `malformed-command`,
  `unknown-player`, `bad-target`, `match-over` and `unknown-command-type` all return without counting.
  `spec.md` §2 uses "fewer invalid actions" as a tie-break and `resultBreakdown` reports
  `invalidActions`.
- **Why unconfirmed:** the spec does not enumerate which rejections count as "invalid actions", so this
  may be a deliberate distinction between malformed transport input and illegal play. Left as-is.

## Checked, no defects found

- **Rules engine** (`js/rules.js`): 25 unit tests covering legality, scoring, fixed-step physics,
  serialization, state hashing, daily determinism, obstacle placement clear of goal mouths and spawn,
  and launch-scope content checks — all pass.
- **Overtime / golden goal:** `goal()` (`js/rules.js:391`) correctly ends the match on the first
  overtime goal via `if (state.inOvertime || state.scores[scorer] >= state.targetScore)`. The parallel
  branch in `checkTerminal` is unreachable but harmless.
- **Serialization round-trip** (`js/rules.js:405` / `js/rules.js:438`): `deserialize` rebuilds the RNG
  stream from `seed` and fast-forwards to `rngCursor`, so a restored state continues the same draw
  sequence.
- **Hosted-play input trust** (`server.js:415-423`, `handleBinary`): mallet targets are bounds-checked
  server-side, applied through the same `rules.applyCommand`, and re-clamped by `malletBounds`; the
  client's seat comes from the server-side `client.seat`, never from the frame.
- **Chat moderation** (`server.js:383-394`): 10 messages/minute, 200-character cap, trimmed.
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

- ~~Hosted play over a live WebSocket match / `js/net.js`~~ — exercised 2026-09-07: a real
  `server.js` room (create → start-vs-ai → binary input → 20 Hz 32-byte snapshots → mallet motion)
  and a headless-Chrome hosted match through `net.js` including the pause menu. A full two-human
  match and the reconnect-token path were still not driven end to end.
- **Three.js render correctness** (`js/render.js`): only checked for absence of runtime errors under
  SwiftShader.
- **Audio** (`js/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
- **Gamepad input path.**

### Parent review: leaderboard score bounds — FIXED

Local leaderboard validation now accepts mastery totals up to 3000 and signed scores for long mastery clears and daily losses. Unknown boards and out-of-range totals are rejected. Regression tests cover accepted and rejected scores, plus hosted snapshot scores above 15.
