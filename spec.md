# Glow Strikers — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today.
**Version:** rules v1, content v1, ruleset build `1.0.0` (`js/session.js` `RULESET_BUILD`).

## 1. Overview

**Pitch:** a luminous tabletop striking sport — defend the glowing goal at your end and drive a low-friction puck through the far one with a circular mallet, on a neon table whose rails are live.

| | |
|---|---|
| Genre | Realtime tabletop sport (air-hockey lineage), fixed-step deterministic physics |
| Players | 1 vs AI in every solo mode; 1 vs 1 (or host vs server AI) in Hosted Play |
| Session length | Quick match 2–4 min; Journey stage 1–3 min; Daily 2 min + golden goal; lessons 10–60 s |
| Platforms | Desktop and mobile browsers with WebGL; landscape and portrait |
| Rendering | Three.js r-module (vendored) arena with selective bloom on the high tier; every menu, HUD element and result is semantic HTML over the canvas |
| Entry | `index.html` → `js/main.js` (ES modules, import map for `three`) |

File map (everything the game ships or runs):

| Path | Role |
|---|---|
| `index.html` | Shell: canvas, HUD, `#screens` root, live regions, import map, inline SVG favicon |
| `css/style.css` | Palette tokens, HUD/panel layout, responsive and safe-area rules, reduced-motion/high-contrast/CVD overrides |
| `js/rules.js` | Pure rules engine: match creation, legality, commands, fixed tick, scoring, serialization, hashing |
| `js/rng.js` | `mulberry32`, `RngStream(seed, stream)`, FNV-1a hashing and stable stringify |
| `js/session.js` | Owns mutable rules state; command dedupe/quantization, replay envelope, periodic hashes, practice undo |
| `js/ai.js` | Deterministic mallet AI parameterised by `skill` |
| `js/content.js` | Themes, obstacle layouts, 40 Journey stages, 6 lessons, 6 challenges, daily config, validator, achievements |
| `js/render.js` | Three.js arena, quality tiers, camera framing, particle pool, picking plane, bloom composer |
| `js/ui.js` | DOM screens, HUD bindings, captions/announcements, settings, lobby, results |
| `js/audio.js` | WebAudio buses, clip playback from `sfx/`, synthesized fallbacks, ambience pad, adaptive music |
| `js/platform.js` | Settings, checksummed save (localStorage, cloud-mirrored when hosted), server time sync, achievements, local leaderboards, StarHermit hosted adapter (launch token, profile nickname, cloud save, read-only platform boards), dev-only presence |
| `js/net.js` | Hosted-play transports (dev-server WebSocket client + host-routed realtime-rooms client; JSON control + binary gameplay frames, reconnect) |
| `js/main.js` | Boot, app state machine, input, main loop, mode wiring, hosted-play glue, `window.__gs` test hook |
| `server.js` | Zero-dependency static server + `/api/v1/*` + RFC 6455 WebSocket rooms running the same rules engine |
| `sfx/*.opus`, `sfx/manifest.txt` | 19 authored clips and the canonical event binding table (`manifest.json` feeds the generator, `manifest.md` is its log) |
| `assets/key-art.webp`, `assets/results-victory.webp`, `assets/results-defeat.webp` | Title key art and results illustrations |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200×675), 256 px icon, tab icon |
| `vendor/three/` | Three.js module and the post-processing addons used by `render.js` |
| `tests/rules.test.mjs`, `tests/e2e.mjs` | Unit/property tests (`npm test`) and the headless-Chrome playthrough (`npm run test:e2e`) |
| `starhermit.txt`, `package.json`, `README.md`, `LICENSE.md`, `knownissues.md` | Platform manifest, scripts, run notes, PolyForm NC 1.0.0, QA history |

## 2. Vision and design pillars

1. **The rails are the second player.** Bank shots off the luminous rails (restitution 0.92, no energy gain) are the intended way past a defender; lesson 5 teaches it and the AI's defensive lag rewards it. Rules in: symmetric obstacles, wide 44-unit goal mouths, a lively mallet coefficient (1.06). Rules out: curved shots, spin, power-ups, anything that makes the puck's path unreadable from the geometry.
2. **One fixed tick, one truth.** The whole game — solo, undo, replay verification and the hosted server — runs the same `rules.step` at 60 Hz with a seeded RNG that only decides serve angles. Rules in: quantised commands, per-tick hashes, a server that never trusts client physics. Rules out: client-side prediction, variable time steps, cosmetic randomness touching outcomes.
3. **Your half is yours.** The mallet can never cross the centre line, and every mode changes what you can do inside your half (clock, travel budget, bumpers) rather than the table itself. Rules in: budgets, shutouts, mastery targets. Rules out: asymmetric tables, opponent-side interaction.
4. **Glow is information.** Every emissive surface means something: warm pink is you, cool cyan is the opponent, goal strips pulse while play is live, the drag marker is grounded (never bloom-only), rings breathe to show ownership. Rules in: five themes that recolour but never restate. Rules out: decorative glow without a gameplay referent, effects that could hide the puck.
5. **Nothing is audio-only, nothing is canvas-only.** Every cue has a caption, every state has a live-region announcement, and a board-state narration panel describes the arena in words. Rules in: DOM buttons for all actions, the e2e bot plays through real pointer moves. Rules out: hidden gestures, canvas-drawn menus.

