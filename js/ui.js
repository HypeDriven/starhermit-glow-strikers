// DOM shell: responsive screens, HUD, focus management, settings, help,
// achievements, leaderboards, lobby, and the accessibility mirror.
// UI state is fully separate from simulation state.

import { ACHIEVEMENTS, THEMES, JOURNEY, CHALLENGES, LESSONS, dailyConfig } from './content.js';
import { TERMINAL } from './rules.js';

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

const TERMINAL_LABEL = {
  [TERMINAL.TARGET_SCORE]: 'Target score reached',
  [TERMINAL.TIME_LIMIT]: 'Time limit',
  [TERMINAL.OVERTIME_GOAL]: 'Overtime golden goal',
  [TERMINAL.FORFEIT]: 'Forfeit',
  [TERMINAL.MOVE_LIMIT]: 'Move budget exhausted',
};

export class UI {
  constructor(platform, audio) {
    this.platform = platform;
    this.audio = audio;
    this.handlers = {};
    this.screensRoot = $('#screens');
    this.currentScreen = null;
    this._focusMemory = null;
    this._captionTimer = null;

    this.hud = $('#hud');
    this.hudObjective = $('#hud-objective');
    this.hudScoreYou = $('#score-you');
    this.hudScoreOpp = $('#score-opp');
    this.hudClock = $('#hud-clock');
    this.hudBanner = $('#hud-banner');
    this.hudBudget = $('#hud-budget');
    this.captions = $('#captions');
    this.livePolite = $('#live-polite');
    this.liveAssertive = $('#live-assertive');
    this.toastStack = $('#toast-stack');

    $('#btn-pause').addEventListener('click', () => this.emit('pause'));
    $('#btn-undo').addEventListener('click', () => this.emit('undo'));
    const bsBtn = $('#btn-boardstate');
    bsBtn.addEventListener('click', () => {
      const panel = $('#boardstate-panel');
      const show = panel.hidden;
      panel.hidden = !show;
      bsBtn.setAttribute('aria-expanded', String(show));
    });
  }

  on(action, fn) { (this.handlers[action] ??= []).push(fn); return this; }
  emit(action, data) {
    this.audio?.ensure();
    if (action !== 'settings-preview') this.audio?.event('ui');
    for (const fn of this.handlers[action] ?? []) fn(data);
  }

  // ---------------------------------------------------------------- screens

  show(name, builder) {
    if (this.currentScreen) {
      this._focusMemory = document.activeElement;
      this.currentScreen.remove();
      this.currentScreen = null;
    }
    if (!name) return;
    const node = builder();
    node.classList.add('screen');
    this.screensRoot.append(node);
    this.currentScreen = node;
    const first = node.querySelector('.btn.primary, button, [href], input, select') ?? node;
    requestAnimationFrame(() => first.focus?.());
  }

  hideScreens() {
    if (this.currentScreen) {
      this.currentScreen.remove();
      this.currentScreen = null;
      this._focusMemory?.focus?.();
      this._focusMemory = null;
    }
  }

  showHud(show) {
    this.hud.hidden = !show;
    if (!show) this.hideScreens();
  }

  // ---------------------------------------------------------------- HUD

  setObjective(text) {
    if (this.hudObjective.textContent !== text) {
      this.hudObjective.textContent = text;
      this.announce(text, false);
    }
  }
  setScores(you, opp) {
    if (this.hudScoreYou.textContent !== String(you) || this.hudScoreOpp.textContent !== String(opp)) {
      this.hudScoreYou.textContent = you;
      this.hudScoreOpp.textContent = opp;
      this.announce(`Score: you ${you}, opponent ${opp}`, false);
    }
  }
  setClock(text) { this.hudClock.textContent = text; }
  setBudget(text) {
    this.hudBudget.hidden = !text;
    if (text) this.hudBudget.textContent = text;
  }
  setUndoVisible(v) { $('#btn-undo').hidden = !v; }

