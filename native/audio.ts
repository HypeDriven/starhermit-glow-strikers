// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, the event table of sfx/manifest.json) per logical event,
// a quiet ambience pad (55 Hz and 82.5 Hz sines breathing with a slow LFO)
// under everything, and the adaptive two-stem music under a match — a
// triangle bass note every other 300 ms beat through a four-bar progression,
// and a sine arpeggio that fades in as the puck's speed (the music intensity)
// passes 0.35. Every meaningful cue also emits a caption (setOnCaption).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects,
// ambience and the voice cues → "effects", the UI taps → "interface". The old
// default bus levels (music 60 %, effects 80 %, ambience 25 %) are folded
// into each sound's gain. The synthesized stand-ins it played while a sample
// loaded are not ported, and the pad and the music notes are rendered once
// into clips on OfflineAudioContext with the old envelopes: the engine's browser
// runtime drops clip loads and plays while a live synthesis graph changes
// (the arrow-exodus port's finding). The clips all load at once in onStart
// (every loaded clip reaches the mixer, natively and on the web); the pad
// and the music start once the mixer runs (in a browser after the first
// press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.6, effects: 0.8, ambience: 0.25 };
/** Logical event → authored sample basename (sfx/manifest.json). */
const SAMPLES: Record<string, string> = {
  ui: "ui-tap", "ui-back": "ui-back", invalid: "invalid-buzz", strike: "puck-strike", wall: "wall-bank",
  obstacle: "obstacle-clack", countdown: "countdown-tick", go: "go-whistle", goal: "goal-horn", win: "win-fanfare",
  lose: "lose-sting", achievement: "achievement-chime", overtime: "overtime-siren", budget: "budget-empty",
  "clock-warning": "clock-warning", save: "save-block", draw: "draw-sting", undo: "undo-rewind", chat: "chat-ping",
};
/** The caption keys (English source strings; main.ts translates them) per event. */
export type CaptionKind = "invalid" | "countdown" | "go" | "goal-you" | "goal-opp" | "win" | "lose" | "achievement" | "overtime" | "budget" | "clock-warning" | "save" | "draw";

const clips = new Map<string, AudioClip>();
let onCaption: ((kind: CaptionKind, detail: { remaining?: number }) => void) | null = null;

/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  renderAll();
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
}
export function setOnCaption(cb: (kind: CaptionKind, detail: { remaining?: number }) => void): void { onCaption = cb; }

function caption(name: string, opts: { remaining?: number; scorer?: number }): void {
  if (!onCaption) return;
  switch (name) {
    case "invalid": case "countdown": case "go": case "win": case "lose": case "achievement":
    case "overtime": case "budget": case "clock-warning": case "save": case "draw":
      onCaption(name, opts); break;
    case "goal": onCaption(opts.scorer === 0 ? "goal-you" : "goal-opp", opts); break;
  }
}

/** Plays a logical event's sample (and emits its caption). */
export function event(name: string, opts: { remaining?: number; scorer?: number; speed?: number } = {}): void {
  caption(name, opts);
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  const bus: Bus = name === "ui" || name === "ui-back" ? "interface" : "effects";
  // A strike's loudness follows the puck's speed, as the synthesized hit did.
  const gain = LEVEL.effects * (name === "strike" ? 0.6 + 0.4 * Math.min(1, (opts.speed ?? 80) / 260) : 1);
  try { playClip(clip, { bus, gain }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered synthesis (one offline context per clip) ---------------------------------
const RATE = 22050;
/** js/audio.js _osc: a 5 ms attack and an exponential fall to 0.0001 over `dur`. */
async function renderNote(type: "sine" | "triangle", freq: number, dur: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round((dur + 0.05) * RATE), RATE);
  const osc = off.createOscillator();
  osc.type = type; osc.frequency.value = freq;
  const g = off.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, 0.005 + dur);
  osc.connect(g).connect(off.destination);
  osc.start();
  return createClip(await off.startRendering());
}
/** The ambience pad: 55 Hz + 82.5 Hz sines at 0.05, breathing ±0.02 with a 1/14 Hz LFO, one seamless 14 s loop. */
async function renderPad(): Promise<AudioClip> {
  const L = 14, rate = 11025;
  const off = new OfflineAudioContext(1, L * rate, rate);
  const g = off.createGain();
  g.gain.value = 0.05;
  const lfo = off.createOscillator(), depth = off.createGain();
  lfo.frequency.value = 1 / L; depth.gain.value = 0.02;
  lfo.connect(depth).connect(g.gain);
  lfo.start();
  for (const f of [55, 82.5]) { const o = off.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); }
  g.connect(off.destination);
  return createClip(await off.startRendering());
}

const BASS = [110, 110, 130.8, 98];
const ARP = [220, 261.6, 329.6, 261.6];
const notes = new Map<string, AudioClip>();
function renderAll(): void {
  const keep = (id: string, r: Promise<AudioClip>): void => { r.then((c) => { notes.set(id, c); }, (e: unknown) => console.warn(`audio ${id}: ${String(e)}`)); };
  keep("pad", renderPad());
  for (const f of new Set(BASS)) keep(`bass:${f}`, renderNote("triangle", f / 2, 0.4));
  for (const f of new Set(ARP.flatMap((x) => [x, x * 0.891]))) keep(`arp:${f}`, renderNote("sine", f, 0.18));
}

let music = false;
let intensity = 0;
let beat = 0;
let nextBeat = 0;
let pad: Sound | null = null;

export function setMusicIntensity(x: number): void { intensity = Math.max(0, Math.min(1, x)); }
export function startMusic(): void { if (music) return; music = true; beat = 0; nextBeat = 0; }
export function stopMusic(): void { music = false; }

/** Each frame once the mixer runs: the pad once it is made, then the music's beats by mixer time. */
export function update(): void {
  if (context.state !== "running") return; // starting the pad and the music still waits for the mixer
  try {
    const padClip = notes.get("pad");
    if (!pad && padClip) pad = playClip(padClip, { bus: "effects", gain: LEVEL.ambience, loop: true });
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!music) return;
  const now = context.currentTime;
  if (now < nextBeat) return;
  nextBeat = Math.max(now, nextBeat) + 0.3;
  if (nextBeat < now) nextBeat = now + 0.3;
  const bar = Math.floor(beat / 4) % 4;
  try {
    if (beat % 2 === 0) {
      const c = notes.get(`bass:${BASS[bar]}`);
      if (c) playClip(c, { bus: "music", gain: 0.12 * LEVEL.music });
    }
    if (intensity > 0.35) {
      const f = ARP[beat % 4]! * (bar === 3 ? 0.891 : 1);
      const c = notes.get(`arp:${f}`);
      if (c) playClip(c, { bus: "music", gain: 0.08 * intensity * LEVEL.music });
    }
  } catch { /* the mixer is full */ }
  beat++;
}