## 3. Player experience

**Target player:** someone who wants a two-minute reflex duel with just enough system depth (par, stars, budgets, seeds) to return daily. Mobile thumb play and desktop mouse play are equal citizens.

**First 60 seconds.** The title screen offers a primary **Play** button (Quick Match, first-to-5 vs a Club-strength AI) two taps from the arena; the setup card states the win condition, expected duration, players and ranked status before commitment. In play, the HUD objective ("First to 5") sits top-left, a 3-second countdown ticks with a banner, and the serve banner reads "GO". Journey stage 1 carries `tutorialFlags: ['move','strike']`, and **Learn** is a six-lesson track where each lesson requires the action (move 40 units → strike → survive 6 s → score → bank a rail → short match). Pressing **H** at any point captions a contextual hint derived from `rules.legalActions` and the puck's half. **How to Play** is reachable from the title and from pause.

**Session shape.** Countdown (3 s) → rally → goal (1.5 s pause, conceder receives) → … → results with a seven-row breakdown (goals, shots, saves, steals, invalid actions, rail bounces, fastest strike) plus duration and terminal reason. Journey chains stages with a "Next: …" button; Retry restarts the same seed.

**The emotional beat** is the deep save that turns into a counter-strike: the puck heading at your goal, the block from inside your third (the rules count it as a save and the game now cues it), and the rebound already travelling toward the far goal.

## 4. Core loop and rules contract (`js/rules.js`)

**Table and entities.** Table 100 × 200 units (`TABLE_W`, `TABLE_H`); player 0 defends y = 0 and attacks toward y = 200, player 1 mirrors. Mallet radius 7, puck radius 4, goal mouth 44 units centred on each end. Obstacles are static circles from `content.js` layouts. Fixed tick `DT = 1/60` s.

**Phases** (`PHASE`): `countdown` (180 ticks) → `active` → `goalPause` (90 ticks) → `active` … → `terminal`.

**Legal actions** (`legalActions(state, player)`): exactly one action type, `move`, with the player's clamped bounds from `malletBounds` (x ∈ [7, 93]; y ∈ [7, 93] for player 0, [107, 193] for player 1). During `active` a player whose move budget is ≤ 0 has no legal actions (reason `move-budget-exhausted`); after `terminal` nobody has (reason `match-over`).

**Commands** (`applyCommand`): `move {x,y}` sets the mallet target, clamped into bounds; `forfeit` ends the match for the opponent. Rejections carry a reason (`malformed-command`, `unknown-player`, `match-over`, `bad-target`, `move-budget-exhausted`, `unknown-command-type`) and never throw; only the budget rejection increments `stats[p].invalid`. `Session.move` quantises targets to 0.25 units, drops unchanged targets and duplicate ids, and logs accepted commands to the replay envelope.

**Resolution order per active tick** (`stepActive`):
1. Each mallet (0 then 1) moves toward its target at most `malletSpeeds[i] × DT` (default 150 u/s); with a move budget the step is capped by the remaining budget and a `budget-exhausted` event fires when it hits zero. Mallet velocity is derived from the displacement.
2. Puck velocity × `PUCK_FRICTION` (0.9985 per tick), clamped to `MAX_PUCK_SPEED` 300 u/s, then integrated. The last toucher's `maxPuckSpeed` is updated.
3. Mallet–puck collision, player 0 first: depenetrate to radius 11, reflect the relative normal velocity with coefficient `1 + MALLET_REST` (2.06), clamp. Stats: a strike sending the puck toward the opponent counts a `shot`; if the puck was incoming and the intercept was inside the striker's third it also counts a `save`; a strike that is not toward the opponent but takes the puck from the other player counts a `steal`. Emits `strike {player, speed}`.
4. Obstacles: depenetrate and mirror the normal velocity (restitution 1). Emits `obstacle`.
5. Side rails: reflect with `WALL_REST` 0.92, emits `wall`, credits a `wallBounce` to the last toucher.
6. End rails and goals: if |x − 50| < 22 and the puck is leaving the table through an end, `goal(state, scorer)`; otherwise reflect like a rail.
7. Move-limit check: both budgets ≤ 0 and post-collision puck speed < 5 u/s ends the match (`move-limit`).
Then `checkTerminal` handles time limits.