  banner(text, assertive = true) {
    this.hudBanner.textContent = text;
    this.hudBanner.classList.add('show');
    if (assertive) this.announce(text, true);
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.hudBanner.classList.remove('show'), 1400);
  }

  caption(text) {
    this.captions.textContent = text;
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => (this.captions.textContent = ''), 2500);
  }

  announce(text, assertive = false) {
    const region = assertive ? this.liveAssertive : this.livePolite;
    region.textContent = '';
    requestAnimationFrame(() => (region.textContent = text));
  }

  toast(text) {
    const t = el('div', { class: 'toast', role: 'status', text });
    this.toastStack.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  setBoardState(text) { $('#boardstate-text').textContent = text; }

  // ---------------------------------------------------------------- title

  showTitle(progress) {
    const p = this.platform.save.progression;
    const done = p.journeyCompleted.length;
    const daily = dailyConfig(this.platform.now());
    this.show('title', () => el('section', { id: 'screen-title', role: 'main', 'aria-label': 'Glow Strikers main menu' },
      el('div', { class: 'panel with-rails' },
        el('div', { class: 'rail' },
          el('h3', { text: 'Journey' }),
          el('p', { text: `${done} / ${JOURNEY.length} stages cleared` }),
          el('h3', { text: 'Record' }),
          el('p', { text: `${p.wins} wins · ${p.losses} losses` }),
          el('p', { text: `Best streak: ${p.bestStreak}` }),
        ),
        el('div', {},
          el('h1', { class: 'title-logo', text: 'GLOW STRIKERS' }),
          el('p', { class: 'title-sub', text: 'Defend your goal. Strike the light.' }),
          el('div', { class: 'menu', role: 'navigation', 'aria-label': 'Main menu' },
            el('button', { class: 'btn primary', onclick: () => this.emit('quick-play') },
              'Play', el('span', { class: 'sub', text: 'Jump straight into a match' })),
            el('button', { class: 'btn', onclick: () => this.emit('start-daily') },
              `Daily Challenge`, el('span', { class: 'sub', text: `${daily.name} · shared seed` })),
            el('button', { class: 'btn', onclick: () => this.emit('show-journey') },
              'Journey', el('span', { class: 'sub', text: `${done}/${JOURNEY.length} stages` })),
            el('button', { class: 'btn', onclick: () => this.emit('show-challenges') }, 'Challenges'),
            el('button', { class: 'btn', onclick: () => this.emit('show-learn') },
              this.platform.settings.tutorialDone ? 'Learn (replay)' : 'Learn',
              el('span', { class: 'sub', text: 'Interactive lessons' })),
            el('button', { class: 'btn', onclick: () => this.emit('show-practice') }, 'Practice'),
            el('button', { class: 'btn', onclick: () => this.emit('show-lobby') }, 'Hosted Play'),
          ),
        ),
        el('div', { class: 'rail' },
          el('h3', { text: 'More' }),
          el('div', { class: 'menu' },
            el('button', { class: 'btn small', onclick: () => this.emit('show-achievements') }, 'Achievements'),
            el('button', { class: 'btn small', onclick: () => this.emit('show-leaderboard') }, 'Leaderboards'),
            el('button', { class: 'btn small', onclick: () => this.emit('show-settings') }, 'Settings'),
            el('button', { class: 'btn small', onclick: () => this.emit('show-help') }, 'How to Play'),
          ),
        ),
      ),
    ));
  }

  // ---------------------------------------------------------------- lists

  showJourney() {
    const p = this.platform.save.progression;
    this.show('journey', () => {
      const list = el('div', { class: 'list', role: 'list' });
      for (const s of JOURNEY) {
        const unlocked = s.index === 0 || p.journeyCompleted.includes(JOURNEY[s.index - 1].id);
        const stars = p.journeyStars[s.id] ?? 0;
        const done = p.journeyCompleted.includes(s.id);
        list.append(el('button', {
          class: `list-item${done ? ' done' : ''}`, role: 'listitem',
          disabled: !unlocked,
          'aria-label': `Stage ${s.index + 1}: ${s.name}${done ? `, completed with ${stars} stars` : unlocked ? '' : ', locked'}`,
          onclick: () => this.emit('start-journey', s),
        },
          el('span', { text: `${s.index + 1}.` }),
          el('span', {}, s.name, el('span', { class: 'sub dim', text: s.mechanics.join(' · ') })),
          s.mastery ? el('span', { class: 'tag', text: 'MASTERY' }) : null,
          done ? el('span', { class: 'stars', text: '★'.repeat(stars) + '☆'.repeat(3 - stars) }) : null,
        ));
      }
      return el('section', { 'aria-label': 'Journey stages' },
        el('div', { class: 'panel' },
          el('h2', { text: 'Journey' }),
          el('p', { class: 'dim', text: 'Forty authored stages. Concepts are introduced alone, combined, then tested in Mastery stages.' }),
          list,
          this._backRow(),
        ));
    });
  }

  showChallenges() {
    const p = this.platform.save.progression;
    this.show('challenges', () => {
      const list = el('div', { class: 'list', role: 'list' });
      for (const c of CHALLENGES) {
        const done = p.challengesDone.includes(c.id);
        list.append(el('button', {
          class: `list-item${done ? ' done' : ''}`, role: 'listitem',
          onclick: () => this.emit('start-challenge', c),
        },
          el('span', {}, c.name, el('span', { class: 'sub dim', text: c.description })),
          done ? el('span', { class: 'stars', text: '✓' }) : null,
        ));
      }
      return el('section', { 'aria-label': 'Challenges' },
        el('div', { class: 'panel' },
          el('h2', { text: 'Challenges' }),
          el('p', { class: 'dim', text: 'Constrained goals: clocks, travel budgets, altered layouts.' }),
          list,
          this._backRow(),
        ));
    });
  }

  showLearn() {
    const p = this.platform.save.progression;
    this.show('learn', () => {
      const list = el('div', { class: 'list', role: 'list' });
      for (const l of LESSONS) {
        const done = p.lessonsDone.includes(l.id);
        list.append(el('button', {
          class: `list-item${done ? ' done' : ''}`, role: 'listitem',
          onclick: () => this.emit('start-lesson', l),
        },
          el('span', {}, l.title, el('span', { class: 'sub dim', text: l.text })),
          done ? el('span', { class: 'stars', text: '✓' }) : null,
        ));
      }
      return el('section', { 'aria-label': 'Learn lessons' },
        el('div', { class: 'panel' },
          el('h2', { text: 'Learn' }),
          el('p', { class: 'dim', text: 'One rule at a time — each lesson asks you to perform the action.' }),
          list,
          this._backRow(),
        ));
    });
  }

  /** Mode setup: rules, expected duration, assists, ranked badge — before commitment. */
  showSetup(cfg) {
    const mins = cfg.timeLimitSeconds ? `${Math.round(cfg.timeLimitSeconds / 60)} min max` : 'a few minutes';
    this.show('setup', () => el('section', { 'aria-label': `${cfg.title} setup` },
      el('div', { class: 'panel' },
        el('h2', { text: cfg.title }),
        el('p', { class: 'dim', text: cfg.description }),
        el('div', { class: 'meta-grid' },
          el('div', { class: 'meta-cell' }, el('b', { text: `First to ${cfg.targetScore}` }), 'Win condition'),
          el('div', { class: 'meta-cell' }, el('b', { text: mins }), 'Expected duration'),
          el('div', { class: 'meta-cell' }, el('b', { text: cfg.players ?? '1 vs AI' }), 'Players'),
          el('div', { class: 'meta-cell' }, el('b', { text: cfg.ranked ? 'Ranked' : 'Unranked' }), cfg.ranked ? 'Counts on boards' : 'No rating effect'),
        ),
        cfg.extras ?? null,
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn primary', onclick: () => this.emit('begin', cfg) }, 'Start'),
          el('button', { class: 'btn', onclick: () => this.emit('back') }, 'Back'),
        ),
      )));
  }

  _backRow() {
    return el('div', { class: 'btn-row' },
      el('button', { class: 'btn', onclick: () => this.emit('back') }, 'Back'));
  }

  // ---------------------------------------------------------------- pause

  showPause(contextLabel) {
    this.show('pause', () => el('section', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paused' },
      el('div', { class: 'panel' },
        el('h2', { text: 'Paused' }),
        el('p', { class: 'dim', text: contextLabel }),
        el('div', { class: 'menu' },
          el('button', { class: 'btn primary', onclick: () => this.emit('resume') }, 'Resume'),
          el('button', { class: 'btn', onclick: () => this.emit('show-settings', { from: 'pause' }) }, 'Settings'),
          el('button', { class: 'btn', onclick: () => this.emit('show-help', { from: 'pause' }) }, 'How to Play'),
          el('button', { class: 'btn', onclick: () => this.emit('restart') }, 'Restart'),
          el('button', { class: 'btn danger', onclick: () => this.emit('leave') }, 'Leave Match'),
        ),
      )));
  }

  // ---------------------------------------------------------------- results

  showResults({ headline, sub, breakdown, names, achievements = [], stars = null, next = null, canRetry = true }) {
    const rows = [
      ['Goals', p => p.goals], ['Shots', p => p.shots], ['Saves', p => p.saves],
      ['Steals', p => p.steals], ['Invalid actions', p => p.invalidActions],
      ['Rail bounces', p => p.wallBounces], ['Fastest strike', p => `${p.maxPuckSpeed} u/s`],
    ];
    const table = el('table', { class: 'breakdown' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Component' }),
        el('th', { text: names?.[0] ?? 'You' }),
        el('th', { text: names?.[1] ?? 'Opponent' }))),
      el('tbody', {}, rows.map(([label, fn]) => el('tr', {},
        el('td', { text: label }),
        el('td', { text: String(fn(breakdown.players[0])) }),
        el('td', { text: String(fn(breakdown.players[1])) })))),
      el('tfoot', {}, el('tr', {},
        el('td', { text: 'Duration' }),
        el('td', { colspan: 2, text: `${Math.round(breakdown.players[0].elapsedTicks / 60)}s · ${TERMINAL_LABEL[breakdown.reason] ?? breakdown.reason}` }))),
    );
    this.show('results', () => el('section', { role: 'dialog', 'aria-label': 'Match results' },
      el('div', { class: 'panel' },
        el('h2', { class: 'center', text: headline }),
        sub ? el('p', { class: 'center dim', text: sub }) : null,
        stars != null ? el('p', { class: 'center', style: 'font-size:1.6rem;color:var(--accent-gold)', text: '★'.repeat(stars) + '☆'.repeat(3 - stars) }) : null,
        table,
        achievements.length ? el('div', {},
          el('h3', { text: 'Achievements unlocked' }),
          ...achievements.map(a => el('p', { text: `🏆 ${a.name} — ${a.description}` }))) : null,
        el('div', { class: 'btn-row' },
          canRetry ? el('button', { class: 'btn primary', onclick: () => this.emit('retry') }, 'Retry') : null,
          next ? el('button', { class: 'btn primary', onclick: () => this.emit('next') }, next) : null,
          el('button', { class: 'btn', onclick: () => this.emit('leave') }, 'Menu'),
        ),
      )));
  }

  // ---------------------------------------------------------------- help

  showHelp(opts = {}) {
    const k = this.platform.settings.keys;
    const card = (title, body) => el('div', { class: 'meta-cell' },
      el('b', { text: title, style: 'font-size:0.95rem' }), body);
    this.show('help', () => el('section', { role: 'dialog', 'aria-label': 'How to play' },
      el('div', { class: 'panel' },
        el('h2', { text: 'How to Play' }),
        el('p', { text: 'Defend the glowing goal at your end. Strike the puck into your opponent\u2019s goal. First to the target score wins.' }),
        el('div', { class: 'meta-grid' },
          card('Move', `Drag anywhere in your half, or use ${prettyKey(k.up)}/${prettyKey(k.down)}/${prettyKey(k.left)}/${prettyKey(k.right)}. Your mallet cannot cross the centre line.`),
          card('Strike', 'Meet the puck with your mallet. Hit through it toward the far goal; faster mallets strike harder.'),
          card('Defend', 'Guard your goal mouth when the puck approaches. Blocks from deep in your half count as saves.'),
          card('Rails', 'The luminous rails are live — bank shots off them to bend around defenders.'),
          card('Pause', `${prettyKey(k.pause)} pauses. ${prettyKey(k.undo)} undoes in Practice. ${prettyKey(k.camera)} recentres the camera.`),
          card('Gamepad', 'Left stick moves, Start pauses. Buttons can be remapped by your platform.'),
        ),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn', onclick: () => this.emit('help-back', opts) }, 'Back')),
      )));
  }

  // ---------------------------------------------------------------- settings

  showSettings(opts = {}) {
    const s = this.platform.settings;
    const P = this.platform;
    const slider = (label, key, min = 0, max = 1) => el('div', { class: 'setting-row' },
      el('label', { for: `set-${key}`, text: label }),
      el('input', {
        type: 'range', id: `set-${key}`, min, max, step: 0.05, value: s[key],
        oninput: (e) => { P.updateSettings({ [key]: Number(e.target.value) }); this.audio.applyVolumes(); },
      }));
    const toggle = (label, key) => el('div', { class: 'setting-row' },
      el('label', { for: `set-${key}`, text: label }),
      el('input', {
        type: 'checkbox', id: `set-${key}`, checked: s[key],
        onchange: (e) => { P.updateSettings({ [key]: e.target.checked }); this.emit('settings-changed', { [key]: e.target.checked }); },
      }));
    const select = (label, key, options) => el('div', { class: 'setting-row' },
      el('label', { for: `set-${key}`, text: label }),
      el('select', {
        id: `set-${key}`,
        onchange: (e) => { P.updateSettings({ [key]: e.target.value }); this.emit('settings-changed', { [key]: e.target.value }); },
      }, options.map(([v, t]) => el('option', { value: v, text: t, selected: s[key] === v }))));

    const keyRow = (label, key) => {
      const btn = el('button', { class: 'btn small', text: prettyKey(s.keys[key]), 'aria-label': `Remap ${label}` });
      btn.addEventListener('click', () => {
        btn.textContent = 'press a key…';
        const onKey = (e) => {
          e.preventDefault();
          P.updateSettings({ keys: { ...P.settings.keys, [key]: e.code } });
          btn.textContent = prettyKey(e.code);
          window.removeEventListener('keydown', onKey, true);
        };
        window.addEventListener('keydown', onKey, { capture: true, once: true });
      });
      return el('div', { class: 'setting-row' }, el('label', { text: label }), btn);
    };

    this.show('settings', () => el('section', { role: 'dialog', 'aria-label': 'Settings' },
      el('div', { class: 'panel' },
        el('h2', { text: 'Settings' }),
        el('div', { class: 'settings-group' },
          el('h3', { text: 'Audio' }),
          slider('Music', 'volumeMusic'),
          slider('Effects', 'volumeEffects'),
          slider('Ambience', 'volumeAmbience'),
          slider('Voice', 'volumeVoice'),
          toggle('Mute all', 'muted'),
          toggle('Captions for audio cues', 'captions'),
        ),
        el('div', { class: 'settings-group' },
          el('h3', { text: 'Graphics' }),
          select('Quality tier', 'quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]),
          toggle('Reduced motion', 'reducedMotion'),
          toggle('High contrast', 'highContrast'),
          select('Colour palette', 'palette', [['default', 'Default'], ['deuteranopia', 'Deuteranopia-safe'], ['protanopia', 'Protanopia-safe'], ['tritanopia', 'Tritanopia-safe']]),
        ),
        el('div', { class: 'settings-group' },
          el('h3', { text: 'Controls' }),
          toggle('Left-handed layout', 'leftHanded'),
          toggle('Hold to aim (vs. follow)', 'holdToAim'),
          toggle('Timing assistance', 'timingAssist'),
          toggle('Haptics', 'haptics'),
          keyRow('Move up', 'up'), keyRow('Move down', 'down'),
          keyRow('Move left', 'left'), keyRow('Move right', 'right'),
          keyRow('Pause', 'pause'), keyRow('Undo', 'undo'), keyRow('Camera reset', 'camera'),
        ),
        el('div', { class: 'settings-group' },
          el('h3', { text: 'Text & Privacy' }),
          slider('Text size', 'textScale', 0.85, 1.4),
          toggle('Anonymous usage funnel', 'telemetryConsent'),
          el('div', { class: 'setting-row' },
            el('label', { text: 'Tutorial' }),
            el('button', { class: 'btn small', onclick: () => this.emit('replay-tutorial') }, 'Replay lessons')),
        ),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn', onclick: () => this.emit('settings-back', opts) }, 'Back')),
      )));
  }

  // ---------------------------------------------------------------- achievements & boards

  showAchievements() {
    const unlocked = this.platform.save.achievements;
    this.show('achievements', () => el('section', { 'aria-label': 'Achievements' },
      el('div', { class: 'panel' },
        el('h2', { text: 'Achievements' }),
        el('div', { class: 'list' },
          ACHIEVEMENTS.map(a => el('div', {
            class: `list-item${unlocked[a.key] ? ' done' : ''}`, role: 'listitem',
          },
            el('span', { text: unlocked[a.key] ? '🏆' : '🔒' }),
            el('span', {}, a.name, el('span', { class: 'sub dim', text: a.description })),
            unlocked[a.key] ? el('span', { class: 'tag', text: 'UNLOCKED' }) : null,
          ))),
        this._backRow(),
      )));
  }

  showLeaderboard(dailyEntries = [], journeyEntries = []) {
    const entryRow = (e) => el('div', { class: 'list-item' },
      el('span', { text: e.name ?? 'You' }),
      el('span', { class: 'dim', text: `${Math.round(e.durationTicks / 60)}s` }),
      el('span', { class: 'stars', text: `${e.score}` }));
    this.show('leaderboard', () => el('section', { 'aria-label': 'Leaderboards' },
      el('div', { class: 'panel' },
        el('h2', { text: 'Leaderboards' }),
        el('h3', { text: 'Daily (shared seed)' }),
        dailyEntries.length ? el('div', { class: 'list' }, dailyEntries.map(entryRow))
          : el('p', { class: 'dim', text: 'No daily results yet — play today’s seed.' }),
        el('h3', { text: 'Journey mastery' }),
        journeyEntries.length ? el('div', { class: 'list' }, journeyEntries.map(entryRow))
          : el('p', { class: 'dim', text: 'Clear a Mastery stage to post a time.' }),
        el('p', { class: 'dim', text: 'Hosted sessions use server-authoritative boards.' }),
        this._backRow(),
      )));
  }

  // ---------------------------------------------------------------- lobby

  showLobby(state) {
    // state: { status, roomCode, players, chat: [{from,text}], error }
    this.show('lobby', () => {
      const chatLog = el('div', { class: 'chat-log', id: 'chat-log', role: 'log', 'aria-label': 'Lobby chat' },
        (state.chat ?? []).map(m => el('p', {}, el('b', { text: `${m.from}: ` }), m.text)));
      const input = el('input', { type: 'text', maxlength: 200, 'aria-label': 'Chat message', placeholder: 'Message (10/min max)' });
      const joinInput = el('input', { type: 'text', maxlength: 5, placeholder: 'CODE', 'aria-label': 'Room code',
        style: 'text-transform:uppercase;width:90px' });
      return el('section', { 'aria-label': 'Hosted play lobby' },
        el('div', { class: 'panel' },
          el('h2', { text: 'Hosted Play' }),
          el('p', { class: 'dim', text: state.status }),
          state.roomCode ? el('p', { class: 'center' },
            'Room code: ', el('b', { class: 'mono', style: 'font-size:1.4rem;letter-spacing:0.2em', text: state.roomCode })) : null,
          el('div', { class: 'list' },
            (state.players ?? []).map(p => el('div', { class: 'list-item' },
              el('span', { text: p }),
            ))),
          el('div', { class: 'btn-row' },
            !state.roomCode ? el('button', { class: 'btn primary', onclick: () => this.emit('lobby-create') }, 'Create Room') : null,
            !state.roomCode ? el('div', { style: 'display:flex;gap:6px;flex:1' },
              joinInput,
              el('button', { class: 'btn', onclick: () => this.emit('lobby-join', joinInput.value.trim().toUpperCase()) }, 'Join')) : null,
            state.canStartAI ? el('button', { class: 'btn', onclick: () => this.emit('lobby-start-ai') }, 'Start vs AI') : null,
            el('button', { class: 'btn danger', onclick: () => this.emit('lobby-leave') }, state.roomCode ? 'Leave Room' : 'Back'),
          ),
          state.roomCode ? el('details', { class: 'chat-panel' },
            el('summary', { text: 'Chat' }),
            chatLog,
            el('form', {
              class: 'chat-form',
              onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) { this.emit('lobby-chat', input.value.trim()); input.value = ''; } },
            }, input, el('button', { class: 'btn small', type: 'submit', text: 'Send' })),
          ) : null,
        ));
    });
  }

  showBoot(pct, label) {
    if (!this._boot) {
      this._boot = el('section', { class: 'screen', id: 'boot-screen', 'aria-label': 'Loading' },
        el('div', { class: 'panel' },
          el('h1', { class: 'title-logo', text: 'GLOW STRIKERS' }),
          el('p', { class: 'dim', id: 'boot-label' }),
          el('div', { class: 'progress' }, el('div', { id: 'boot-bar' }))));
      this.screensRoot.append(this._boot);
    }
    $('#boot-bar').style.width = `${pct}%`;
    $('#boot-label').textContent = label;
    if (pct >= 100) { this._boot.remove(); this._boot = null; }
  }
}

function prettyKey(code) {
  return code.replace(/^Key/, '').replace(/^Arrow/, '').replace('Escape', 'Esc');
}
