# Glow Strikers

A luminous futuristic tabletop striking game. Defend your goal and strike the
low-friction puck into the opposing goal with your mallet.

A StarHermit engine script game (engine 1.28.0): the StarHermit client plays
it natively, browsers play it on the engine's web runtime through
`index.html` (the loader `npm run package` writes).

## Run

```sh
STARHERMIT=~/sh/runtime/1.28.0/starhermit-1.28.0-linux-x86_64/starhermit
$STARHERMIT .            # play in a window (--dev for console output)
$STARHERMIT check .      # validate and run 120 headless frames
npm run package          # rewrite index.html + starhermit-files.json after every change
```

## Play

- **Pointer/touch:** move (or drag) on the table; your mallet follows inside your half.
- **Keyboard:** arrow keys move, `Esc` pauses, `Z` undoes (Practice/Learn), `C`
  recentres the camera, `H` gives a hint, `B` toggles the board-state narration.
  Rebind keys and pads in the runtime's Options (F1).
- **Gamepad:** left stick moves, Start pauses.

Modes: Learn (interactive lessons), Journey (40 authored stages), Daily (shared
UTC seed), Practice (restart/undo, unranked), Challenge (constrained goals),
Hosted Play (StarHermit realtime rooms, refereed by `server.js`, with room chat).

## Tests

```sh
npm test               # unit tests (rules, saves, server script incl. the Jint sandbox, i18n) + native checks and play scripts
npm run test:browser   # the packaged web build in Chrome on the GPU: desktop, phone, landscape
```

## Layout

- `native/` — the engine client (TypeScript): `main.ts` state machine, `screens.ts`
  UI, `render.ts` arena, `audio.ts`, `platform.ts` saves/settings/leaderboard,
  `net.ts` hosted rooms, `i18n.ts`, `quality.ts`, `style.ts`.
- `js/rules.js`, `rng.js`, `session.js`, `ai.js`, `content.js` — pure rules, shared by the client, `server.js` and the tests.
- `js/progress.js` — the save document's rules; `js/i18n/` — string tables.
- `server.js` — the platform script: hosted-match referee and score posting
  (`npm run server` regenerates its RULES block from `js/`).
- `tools/ui-style.css` → `assets/ui-style.json` (`npm run css`).

See `spec.md` for the full running spec.