**Goals and serves** (`goal`, `serve`): a goal increments the scorer's score and `goals` stat, recentres the puck, and either ends the match (target reached, or any goal in overtime) or schedules a `goalPause` after which the **conceder receives** the serve. The serve speed is 70 u/s at a seeded angle within ±30° of the receiver's direction; the opening serve direction is a seeded coin flip.

**Terminal states** (`TERMINAL`): `target-score` (first to `targetScore`, default 5), `time-limit` (clock expired with a leader, or tied with overtime disabled → `winner = -1`, a draw), `overtime-goal` (tied at the clock with overtime enabled → golden goal), `forfeit` (explicit command; also issued by the client when a Perfect Wall challenge concedes, and by the server when a seat is abandoned), `move-limit` (both budgets spent, puck at rest; tie → draw).

**Scoring formulas** (`js/main.js`):
- Journey stars (`computeStars`): 1 for the win, +1 if margin ≥ `par.winBy` (2; 3 on mastery stages), +1 if there is no clock or elapsed ≤ `par.underSeconds` (80 % of the limit; 120 s when unclocked). *Example:* stage 12 (limit 126 s, `winBy` 2) won 5–2 in 88 s → 1 + 1 (margin 3) + 1 (88 ≤ 101) = 3 stars.
- Daily and challenge board score: `yourGoals × 10 − theirGoals`. *Example:* Daily won 5–3 → 47; lost 2–5 → 15 (losses are still posted for the daily).
- Journey mastery board score: `stars × 1000 − elapsedSeconds`. *Example:* 3 stars in 84 s → 2916.
Local boards (`Platform.submitResult`) reject wrong rulesets or content versions, non-integer or out-of-range scores (journey −1800…3000, others −99…99) and implausible durations (< 1 s or > 30 min), then sort by score desc, duration asc, keeping 20.

**RNG and seeding** (`js/rng.js`): `mulberry32` seeded per stream (`RngStream(seed, stream)` mixes the stream tag with the golden ratio). Rules use stream 0 and only draw for the opening serve side and each serve angle; `rngCursor` records draws so `deserialize` rebuilds the identical stream. The AI uses `seed ^ 0xA11CE` on stream 7; audio pitch variants use a fixed cosmetic stream 3. Journey seeds are `0xC0FFEE + index × 7919`; challenges carry fixed seeds; the daily seed is `(YYYYMMDD × 2654435761) >>> 0`; Quick Match and Practice draw a random 31-bit seed.

**Undo and hints.** In Practice and Learn only, `Session` snapshots every 60 ticks (keeps 40) and **Z** / the HUD Undo button restores the latest (`doUndo`). **H** captions a hint (`giveHint`). Neither exists in ranked modes or Hosted Play.

**Determinism and replay.** `Session` records commands with ticks, a hash every 60 ticks, and the final hash; `Session.verifyReplay` re-simulates from seed and commands and fails on the first mismatching hash. `rules.hash` is FNV-1a over a key-sorted serialization.

## 5. Modes and progression

| Mode (title button) | Content | Opponent | Clock / rules | Ranked | Notes |
|---|---|---|---|---|---|
| Play (Quick Match) | random seed, no obstacles | skill 0.50 | first to 5, no clock, overtime on | no | runs as `practice` mode (undo available) |
| Daily Challenge | `dailyConfig(UTC day)` | 0.55–0.84 by seed | first to 5, 120 s, golden goal | yes | layout = seed mod 6 of {none, pillars, gates, diamonds, cross, hive}, theme = seed mod 5; wins add the day to `dailyDays` |
| Journey | 40 authored stages | 0.20 → 0.95 | see below | mastery stages only | stage n unlocks when n−1 is completed; stars 1–3 |
| Challenges | 6 fixed cards | 0.30–0.75 | per card | yes | Blitz Clock (3–0 in 60 s, no overtime), Tight Ledger (1500-unit budget, first to 2), Pinball Hive, Perfect Wall (shutout: any concession forfeits), Long Night (first to 9, skill 0.75), Needle Gates (gates, 90 s) |
| Learn | 6 lessons | none (lesson 6: skill 0.25) | goal-driven | no | each lesson requires the action; completing all six sets `tutorialDone` and unlocks Quick Learner |
| Practice | random seed | Relaxed 0.25 / Club 0.50 / Pro 0.75 / Legend 0.92 | first to 5 | no | Restart and Undo available |
| Hosted Play | platform room (quick-join) or dev room code | second human, or host/server AI at 0.55 | first to 5, 180 s, golden goal | server/host-owned result | on-platform uses StarHermit realtime rooms; local dev uses `node server.js`; lobby chat |

