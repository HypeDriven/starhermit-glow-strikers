# Glow Strikers

A luminous futuristic tabletop striking game. Defend your goal and strike the
low-friction puck into the opposing goal with your mallet.

## Run

```sh
node server.js        # serves the game + hosted play on http://localhost:8000
```

Any static file server also works for solo modes (hosted play needs
`server.js`):

```sh
python3 -m http.server 8000
```

## Play

- **Pointer/touch:** drag anywhere in your half; your mallet follows.
- **Keyboard:** arrow keys move, `Esc` pauses, `Z` undoes (Practice), `C`
  recentres the camera, `H` gives a hint. All bindings are remappable in
  Settings.
- **Gamepad:** left stick moves, Start pauses.

Modes: Learn (interactive lessons), Journey (40 authored stages), Daily (shared
UTC seed), Practice (restart/undo, unranked), Challenge (constrained goals),
Hosted Play (private rooms over WebSocket with an authoritative server
simulation, reconnect, and chat).

## Tests

```sh
node --test test/
```

## Layout

- `js/rules.js` — pure deterministic rules engine (legality, scoring, fixed-step
  physics, serialization, state hashing).
- `js/session.js` — command dispatch, replay envelope + verification, undo.
- `js/content.js` — versioned stages, lessons, challenges, themes, validators.
- `js/render.js` — Three.js arena, VFX pools, quality tiers, selective bloom.
- `js/ui.js` — semantic HTML screens/HUD, accessibility mirror.
- `js/audio.js` — synthesized buses: music / effects / ambience / voice.
- `js/platform.js` — settings, checksummed saves, time sync, achievements.
- `js/net.js` + `server.js` — hosted play client and authoritative server.
