// Original synthesized audio: short transients tied to logical events, layered
// material impacts, quiet ambience and adaptive music stems. Buses: music,
// effects, ambience, voice — independently mixed. A caption hook surfaces
// meaningful audio as text so nothing is audio-only.

import { RngStream } from './rng.js';

// Authored one-shot samples (sfx/manifest.json) backing logical events. Each
// clip is lazy-fetched/decoded/cached after the user-gesture unlock; synthesis
// remains the fallback while a clip loads or if it is missing.
const SFX_BY_EVENT = {
  ui: 'ui-tap',
  'ui-back': 'ui-back',
  invalid: 'invalid-buzz',
  strike: 'puck-strike',
  wall: 'wall-bank',
  obstacle: 'obstacle-clack',
  countdown: 'countdown-tick',
  go: 'go-whistle',
  goal: 'goal-horn',
  win: 'win-fanfare',
  lose: 'lose-sting',
  achievement: 'achievement-chime',
  overtime: 'overtime-siren',
  budget: 'budget-empty',
};

export class AudioEngine {
  constructor(settings, onCaption = null) {
    this.settings = settings;
    this.onCaption = onCaption;
    this.ctx = null;
    this.buses = {};
    this.rng = new RngStream(0xA0D10, 3);
    this.musicState = { playing: false, intensity: 0, timer: null };
    this.samples = new Map(); // clip name -> { status: 'loading'|'ready'|'failed', buffer }
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.master = master;
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.connect(master);
      this.buses[name] = g;
    }
    this.applyVolumes();
    this._startAmbience();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    const mute = s.muted ? 0 : 1;
    this.buses.music.gain.value = s.volumeMusic * mute;
    this.buses.effects.gain.value = s.volumeEffects * mute;
    this.buses.ambience.gain.value = s.volumeAmbience * mute * 0.5;
    this.buses.voice.gain.value = s.volumeVoice * mute;
  }

  suspend() { this.ctx?.suspend(); }

  _env(gain, t, a, d, peak = 1) {
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _osc(type, freq, t0, dur, bus, peak = 0.5, freqEnd = null) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    this._env(g, t0, 0.005, dur, peak);
    o.connect(g).connect(bus);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  _noise(t0, dur, bus, peak = 0.3, filterFreq = 2000, q = 1) {
    const c = this.ctx;
    const len = Math.ceil(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (this.rng.float() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = filterFreq; f.Q.value = q;
    const g = c.createGain();
    this._env(g, t0, 0.002, dur, peak);
    src.connect(f).connect(g).connect(bus);
    src.start(t0);
  }

  _caption(text) { if (this.settings.captions && this.onCaption) this.onCaption(text); }

  /** Caption text for a logical event, so sampled playback stays captioned. */
  _captionFor(name, opts = {}) {
    switch (name) {
      case 'invalid': this._caption('Invalid action'); break;
      case 'countdown': this._caption(`Starting in ${opts.remaining}`); break;
      case 'go': this._caption('Go!'); break;
      case 'goal': this._caption(opts.scorer === 0 ? 'Goal for you!' : 'Goal conceded'); break;
      case 'win': this._caption('Victory'); break;
      case 'lose': this._caption('Defeat'); break;
      case 'achievement': this._caption('Achievement unlocked'); break;
      case 'overtime': this._caption('Overtime — golden goal'); break;
      case 'budget': this._caption('Move budget exhausted'); break;
    }
  }

  /** Start loading a clip (once) and return its cache entry. */
  _loadSample(name) {
    let entry = this.samples.get(name);
    if (entry) return entry;
    entry = { status: 'loading', buffer: null };
    this.samples.set(name, entry);
    fetch(`sfx/${name}.opus`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { entry.status = 'ready'; entry.buffer = buf; })
      .catch(() => { entry.status = 'failed'; });
    return entry;
  }

  /** Play a cached clip through the effects bus. False while loading/failed. */
  _playSample(name) {
    if (this._loadSample(name).status !== 'ready') return false;
    const src = this.ctx.createBufferSource();
    src.buffer = this.samples.get(name).buffer;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  /** Map a logical event to a transient. `tier` scales emphasis. */
  event(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this._captionFor(name, opts);
    const clip = SFX_BY_EVENT[name];
    if (clip && this._playSample(clip)) return;
    const t = this.ctx.currentTime;
    const fx = this.buses.effects;
    const v = this.rng.range(0.94, 1.06); // seeded pitch variant
    switch (name) {
      case 'ui': this._osc('triangle', 660 * v, t, 0.06, fx, 0.18); break;
      case 'ui-back': this._osc('triangle', 440 * v, t, 0.07, fx, 0.15); break;
      case 'invalid': this._osc('square', 160, t, 0.12, fx, 0.12, 110); break;
      case 'strike': {
        const k = Math.min(1, (opts.speed ?? 80) / 260);
        this._noise(t, 0.08, fx, 0.25 + k * 0.3, 1800 + k * 2400, 2);
        this._osc('sine', 220 * v + k * 120, t, 0.1, fx, 0.25 + k * 0.2, 90);
        break;
      }
      case 'wall': this._noise(t, 0.05, fx, 0.14, 3200 * v, 3); break;
      case 'obstacle': this._noise(t, 0.07, fx, 0.2, 1200 * v, 4); this._osc('sine', 500 * v, t, 0.08, fx, 0.15); break;
      case 'countdown': this._osc('sine', 520, t, 0.12, fx, 0.3); break;
      case 'go': this._osc('sine', 880, t, 0.25, fx, 0.35); break;
      case 'goal': {
        const base = opts.scorer === 0 ? [523, 659, 784] : [392, 330, 262];
        base.forEach((f, i) => this._osc('triangle', f, t + i * 0.09, 0.28, fx, 0.3));
        this._noise(t, 0.3, fx, 0.2, 900, 1);
        break;
      }
      case 'win': [523, 659, 784, 1046].forEach((f, i) => this._osc('triangle', f, t + i * 0.12, 0.35, fx, 0.3)); break;
      case 'lose': [392, 330, 262, 196].forEach((f, i) => this._osc('triangle', f, t + i * 0.12, 0.35, fx, 0.25)); break;
      case 'achievement': this._osc('sine', 1046, t, 0.15, fx, 0.25); this._osc('sine', 1568, t + 0.12, 0.3, fx, 0.22); break;
      case 'overtime': this._osc('sawtooth', 220, t, 0.4, fx, 0.2, 440); break;
      case 'budget': this._osc('square', 240, t, 0.2, fx, 0.15, 180); break;
    }
  }

  // --- ambience: quiet filtered pad ------------------------------------------------

  _startAmbience() {
    const c = this.ctx;
    const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55;
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.5;
    const g = c.createGain(); g.gain.value = 0.05;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = c.createGain(); lfoG.gain.value = 0.02;
    lfo.connect(lfoG).connect(g.gain);
    o1.connect(g); o2.connect(g);
    g.connect(this.buses.ambience);
    o1.start(); o2.start(); lfo.start();
  }

  // --- adaptive music: two-stem loop, intensity follows puck pressure -----------------

  setMusicIntensity(x) { this.musicState.intensity = Math.max(0, Math.min(1, x)); }

  startMusic() {
    if (!this.ctx || this.musicState.playing) return;
    this.musicState.playing = true;
    const c = this.ctx;
    const bus = this.buses.music;
    const bassNotes = [110, 110, 130.8, 98];
    let beat = 0;
    const tickMusic = () => {
      if (!this.musicState.playing || c.state !== 'running') return;
      const t = c.currentTime;
      const bar = Math.floor(beat / 4) % 4;
      // bass stem always
      if (beat % 2 === 0) this._osc('triangle', bassNotes[bar] / 2, t, 0.4, bus, 0.12);
      // arp stem fades in with intensity
      if (this.musicState.intensity > 0.35) {
        const arp = [220, 261.6, 329.6, 261.6][beat % 4] * (bar === 3 ? 0.891 : 1);
        this._osc('sine', arp, t, 0.18, bus, 0.08 * this.musicState.intensity);
      }
      beat++;
      this.musicState.timer = setTimeout(tickMusic, 300);
    };
    tickMusic();
  }

  stopMusic() {
    this.musicState.playing = false;
    clearTimeout(this.musicState.timer);
  }
}