**Journey curve** (`buildJourney`): stages sit in five bands of eight. AI skill = min(0.95, 0.18 + 0.02·i) (+0.08 on mastery). Layouts progress none → pillars → gates → diamonds → cross → hive by band, stepping early in the last two stages of each band. Band 2+ adds a clock, max(75, 150 − 2·i) seconds. Band 3+ adds a player-only travel budget on every third stage, max(2600, 5200 − 60·i) units. Mastery stages (every 8th) play to 7 and post to the journey board. Each band uses the next of the five themes.

**Achievements** (`ACHIEVEMENTS`, idempotent, stored locally): First Victory, Quick Learner (all lessons), Heating Up (3-win streak), Mastery Proven, Century of Light (100 goals), Daily Regular (3 daily days).

**Difficulty knobs the AI exposes** (`createAI`): decision cadence `max(1, round(12 − 10·skill))` ticks, aim error `(1 − skill) × 14` units re-rolled every 90 ticks, puck lead `0.2 + 0.6·skill` seconds. Behaviours: intercept from behind the puck when it is in its half, guard the goal line tracking puck x with lag when the puck is incoming, otherwise drift home shading the lane.

## 6. Controls and interaction

| Input | Desktop | Mobile | Effect / feedback |
|---|---|---|---|
| Pointer over own half | mouse hover moves the mallet (no press needed) unless **Hold to aim** is on | touch-drag (pointer capture) | target ring on the table; mallet follows at ≤ 150 u/s; strike burst + clip |
| Arrow keys / remapped | move target at 140 u/s | — | target ring shown while held |
| `Esc` (remappable) | pause / resume; in Hosted Play opens the Match Menu | HUD `II` button | pause overlay; sim halts (solo) |
| `Z` | undo (Practice/Learn) | HUD Undo button | caption "Undone" + rewind cue, or "Nothing to undo" |
| `C` | recentre camera | — | authored 0.9 s transition |
| `H` | hint | — | caption + polite announcement |
| Gamepad | left stick moves, Start (button 9) pauses | — | same as keys |
| Board state | HUD button toggles a narration panel | same | `aria-expanded`, updates every 500 ms |

Input locking (`inputAllowed`): pointer input is accepted only while `screen === 'playing' && !paused` or in `hosted`; keyboard movement is gated the same way; pause/resume keys work from `playing`, `paused`, `hosted`, `hosted-paused`. Backgrounding the tab pauses solo matches and suspends audio; returning resumes the AudioContext. Haptics: 8 ms on strike, 30/40/30 on your goal, 60 ms on a concession (`navigator.vibrate`, toggleable). Every DOM action plays the UI tap; Back, Leave and Menu actions play the quieter back tap.

## 7. Screens and UI flow

`app.screen` states (`js/main.js`): `boot → title → {journey | challenges | learn | setup | settings | help | achievements | leaderboard | lobby} → playing ⇄ paused → results → (title | next stage | retry)`; Hosted Play uses `lobby → hosted ⇄ hosted-paused → results`. `UI.show` swaps a single `<section class="screen">` under `#screens`, remembers the previously focused element, focuses the first primary control, and restores focus when the screen closes.

Layout: `.panel` max-width 560 px (900 wide, 1180 with rails). At ≥ 1024 px the title panel is a three-column grid with a left progress rail (stages cleared, wins/losses, best streak) and a right rail (Achievements, Leaderboards, Settings, How to Play). Below 1024 px the rails collapse and the panel narrows to 520 px. Portrait ≤ 700 px: 16 px panel padding, smaller objective pill, key art capped at 110 px. Landscape ≤ 500 px tall: panel max-height 96 vh, 14 px padding, key art 70 px. All screens scroll internally; the HUD, `#screens` and toasts respect `env(safe-area-inset-*)`. The HUD keeps the objective pill (top-left), score pills and clock (top-centre), pause (top-right), budget pill and captions (bottom-left/centre), Undo and Board state (bottom-right); nothing is placed under browser chrome, and pause is asserted ≥ 30 px on mobile by the e2e.

Must never be cut off: the objective and both score pills, the pause button, the results table with seven rows plus the duration footer, the Start button on setup cards, and the room code in the lobby.

## 8. Art direction

