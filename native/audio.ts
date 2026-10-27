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
// into clips (createClip) with the old envelopes: the engine's browser
// runtime drops clip loads and plays while a live synthesis graph changes
// (the arrow-exodus port's finding). Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

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
const queue: string[] = [];
let loading = false;
let wantClips = false;
let onCaption: ((kind: CaptionKind, detail: { remaining?: number }) => void) | null = null;

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
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
  catch { clips.delete(file!); load(file!); }
}

// -- rendered synthesis -----------------------------------------------------------------
const RATE = 22050;
function env(t: number, a: number, d: number, peak: number): number {
  if (t < a) return (t / a) * peak;
  const k = (t - a) / d;
  return k >= 1 ? 0 : peak * Math.pow(0.0001 / peak, k);
}
function wave(type: "sine" | "triangle", phase: number): number {
  if (type === "sine") return Math.sin(2 * Math.PI * phase);
  const p = phase - Math.floor(phase);
  return p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4;
}
/** js/audio.js _osc: a 5 ms attack and an exponential fall to 0.0001 over `dur`. */
function noteClip(type: "sine" | "triangle", freq: number, dur: number): AudioClip {
  const n = Math.round((dur + 0.05) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = wave(type, freq * t) * env(t, 0.005, dur, 1);
  }
  return createClip([out], RATE);
}
/** The ambience pad: 55 Hz + 82.5 Hz sines at 0.05, breathing ±0.02 with a 1/14 Hz LFO, one seamless 14 s loop. */
function padClip(): AudioClip {
  const L = 14, rate = 11025;
  const n = L * rate;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const g = 0.05 + 0.02 * Math.sin((2 * Math.PI * t) / L);
    out[i] = (Math.sin(2 * Math.PI * 55 * t) + Math.sin(2 * Math.PI * 82.5 * t)) * g;
  }
  return createClip([out], rate);
}

const BASS = [110, 110, 130.8, 98];
const ARP = [220, 261.6, 329.6, 261.6];
const notes = new Map<string, AudioClip>();
const toRender: { id: string; make: () => AudioClip }[] = [
  { id: "pad", make: padClip },
  ...BASS.filter((f, i) => BASS.indexOf(f) === i).map((f) => ({ id: `bass:${f}`, make: () => noteClip("triangle", f / 2, 0.4) })),
  ...ARP.flatMap((f) => [f, f * 0.891]).filter((f, i, a) => a.indexOf(f) === i).map((f) => ({ id: `arp:${f}`, make: () => noteClip("sine", f, 0.18) })),
];

let music = false;
let intensity = 0;
let beat = 0;
let nextBeat = 0;
let pad: Sound | null = null;

export function setMusicIntensity(x: number): void { intensity = Math.max(0, Math.min(1, x)); }
export function startMusic(): void { if (music) return; music = true; beat = 0; nextBeat = 0; }
export function stopMusic(): void { music = false; }

/** Each frame: the clips once the mixer runs, one rendered note a frame, the pad once it is made, then the music's beats by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of new Set(Object.values(SAMPLES))) load(name);
    return;
  }
  pump();
  if (loading || queue.length) return;
  try {
    const next = toRender.find((r) => !notes.has(r.id));
    if (next) { notes.set(next.id, next.make()); return; }
    if (!pad) pad = playClip(notes.get("pad")!, { bus: "effects", gain: LEVEL.ambience, loop: true });
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