**Palette** (`css/style.css` tokens): background `#070a18`, panel `rgba(13,18,40,.92)` / solid `#0d1228`, line `#2a3a66`, text `#e8ecff`, dim `#9aa6d0`, accent cyan `#38e6ff`, warm pink `#ff5c8a`, gold `#ffd166`, danger `#ff6b6b`, ok `#51ff9e`. CVD palettes swap the accent pair (deuteranopia `#4dd7ff`/`#ffb84d`, protanopia `#59d8ff`/`#ffd24d`, tritanopia `#4dffd2`/`#ff5c5c`); high contrast uses pure white text on near-black panels with `#8fa4ff` lines.

**Arena themes** (`content.js` `THEMES`, presentation only): Neon Dusk (rail `#38e6ff`, you `#ff5c8a`, accent `#ffd166`), Solar Foundry (`#ffb02e` / `#ff4545` / `#7ef0c1`), Verdant Grid (`#51ff9e` / `#ffe066` / `#ff8fb3`), Violet Abyss (`#b06bff` / `#5cf2ff` / `#ffd166`), Glacier Line (`#9adcff` / `#ff9e5c` / `#b4ff6b`). Each defines bg, floor, table, line, rail, goal colours, puck, both mallets, accent and a bloom strength (0.7–1.0).

**Shape language.** Everything is a cylinder, torus or slab: a 112 × 212 slab table, 2.4-unit emissive rail boxes with goal gaps, a flat puck disc, mallets as a tapered cylinder + emissive torus ring + dark handle, bumpers as cylinders with an accent rim, and a ring of glowing-capped pillars at radius 200 (8 on medium, 16 on high). The playing surface is a 256 × 512 procedural canvas texture: centre line and circle, two goal boxes, a faint sheen.

**Hero of the screen:** the puck and its rail-coloured additive trail (26 points), framed from behind your own goal (camera fov 46, height 165, 118 units back, look-ahead 18; portrait pulls back ×1.55 and up ×1.45).

**Typography:** system UI stack ("Segoe UI", system-ui); title in 900-weight gradient text (pink → cyan); tabular numerals for scores, clocks and tables; `--text-scale` 0.85–1.4 from settings.

**Motion.** Camera transitions are cubic-eased over 0.9 s; goal shake 0.5, terminal shake 0.8, decaying fast; particle bursts (strike 10, rail 5, goal 60, terminal 120) with gravity and a floor bounce, tier-capped at 300 / 1000 / 2000. Goal strips pulse while play is live; your ring breathes. **Reduced motion** removes shake, makes camera transitions instant, disables backdrop blur, the banner glow and toast animation; particles keep their timing but tiers already bound counts.

**Quality tiers** (`QUALITY_TIERS`): low (dpr 1, 0.85 render scale, no shadows, no bloom), medium (dpr 1.5, shadows), high (dpr 2, shadows, UnrealBloom strength = theme bloom, radius 0.55, threshold 1.0 so only HDR emissives bloom). Auto picks low on mobile UAs or ≤ 4 cores, otherwise high.

**Visual assets the design calls for:** title key art (`assets/key-art.webp`), a victory and a defeat illustration for the results card (`assets/results-victory.webp`, `assets/results-defeat.webp`), the store cover (`coverart.png`) derived from the key art, and the icon/favicon pair. No hero 3D model: mallets and puck are procedural so every theme can recolour their emissives.

## 9. Audio direction

**Mix.** Four gain buses under a master (`AudioEngine.ensure`): `music` 0.6, `effects` 0.8, `ambience` 0.5 × 0.5, `voice` 0.8 (reserved; nothing plays on it), each with a slider and a global mute. Audio unlocks on the first user gesture (every UI action and pointer-down calls `ensure`). Ambience is a 55 Hz + 82.5 Hz sine pad with a 0.07 Hz tremolo. Music is a two-stem loop on a 300 ms beat: a triangle bass on a four-bar `A A C G` figure, plus a sine arpeggio that fades in when intensity (puck speed ÷ 220) exceeds 0.35. Music starts with a match and stops on results or leaving; the scheduler survives tab suspension.

**Clips vs synthesis.** Each event looks up a clip in `SFX_BY_EVENT`; the clip is fetched and decoded once, and until it is ready (or if it 404s) a synthesized transient plays instead, so the game is never silent. Strike synthesis scales brightness and level with puck speed. When **Captions** is on, meaningful cues also write to the HUD caption line.

**SFX event table** (source of `sfx/manifest.txt`; all on the effects bus):

| Event id | File | Sound | Usage |
|---|---|---|---|
| `ui` | `ui-tap.opus` | soft plastic button tap | every `UI.emit` action except the back set |
| `ui-back` | `ui-back.opus` | quieter descending wooden tap | Back, Settings/Help back, Leave Match, Menu, Leave Room |
| `invalid` | `invalid-buzz.opus` | dull electric error buzz | move rejected for exhausted budget; caption "Invalid action" |
| `strike` | `puck-strike.opus` | hard mallet-on-puck crack | rules `strike` |
| `wall` | `wall-bank.opus` | padded rink-wall thud | rules `wall` |
| `obstacle` | `obstacle-clack.opus` | bright knock on a peg | rules `obstacle` |
| `countdown` | `countdown-tick.opus` | wood-block tick | rules `countdown`, once per second; caption "Starting in N" |
| `go` | `go-whistle.opus` | referee whistle | rules `serve`; banner "GO"; caption "Go!" |
| `goal` | `goal-horn.opus` | arena horn with crowd swell | rules `goal`; caption "Goal for you!" / "Goal conceded" |
| `win` | `win-fanfare.opus` | brass fanfare | victory (solo or hosted), non-match lesson complete; caption "Victory" |
| `lose` | `lose-sting.opus` | muted trombone wah | defeat; caption "Defeat" |
| `achievement` | `achievement-chime.opus` | two-note glockenspiel | `Platform.unlock` succeeds; caption "Achievement unlocked" |
| `overtime` | `overtime-siren.opus` | rising arena siren | rules `overtime`; banner "OVERTIME"; caption "Overtime — golden goal" |
| `budget` | `budget-empty.opus` | hollow coin-empty clunk | rules `budget-exhausted` for you; caption "Move budget exhausted" |
| `clock-warning` | `clock-warning.opus` | double scoreboard beep | once when a timed match's clock first reaches 10 s; caption "10 seconds left" |
| `save` | `save-block.opus` | firm padded paddle stop | your `saves` stat increments on a strike; caption "Save!" |
| `draw` | `draw-sting.opus` | unresolved two-note chime | draw results (time-limit or move-limit tie, hosted draw); caption "Draw" |
| `undo` | `undo-rewind.opus` | reverse tape zip | successful undo; caption "Undone" |
| `chat` | `chat-ping.opus` | glassy notification ping | incoming hosted chat message |

## 10. Localization

The shipped build is **English only**: all strings are literals in `js/ui.js`, `js/main.js` and `js/content.js` (stage, lesson, challenge and achievement names), `index.html` declares `lang="en"`, and there is no language selector or locale detection. Layout already tolerates expansion: buttons are full-width with wrapping labels, the objective pill wraps at 42 ch, tables use `auto-fit` grids, and text scale up to 1.4× is a tested setting. Shipping en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT is listed under design intent (section 17).

## 11. Accessibility

- **Keyboard-only path:** every screen is native buttons/inputs/selects; `UI.show` focuses the first primary control and restores focus on close; arrows move the mallet, `Esc`/`Z`/`C`/`H` are remappable in Settings (press-to-bind).
- **Focus:** `:focus-visible` ring `0 0 0 3px rgba(56,230,255,.6)` on all controls; pause and results are `role="dialog"` with `aria-modal`/labels.
- **Announcements:** objective, score changes and hints go to `#live-polite`; banners (countdown, GO, GOAL!, OVERTIME) and results go to `#live-assertive`; toasts are `role="status"`.
- **Captions:** `#captions` mirrors audio cues (toggle in Settings, on by default).
- **Board-state narration:** HUD button opens a panel that describes score, puck column/row, direction and speed, and your mallet position every 500 ms.
- **Contrast and colour:** high-contrast mode, three CVD palettes, ownership reinforced by position (you are always at the bottom) and by warm-vs-cool hues; text ≥ 0.85 rem with a 0.85–1.4 scale.
- **Motion and timing:** reduced motion (section 8), Timing assistance slows solo simulation to 85 %, Hold-to-aim for pointer users who cannot hover.
- **Targets:** all buttons, list rows, selects and HUD buttons are ≥ 44 px tall; menus keep 8–10 px gaps.
- **WebGL absent:** a plain HTML message replaces the arena and states that progress and settings are preserved.

## 12. StarHermit integration

`starhermit.txt` declares `name=Glow Strikers`, `launch=index.html`, `owner=…`, `server=server.js`, `cover=coverart.png`. The platform launches `index.html`.

Hosted mode activates iff a launch token is present: it arrives in the URL fragment `#game_token=<jwt>` (read once, then stripped; query `?token=`/`?launch=`/`?launch_token=` remain for local dev), is held in memory only, and its payload supplies `sub` (user id) and `game_scope` (the game slug). Every platform REST call sends `Authorization: Bearer`; the token is re-minted every 45 min via `POST /api/v1/games/{slug}/launch-token` (60 s retry).

Used when hosted: account identity (`GET /api/v1/users/{sub}/profile` → nickname, `"Player " + id8` fallback; never usernames, never `/api/v1/me`) shown on the title screen and used for board entries and hosted play; the cloud save slot `GET/PUT /api/v1/me/cloud-saves/{slug}` (zip+base64 mirror of the checksummed save doc — remote wins on boot, 2 s debounce + pagehide flush, sync status on the title line; localStorage stays the offline cache); the platform leaderboard read (`GET /api/v1/games/{slug}` → `leaderboardId` → `entries`, nicknames resolved, read-only — clients can never submit); and realtime-rooms multiplayer (below). Server time (`GET /api/v1/time`, round-trip adjusted, drives the daily countdown) is used in both modes and falls back to the local clock.

Hosted Play on-platform runs on StarHermit realtime rooms (host-routed): the lobby is REST (`POST /api/v1/realtime/rooms` + `/open`, `quick-join`, `leave`, `mine`, `result`), the transport is `/ws/v1/realtime?roomId=&access_token=` with the platform's 16-byte sender prefix stripped from binary frames (8 KB cap). The host player's browser runs the same authoritative rules engine as `server.js` and broadcasts the same 32-byte snapshots; guests send their existing 13-byte input frames (≤30 msg/s). Local dev play (`node server.js`) still uses its own RFC 6455 `/ws` protocol with room codes.

Not used: score submission to platform leaderboards (script/elo-owned; personal bests stay local + cloud-mirrored), server-side achievements (local only, part of the save doc), invitations/matchmaking beyond quick-join, moderation APIs, presence/telemetry uploads (the dev server's `POST /api/v1/presence` heartbeat runs only in local dev). Telemetry is consent-gated and only ever queued in memory (max 50 events); nothing is uploaded.

## 13. Technical architecture

- **Loop** (`frame`): accumulator fixed-step at 60 Hz (max 100 ms per frame, 85 % speed with timing assist); per tick: keyboard/gamepad → AI move → `Session.tick` → events → lesson evaluation; render interpolates between the previous and current position snapshots with `alpha = acc / DT`. Only `Session` mutates rules state.
- **Hosted play:** client sends 13-byte input frames `[u8 1][u32 seq][f32 x][f32 y]`; the authority (dev `server.js`, or the host player's browser on the platform) applies the latest input per seat per tick through `rules.applyCommand`, steps at 60 Hz, and broadcasts 32-byte snapshots `[u8 2][u32 tick][6×f32 puck/mallets][u8 s0][u8 s1][u8 phase]` at 20 Hz; the client interpolates between the last two snapshots using the observed cadence. Rooms (platform mode): REST lobby (create/open/quick-join/leave/mine/result), `/ws/v1/realtime` transport with 16-byte sender prefixes stripped (8 KB frame cap, guests ≤30 msg/s and ready/chat-only text), host-side sim with AI fill-in, guest liveness grace of 30 s (then forfeit), host-relayed chat, reconnect via `GET /rooms/mine` with a "while you were away" summary. Dev mode keeps: 5-char codes, seat tokens, 30 min TTL, 120 frames/s rate limit, 4 KB message cap with fragment reassembly, chat 10/min and 200 chars. Reconnect backoff 0.5 s doubling to 8 s, five attempts.
- **Persistence:** `localStorage['glow-strikers.save.v1']` = `{checksum, payload}` (FNV-1a over the payload); a checksum mismatch or parse failure starts fresh; `migrate` merges unknown versions onto defaults. Contents: settings, progression (completed stages, stars, totals, streaks, lessons, daily days, challenges, cosmetics), achievements, local boards.
- **Content validation** (`validateContent`) runs at boot and in tests: obstacle radii and placement, goal approaches and centre spawn clear, unique ids, ≥ 5 lessons and themes.
- **Performance budgets:** particle pool fixed at 2000 with zero per-frame allocation; shadow map 1024²; dpr capped per tier; bloom only on high; `Renderer.stats()` exposes draw calls and triangles; arena rebuilds dispose geometries and materials.
- **Test hook:** `window.__gs = { app, platform, rules, ui, net }` is read-only in intent — the e2e reads state and pointer coordinates from it but drives input through real DOM events.

## 14. Testing and acceptance criteria

`npm test` (`node --test tests/rules.test.mjs tests/platform.test.mjs`, 43 tests: rules/session/content plus the hosted adapter + rooms client): local board limits and hosted 32-byte snapshot scores > 15; initial legality; phase/budget legality; move clamping; rejection reasons and counting; malformed fuzz (no throws/NaN/hangs); centre-line confinement; friction never reverses and speed is capped; goal mouth vs rail; conceder serves; target-score winner/reason; time limit and golden goal; forfeit; monotonic ticks; serialize round-trip; foreign version rejection; property: identical seeds and commands hash identically; replay envelope verification; undo; golden AI matches terminate sanely at three skills; interrupted session resumes; content validation; 40 stages with mastery cadence and ramp; daily stability per UTC day; obstacles clear of goals/spawn; launch scope.

`npm run test:e2e` (`tests/e2e.mjs`, playwright-core + system Chrome, embedded static server on an ephemeral port): desktop 1280×800 and mobile 390×844 (touch). Steps: title → Journey list (40 rows, 1 unlocked) → stage 1 setup → Start → countdown → active; HUD objective/clock; an affine calibration of screen→table space via real mouse moves; a full match played by real pointer moves to the results screen (seven-row table, headline); save persistence (win records `j01`, loss increments losses); Practice undo via `Z` and the HUD button plus `H` hint; board-state panel text; pause via `Esc` and HUD button; settings changes applied from pause; Leave Match → lobby offline fallback → title; mobile HUD fit, Retry, pause/resume, leave. Any non-benign console error fails the run.

QA bar as checkable statements: every title button reaches its screen and back; a match can be won and lost at both viewports; no console errors or 404s (all 19 clips and 3 images resolve); no text or control is clipped at 1280×800, 390×844 portrait or 844×390 landscape; a new player sees the objective, countdown, GO banner and can read How to Play; settings changes are reflected immediately and persist across reload; the game boots with corrupt or absent save data.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200×672, 23 KB) | title-screen key art above the logo | FLUX.2 klein, seed 9101, 28 steps | generated in this pass |
| `assets/results-victory.webp` (640×400, 27 KB) | results card, Victory / Lesson complete | FLUX.2 klein, seed 9102 | generated in this pass |
| `assets/results-defeat.webp` (640×400, 6 KB) | results card, Defeat | FLUX.2 klein, seed 9103 | generated in this pass |
| `coverart.png` (1200×675, 219 KB) | store cover | key art rescaled, 256-colour PNG | replaced in this pass (previous file was a generic placeholder) |
| `icon.png`, `favicon.svg` | app icon, tab icon | authored SVG/PNG | shipped |
| `sfx/ui-tap … budget-empty.opus` (14 clips) | event clips per section 9 | MOSS-SFX v2, 100 steps | shipped |
| `sfx/clock-warning.opus`, `save-block.opus`, `draw-sting.opus`, `undo-rewind.opus`, `chat-ping.opus` | new event clips | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/manifest.txt` | canonical binding table | authored | created in this pass |
| arena, mallets, puck, bumpers, surface texture | all 3D geometry and markings | procedural (`js/render.js`) | shipped |
| 3D model / character animation | — | not called for (procedural props, no humanoid) | n/a |

## 16. Known limitations

- English-only UI; no locale switch (section 10).
- Leaderboards: platform boards are read-only for clients (shown when hosted with a `leaderboardId`); personal bests are local and cloud-mirrored, not globally submitted. Achievements are local, also part of the cloud-saved doc.
- The **Left-handed layout** toggle is stored but changes nothing on screen; the **Voice** slider controls an empty bus.
- Theme is chosen by content only (Journey band, challenge, daily); the `cosmetics.theme` save field is fixed at Neon Dusk with no picker.
- Only budget rejections count as invalid actions; malformed or out-of-phase commands are rejected silently.
- `checkTerminal` has an unreachable overtime branch (goals end overtime inside `goal`); harmless.
- The e2e covers Hosted Play only up to the offline lobby (dev mode); platform rooms (quick-join/hosted tables) and the reconnect path have no live platform to run against — the room flow follows the wiki contract and the host sim reuses the proven rules engine. Audio and the gamepad path are not covered by automation.
- Hosted-play input frames carry a client sequence number that the server ignores for ordering; the latest frame per tick wins.
- The e2e binds its own ephemeral port and ignores `BASE_URL`.

## 17. Design intent not yet implemented

- Localization into the nine target locales with a string table and a language setting.
- A theme picker for `cosmetics.theme` and a working left-handed HUD mirror.
- Platform score submission and server-side achievements (client submission is not offered by the platform; script-owned scoring would require a Jint game script, which this repo does not declare).
- A visible 10-second clock treatment (pulsing clock pill) to pair with the `clock-warning` cue.
