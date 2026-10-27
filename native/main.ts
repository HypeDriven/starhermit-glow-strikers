// Glow Strikers on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, AI, session, content and progress
// rules are the browser build's js/rules.js, js/ai.js, js/session.js,
// js/content.js (unchanged) and js/progress.js (its platform.js's data
// rules); this module is what js/main.js did around them — the state machine
// (title → mode lists → setup → countdown → active ⇄ paused → results →
// progression, with help, settings, achievements and leaderboards as
// screens), the lessons, undo and hints, results, stars, achievements and
// personal bests, the score posting, input routing (actions, the pointer and
// touch on the table, the analog stick) and hosted matches (net.ts) — with
// the screens and HUD drawn by screens.ts (starhermit:ui) and the arena by
// render.ts (starhermit:scene).
//
// The simulation clock is the runtime's fixed steps (60 a second, the rules'
// DT): one rules tick a step while a solo match is live (timing assistance
// runs it at 85 %, as before), so pausing, a hidden window and a slow frame
// never move the puck, and play scripts replay exactly. The lessons' delays
// count the same steps.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, pointer, primaryPointer, value, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onPlayerChange, onSessionEnded, player, serverNow } from "starhermit:platform";
import * as rules from "../js/rules.js";
import { Session } from "../js/session.js";
import { createAI } from "../js/ai.js";
import { JOURNEY, LESSONS, CONTENT_VERSION, RULESET_ID, dailyConfig, dailyKey, validateContent } from "../js/content.js";
import * as audio from "./audio.ts";
import { P, T, onLanguage, type Vars } from "./i18n.ts";
import { Hosted, type Over, type Snap } from "./net.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

const DT = rules.DT;
type State = ReturnType<typeof rules.createMatch>;
type Breakdown = ReturnType<typeof rules.resultBreakdown>;
export type Content = {
  id: string; name?: string; seed: number; targetScore: number; timeLimitSeconds?: number; obstacles?: { x: number; y: number; r: number }[];
  moveBudget?: number[] | null; overtime?: boolean; ai?: { skill: number } | null; themeId?: string; index?: number; mastery?: boolean;
  mechanics?: string[]; par?: { winBy: number; underSeconds: number }; shutout?: boolean; description?: string; difficulty?: string; version?: number;
};
export type Lesson = (typeof LESSONS)[number];
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "hosted";
export type ScreenName = "title" | "journey" | "challenges" | "learn" | "setup" | "pause" | "results" | "help" | "settings" | "achievements" | "leaderboard" | "lobby" | "expired";
export interface SetupView { title: string; description: string; targetScore: number; timeLimitSeconds: number; ranked: boolean; practice: boolean; content: Content | null }
export interface ResultsView {
  headline: string; sub: string; breakdown: Breakdown; names: [string, string];
  achievements: { name: string; description: string }[]; stars: number | null; next: string | null; canRetry: boolean;
  lb: { pending?: boolean; posted?: boolean; rank?: number | null } | null;
}
export interface Pose { puck: { x: number; y: number }; mallets: { x: number; y: number }[] }

// Journey mechanic tags (shown in stage setup and lists).
export const MECHANICS: Record<string, string> = { strike: "strike", defend: "defend", obstacles: "obstacles", "time-pressure": "time pressure", "move-budget": "move budget", combined: "combined" };
export const DIFFICULTIES = [
  { name: "Relaxed", skill: 0.25 }, { name: "Club", skill: 0.5 }, { name: "Pro", skill: 0.75 }, { name: "Legend", skill: 0.92 },
];

export const settings = platform.settings;
export const hosted = new Hosted({
  lobby: () => undefined,
  start: () => hostedStart(),
  snap: (s) => hostedSnap(s),
  over: (o) => hostedOver(o),
  chat: (line) => { audio.event("chat"); if (app.screen !== "lobby") toast(`${line.from}: ${line.text.slice(0, 60)}`); },
  toast: (key, vars) => toast(T(key, vars)),
  ended: (reason) => hostedEnded(reason),
});

export const app = {
  screen: "title" as ScreenName | null,
  /** Frame the screen opened on (the action that opened it must not also close it). */
  openedFrame: 0,
  focusNext: false,
  /** Where Back from Settings / Help goes. */
  returnTo: "title" as ScreenName,
  session: null as Session | null,
  matchCfg: null as Content | null,
  mode: null as Mode | null,
  ai: null as ReturnType<typeof createAI> | null,
  paused: false,
  lesson: null as Lesson | null,
  lessonState: null as null | { travel: number; survived: number; sawWall: boolean; done: boolean; lastX: number; lastY: number },
  prevPos: null as Pose | null,
  curPos: null as Pose | null,
  keyTarget: null as { x: number; y: number } | null,
  setup: null as SetupView | null,
  practiceDifficulty: 1,
  results: null as ResultsView | null,
  lb: null as null | { platform: { ok: boolean; entries: platform.BoardRow[] } | null | "loading"; daily: ReturnType<typeof platform.getBoard>; journey: ReturnType<typeof platform.getBoard> },
  // HUD
  objective: "",
  scores: [0, 0] as number[],
  clock: "0:00",
  budget: null as string | null,
  banner: null as { text: string; until: number; assertive: boolean } | null,
  caption: null as { text: string; until: number } | null,
  toasts: [] as { text: string; until: number }[],
  boardState: false,
  boardText: "",
  lastSaves: 0,
  clockWarned: false,
  stepAcc: 0,
  expiredReason: "expired" as "expired" | "terms-required",
  signedOut: false,
  /** Lobby text fields. */
  joinCode: "",
  chatText: "",
};

const now = (): number => frame().time;
export function toast(text: string): void { app.toasts.push({ text, until: now() + 3.5 }); if (app.toasts.length > 4) app.toasts.shift(); }
export function announce(text: string, assertive = false): void { if (text) ui.announce(text, { politeness: assertive ? "assertive" : "polite" }); }
export function caption(text: string): void { app.caption = { text, until: now() + 2.5 }; }
function banner(text: string, assertive = true): void {
  app.banner = { text, until: now() + 1.4, assertive };
  if (assertive) announce(text, true);
}
function haptic(ms: number): void { if (settings.haptics) vibrate(ms); }
function setObjectiveText(text: string): void { if (text !== app.objective) { app.objective = text; announce(text); } }
function setScores(a: number, b: number): void {
  if (a !== app.scores[0] || b !== app.scores[1]) { app.scores = [a, b]; announce(T("Score: you {you}, opponent {opp}", { you: a, opp: b })); }
}

/** The platform's day (serverNow), else the device's. */
export function today(): Date { const t = serverNow(); return new Date(t ?? Date.now()); }
export function secondsUntilNextDaily(): number {
  const n = today();
  return Math.max(0, Math.round((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000));
}
export function yourName(): string { return platform.displayName() ?? T("You"); }

/** Localized display name of a match config (content names stay English keys). */
export function cfgName(c: Content | null): string {
  if (!c) return T("Match");
  if (c.id === "practice") return T("Practice — {name}", { name: T(c.difficulty ?? "Club") });
  if (String(c.id).startsWith("daily-")) return T("Daily — {day}", { day: String(c.id).slice(6) });
  if (String(c.id).startsWith("hosted-")) return T("Hosted · Room {room}", { room: String(c.id).slice(7) });
  return T(c.name ?? "Match");
}

// ------------------------------------------------------------------ screens
export function showScreen(name: ScreenName | null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = !!name;
  if (!name) ui.setFocus(null);
}
export function openOverlay(name: "settings" | "help"): void {
  app.returnTo = app.screen === "pause" ? "pause" : "title";
  showScreen(name);
}
export function closeOverlay(): void { showScreen(app.returnTo === "pause" ? "pause" : "title"); }

export function goTitle(): void {
  if (app.mode === "hosted") void hosted.leave();
  app.mode = null;
  app.session = null;
  app.lesson = null;
  app.paused = false;
  app.results = null;
  app.prevPos = app.curPos = null;
  timers.length = 0;
  audio.stopMusic();
  render.setViewSeat(0);
  render.buildArena(platform.save.progression.cosmetics.theme);
  showScreen("title");
}

// ------------------------------------------------------------------ match lifecycle
function configFromContent(c: Content): Parameters<typeof rules.createMatch>[0] {
  return { seed: c.seed, targetScore: c.targetScore, timeLimitSeconds: c.timeLimitSeconds ?? 0, obstacles: c.obstacles ?? [], moveBudget: c.moveBudget ?? null, overtime: c.overtime !== false };
}
function snapshotPositions(s: State): Pose {
  return { puck: { x: s.puck.x, y: s.puck.y }, mallets: [{ x: s.mallets[0]!.x, y: s.mallets[0]!.y }, { x: s.mallets[1]!.x, y: s.mallets[1]!.y }] };
}

export function startMatch(contentCfg: Content, mode: Mode, meta: { lesson?: Lesson | null; noAI?: boolean; ranked?: boolean } = {}): void {
  app.matchCfg = contentCfg;
  app.mode = mode;
  app.session = new Session(configFromContent(contentCfg), {
    mode, contentId: contentCfg.id, ruleset: RULESET_ID, contentVersion: contentCfg.version ?? CONTENT_VERSION, ranked: !!meta.ranked,
  });
  app.ai = meta.noAI ? null : createAI({ skill: contentCfg.ai?.skill ?? 0.5, player: 1, seed: contentCfg.seed });
  app.lesson = meta.lesson ?? null;
  if (app.lesson) setupLesson(app.lesson);
  app.paused = false;
  app.stepAcc = 0;
  app.prevPos = app.curPos = snapshotPositions(app.session.state);
  app.keyTarget = null;
  app.lastSaves = 0;
  app.clockWarned = false;
  app.results = null;
  timers.length = 0;
  render.buildArena(contentCfg.themeId ?? platform.save.progression.cosmetics.theme, contentCfg.obstacles ?? []);
  render.transitionToPlay(0);
  showScreen(null);
  app.scores = [0, 0];
  const st = app.session.state;
  app.budget = st.moveBudget ? T("Budget {n} u", { n: Math.round(st.moveBudget[0]!) }) : null;
  setObjective();
  banner(mode === "learn" ? T(app.lesson!.title) : cfgName(contentCfg), false);
  updateHud();
  audio.startMusic();
}

export function setObjective(): void {
  const s = app.session?.state;
  if (!s) return;
  if (app.mode === "learn") { setObjectiveText(T(app.lesson!.text)); return; }
  const parts = [T("First to {n}", { n: s.targetScore })];
  if (s.timeLimitTicks) parts.push(T("beat the clock"));
  if (app.matchCfg?.shutout) parts.push(T("concede nothing"));
  if (s.moveBudget) parts.push(T("limited travel budget"));
  setObjectiveText(parts.join(" · "));
}

function headlineFor(won: boolean, draw: boolean): string {
  if (app.mode === "learn") return won || draw ? "Lesson complete" : "Lesson ended";
  return won ? "Victory" : draw ? "Draw" : "Defeat";
}

function endMatch(): void {
  const s = app.session!.state;
  const breakdown = rules.resultBreakdown(s);
  audio.stopMusic();
  const won = s.winner === 0;
  const draw = s.winner === -1;
  const achievements = resolveProgression(won, draw, breakdown);
  const stars = app.mode === "journey" && won ? computeStars(app.matchCfg!, s) : null;
  audio.event(won ? "win" : draw ? "draw" : "lose");
  announce(T("{headline}. Final score {a} to {b}.", { headline: T(headlineFor(won, draw)), a: s.scores[0]!, b: s.scores[1]! }), true);
  platform.persist();
  const nextIdx = app.mode === "journey" ? (app.matchCfg!.index ?? -2) + 1 : -1;
  const hasNext = nextIdx >= 0 && nextIdx < JOURNEY.length && won;
  // Signed in: Daily matches (not draws) and won Challenges post their match
  // score (your goals × 10 − conceded) to the platform's high-score board.
  const lbScore = (app.mode === "daily" && !draw) || (app.mode === "challenge" && won) ? s.scores[0]! * 10 - s.scores[1]! : null;
  const post = lbScore != null && platform.signedIn();
  app.results = {
    headline: headlineFor(won, draw), sub: cfgName(app.matchCfg), breakdown,
    names: [yourName(), app.matchCfg!.ai ? T("AI") : T("Opponent")],
    achievements, stars, next: hasNext ? T("Next: {name}", { name: T(JOURNEY[nextIdx]!.name) }) : null, canRetry: true,
    lb: post ? { pending: true } : null,
  };
  if (post) {
    const res = app.results;
    void platform.postLeaderboard(lbScore!).then((r) => { res.lb = r; });
  }
  showScreen("results");
}

function resolveProgression(won: boolean, draw: boolean, breakdown: Breakdown): { name: string; description: string }[] {
  const p = platform.save.progression;
  const unlocked: { name: string; description: string }[] = [];
  const tryUnlock = (key: string): void => { const a = platform.unlock(key); if (a) { unlocked.push(a); audio.event("achievement"); } };
  p.totalGoals += breakdown.players[0]!.goals;
  if (p.totalGoals >= 100) tryUnlock("century_goals");
  if (app.mode === "learn") return unlocked; // lessons handle their own marking
  if (won) {
    p.wins++;
    p.currentStreak++;
    p.bestStreak = Math.max(p.bestStreak, p.currentStreak);
    tryUnlock("first_victory");
    if (p.currentStreak >= 3) tryUnlock("streak_three");
  } else if (!draw) {
    p.losses++;
    p.currentStreak = 0;
  }
  const s = app.session!.state;
  const base = {
    ruleset: RULESET_ID, contentVersion: CONTENT_VERSION, seed: s.seed,
    assists: settings.timingAssist ? ["timing"] : [], durationTicks: s.activeTicks, name: platform.displayName() ?? "You",
  };
  const cfg = app.matchCfg!;
  if (app.mode === "journey" && won) {
    if (!p.journeyCompleted.includes(cfg.id)) p.journeyCompleted.push(cfg.id);
    const stars = computeStars(cfg, s);
    p.journeyStars[cfg.id] = Math.max(p.journeyStars[cfg.id] ?? 0, stars);
    if (cfg.mastery) {
      tryUnlock("journey_mastery");
      platform.submitResult("journey", { ...base, boardKey: "mastery", score: stars * 1000 - Math.round(s.activeTicks / 60) });
    }
  }
  if (app.mode === "daily" && !draw) {
    const key = dailyKey(today());
    if (won && !p.dailyDays.includes(key)) {
      p.dailyDays.push(key);
      if (p.dailyDays.length >= 3) tryUnlock("daily_regular");
    }
    platform.submitResult("daily", { ...base, boardKey: key, score: s.scores[0]! * 10 - s.scores[1]! });
  }
  if (app.mode === "challenge" && won) {
    if (!p.challengesDone.includes(cfg.id)) p.challengesDone.push(cfg.id);
    platform.submitResult("challenge", { ...base, boardKey: cfg.id, score: s.scores[0]! * 10 - s.scores[1]! });
  }
  return unlocked;
}

function computeStars(cfg: Content, s: State): number {
  let stars = 1;
  if (s.scores[0]! - s.scores[1]! >= (cfg.par?.winBy ?? 2)) stars++;
  if (!cfg.timeLimitSeconds || s.activeTicks / 60 <= (cfg.par?.underSeconds ?? 120)) stars++;
  return stars;
}

// ------------------------------------------------------------------ lessons
/** Delays counted in fixed steps (the browser build's setTimeouts). */
const timers: { at: number; fn: () => void }[] = [];
let stepCount = 0;
function after(ms: number, fn: () => void): void { timers.push({ at: stepCount + Math.round(ms / (1000 * DT)), fn }); }

function setupLesson(lesson: Lesson): void {
  const s = app.session!.state;
  app.lessonState = { travel: 0, survived: 0, sawWall: false, done: false, lastX: s.mallets[0]!.x, lastY: s.mallets[0]!.y };
  const setup = (lesson.setup ?? {}) as { puck?: Partial<State["puck"]> };
  if (setup.puck) Object.assign(s.puck, setup.puck);
  if (lesson.goal.kind === "match") {
    s.targetScore = lesson.goal.targetScore!;
    app.ai = createAI({ skill: 0.25, player: 1, seed: s.seed });
  } else {
    app.ai = null;
    s.targetScore = 99; // lessons end via their goal, not the score
  }
}

function updateLesson(evts: { type: string; player?: number; scorer?: number }[]): void {
  const L = app.lesson!, ls = app.lessonState!, s = app.session!.state;
  if (ls.done) return;
  const m = s.mallets[0]!;
  ls.travel += Math.hypot(m.x - ls.lastX, m.y - ls.lastY);
  ls.lastX = m.x; ls.lastY = m.y;
  let done = false, failed = false;
  const goal = L.goal as { kind: string; amount?: number; ticks?: number };
  switch (goal.kind) {
    case "travel": done = ls.travel >= goal.amount!; break;
    case "strike": done = evts.some((e) => e.type === "strike" && e.player === 0); break;
    case "survive":
      ls.survived = s.activeTicks;
      done = ls.survived >= goal.ticks!;
      failed = evts.some((e) => e.type === "goal" && e.scorer === 1);
      setObjectiveText(T("{text} ({n}s left)", { text: T(L.text), n: Math.max(0, Math.ceil((goal.ticks! - ls.survived) / 60)) }));
      break;
    case "goal": done = evts.some((e) => e.type === "goal" && e.scorer === 0); break;
    case "wall-then-cross":
      if (evts.some((e) => e.type === "wall")) ls.sawWall = true;
      if (ls.sawWall && s.puck.y > rules.TABLE_H / 2 && s.puck.vy > 0) done = true;
      break;
    case "match": done = (s.phase as string) === rules.PHASE.TERMINAL; break;
  }
  if (failed) {
    ls.done = true;
    banner(T("Try again"), true);
    const token = app.session;
    after(1200, () => { if (app.session === token && (app.screen === null || app.screen === "pause")) startLesson(L); });
    return;
  }
  if (done) {
    if (goal.kind !== "match") ls.done = true;
    completeLesson(L);
  }
}

function completeLesson(lesson: Lesson): void {
  const p = platform.save.progression;
  if (!p.lessonsDone.includes(lesson.id)) {
    p.lessonsDone.push(lesson.id);
    platform.persist();
  }
  if (LESSONS.every((l) => p.lessonsDone.includes(l.id))) {
    platform.setSetting("tutorialDone", true);
    const a = platform.unlock("quick_learner");
    if (a) toast(T("Achievement: {name}", { name: T(a.name) }));
  }
  if (lesson.goal.kind !== "match") {
    banner(T("Lesson complete!"), true);
    audio.event("win");
    const token = app.session;
    after(900, () => {
      if (app.session !== token || app.screen !== null) return;
      const next = LESSONS[LESSONS.indexOf(lesson) + 1];
      audio.stopMusic();
      app.results = {
        headline: "Lesson complete", sub: T(lesson.title), breakdown: rules.resultBreakdown(app.session!.state), names: [T("You"), "—"],
        achievements: [], stars: null, next: next ? T("Next: {name}", { name: T(next.title) }) : null, canRetry: true, lb: null,
      };
      showScreen("results");
    });
  }
}

export function startLesson(lesson: Lesson): void {
  startMatch(
    { id: lesson.id, name: lesson.title, seed: 0x1EA22 + LESSONS.indexOf(lesson), targetScore: 99, obstacles: [], themeId: "neon-dusk", ai: null },
    "learn", { lesson, noAI: true },
  );
}

// ------------------------------------------------------------------ menu actions
export function quickPlay(): void {
  const cfg: Content = {
    id: "quick", name: "Quick Match", seed: (Math.random() * 2 ** 31) >>> 0,
    targetScore: 5, timeLimitSeconds: 0, obstacles: [], ai: { skill: 0.5 }, themeId: platform.save.progression.cosmetics.theme,
  };
  app.setup = { title: T("Quick Match"), description: T("First to 5 against a Club-strength opponent. Unranked."), targetScore: 5, timeLimitSeconds: 0, ranked: false, practice: false, content: cfg };
  showScreen("setup");
}
export function openDaily(): void {
  const d = dailyConfig(today()) as Content;
  const secs = secondsUntilNextDaily();
  app.setup = {
    title: cfgName(d), description: T("One shared seed for everyone today. Ranked. Next daily in {h}h {m}m.", { h: Math.floor(secs / 3600), m: Math.floor((secs % 3600) / 60) }),
    targetScore: d.targetScore, timeLimitSeconds: d.timeLimitSeconds ?? 0, ranked: true, practice: false, content: d,
  };
  showScreen("setup");
}
export function openPractice(): void {
  app.setup = { title: T("Practice"), description: T("Unranked. Restart and undo freely; no effect on rating."), targetScore: 5, timeLimitSeconds: 0, ranked: false, practice: true, content: null };
  showScreen("setup");
}
export function openStage(stage: Content): void {
  app.setup = {
    title: T("Stage {n}: {name}", { n: stage.index! + 1, name: T(stage.name!) }),
    description: `${(stage.mechanics ?? []).map((m) => T(MECHANICS[m] ?? m)).join(", ")}.${stage.mastery ? " " + T("Mastery stage — posts to the leaderboard.") : ""}`,
    targetScore: stage.targetScore, timeLimitSeconds: stage.timeLimitSeconds ?? 0, ranked: !!stage.mastery, practice: false, content: stage,
  };
  showScreen("setup");
}
export function openChallenge(c: Content): void {
  app.setup = { title: T(c.name!), description: T(c.description!), targetScore: c.targetScore, timeLimitSeconds: c.timeLimitSeconds ?? 0, ranked: true, practice: false, content: c };
  showScreen("setup");
}
export function begin(): void {
  const cfg = app.setup;
  if (!cfg) return;
  let content = cfg.content;
  if (!content) {
    const d = DIFFICULTIES[app.practiceDifficulty]!;
    content = {
      id: "practice", name: `Practice — ${d.name}`, difficulty: d.name, seed: (Math.random() * 2 ** 31) >>> 0,
      targetScore: 5, timeLimitSeconds: 0, obstacles: [], ai: { skill: d.skill }, themeId: platform.save.progression.cosmetics.theme, version: CONTENT_VERSION,
    };
  }
  startMatch(content, modeOf(content), { ranked: cfg.ranked });
}
function modeOf(content: Content): Mode {
  if (content.id === "practice" || content.id === "quick") return "practice";
  if (content.id.startsWith("j")) return "journey";
  if (content.id.startsWith("daily")) return "daily";
  if (content.id.startsWith("ch-")) return "challenge";
  return "practice";
}
export function retry(): void {
  if (!app.matchCfg || app.mode === "hosted") return;
  if (app.mode === "learn" && app.lesson) { startLesson(app.lesson); return; }
  startMatch(app.matchCfg, app.mode!, { lesson: app.lesson, noAI: app.mode === "learn" });
}
export function next(): void {
  if (app.mode === "learn" && app.lesson) {
    const nx = LESSONS[LESSONS.indexOf(app.lesson) + 1];
    if (nx) { startLesson(nx); return; }
    goTitle(); return;
  }
  if (app.mode === "journey" && app.matchCfg && (app.matchCfg.index ?? 99) + 1 < JOURNEY.length) {
    const stage = JOURNEY[app.matchCfg.index! + 1] as unknown as Content;
    goTitle();
    openStage(stage);
    return;
  }
  goTitle();
}
export function openLeaderboard(): void {
  app.lb = { platform: "loading", daily: platform.getBoard("daily", dailyKey(today())), journey: platform.getBoard("journey") };
  showScreen("leaderboard");
  const view = app.lb;
  void platform.fetchLeaderboard().then((r) => { view.platform = r; });
}
export function openLobby(): void {
  showScreen("lobby");
  if (player()) void hosted.enter();
}

// ------------------------------------------------------------------ pause
export function pauseGame(): void {
  if (app.screen !== null) return;
  if (app.mode === "hosted") { if (hosted.playing && !hosted.over) showScreen("pause"); return; }
  if (!app.session || (app.session.state.phase as string) === rules.PHASE.TERMINAL) return;
  app.paused = true;
  showScreen("pause");
}
export function resumeGame(): void {
  if (app.screen !== "pause") return;
  app.paused = false;
  showScreen(null);
}
export function restart(): void {
  if (app.mode === "hosted" || !app.session) return;
  retry();
}
export function leaveMatch(): void { goTitle(); }

export function doUndo(): void {
  if (!(app.mode === "practice" || app.mode === "learn") || !app.session) return;
  if (app.session.undo()) {
    app.prevPos = app.curPos = snapshotPositions(app.session.state);
    app.lastSaves = app.session.state.stats[0]!.saves;
    setScores(app.session.state.scores[0]!, app.session.state.scores[1]!);
    caption(T("Undone"));
    audio.event("undo");
  } else caption(T("Nothing to undo"));
}
export function giveHint(): void {
  const s = app.session?.state;
  if (!s) return;
  const legal = rules.legalActions(s, 0);
  if (!legal.actions.length) { caption(T("No legal moves right now.")); return; }
  const hint = s.puck.y < rules.TABLE_H / 2
    ? T("The puck is in your half — meet it with your mallet to strike.")
    : T("The puck is away. Guard your goal and track the puck.");
  caption(hint);
  announce(hint);
}
export function recentre(): void { render.transitionToPlay(app.mode === "hosted" ? hosted.seat : 0); }
export function canUndo(): boolean { return app.mode === "practice" || app.mode === "learn"; }

// ------------------------------------------------------------------ hosted
function hostedStart(): void {
  app.mode = "hosted";
  app.session = null;
  app.lesson = null;
  app.results = null;
  app.prevPos = app.curPos = null;
  app.matchCfg = { id: `hosted-${hosted.joinCode ?? (hosted.room?.id ?? "").slice(0, 6)}`, seed: 0, targetScore: 5, ai: null };
  app.scores = [0, 0];
  app.clock = "0:00";
  app.budget = null;
  app.clockWarned = false;
  render.buildArena(platform.save.progression.cosmetics.theme, []);
  render.transitionToPlay(hosted.seat);
  setObjectiveText(T("First to 5 · hosted · refereed by the StarHermit server"));
  showScreen(null);
  audio.startMusic();
}
function posFromSnap(s: Snap): Pose {
  return { puck: { x: s.p[0]!, y: s.p[1]! }, mallets: [{ x: s.m[0]!, y: s.m[1]! }, { x: s.m[2]!, y: s.m[3]! }] };
}
function hostedSnap(s: Snap): void {
  const me = hosted.seat, opp = 1 - me;
  setScores(s.s[me]!, s.s[opp]!);
  const ticks = s.tl && !s.ot ? Math.max(0, s.tl - s.at) : s.at;
  const sec = Math.floor(ticks / 60);
  app.clock = s.ot ? T("OT") : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  if (!app.clockWarned && s.tl && !s.ot && s.ph === "active" && ticks > 0 && ticks <= 600) { app.clockWarned = true; audio.event("clock-warning"); }
  audio.setMusicIntensity(Math.min(1, Math.hypot(s.p[2]!, s.p[3]!) / 220));
  handleEvents(s.ev as GameEvent[], { x: s.p[0]!, y: s.p[1]! }, me);
}
function hostedOver(o: Over): void {
  audio.stopMusic();
  const me = hosted.seat, opp = 1 - me;
  const won = o.winner === me, draw = o.winner === -1;
  audio.event(won ? "win" : draw ? "draw" : "lose");
  render.feedback("terminal", null, 4);
  const seats = hosted.table?.seats;
  const b = o.breakdown as unknown as Breakdown;
  app.results = {
    headline: won ? "Victory" : draw ? "Draw" : "Defeat",
    sub: T("Hosted room {room} · authoritative hash {hash}", { room: hosted.joinCode ?? "—", hash: o.finalHash }),
    breakdown: { ...b, players: [b.players[me]!, b.players[opp]!] },
    names: [yourName(), seats?.[opp]?.ai ? T("AI") : (seats?.[opp]?.name ?? T("Opponent"))],
    achievements: [], stars: null, next: null, canRetry: false, lb: null,
  };
  announce(T("{headline}. Final score {a} to {b}.", { headline: T(app.results.headline), a: o.scores[me]!, b: o.scores[opp]! }), true);
  hosted.finish();
  showScreen("results");
}
function hostedEnded(reason: "signed-out" | "terms-required" | "unavailable" | "closed"): void {
  const inMatch = app.mode === "hosted" && !app.results;
  if (reason === "signed-out" || reason === "terms-required") {
    app.expiredReason = reason === "terms-required" ? "terms-required" : "expired";
    void hosted.leave();
    goTitle();
    showScreen("expired");
    return;
  }
  if (inMatch || app.screen === "lobby") {
    toast(reason === "unavailable" ? P("roomUnavailable") : T("Connection to the room was lost."));
    void hosted.leave();
    goTitle();
  }
}

// ------------------------------------------------------------------ events
type GameEvent = { type: string; player?: number; scorer?: number; speed?: number; x?: number; y?: number; remaining?: number; scores?: number[] };
/** Sounds, effects, banners and captions for the rules' events; `me` is your seat (scorer and player are seats). */
function handleEvents(events: GameEvent[], puck: { x: number; y: number }, me = 0): void {
  for (const e of events) {
    switch (e.type) {
      case "countdown":
        banner(String(e.remaining));
        audio.event("countdown", { remaining: e.remaining });
        break;
      case "serve": banner(T("GO")); audio.event("go"); break;
      case "strike":
        render.feedback("strike", puck, 2);
        audio.event("strike", { speed: e.speed });
        haptic(8);
        if (app.session && e.player === 0 && app.session.state.stats[0]!.saves > app.lastSaves) audio.event("save");
        if (app.session) app.lastSaves = app.session.state.stats[0]!.saves;
        break;
      case "wall": render.feedback("wall", { x: e.x!, y: e.y! }, 1); audio.event("wall"); break;
      case "obstacle": render.feedback("obstacle", { x: e.x!, y: e.y! }, 2); audio.event("obstacle"); break;
      case "goal": {
        const mine = e.scorer === me;
        // The goal the scorer hit: seat 0 scores at the far (+y) end.
        render.feedback("goal", { x: rules.TABLE_W / 2, y: e.scorer === 0 ? rules.TABLE_H : 0 }, 3);
        audio.event("goal", { scorer: mine ? 0 : 1 });
        if (e.scores) setScores(e.scores[me]!, e.scores[1 - me]!);
        banner(mine ? T("GOAL!") : T("Conceded"), true);
        haptic(mine ? 60 : 60);
        if (app.matchCfg?.shutout && e.scorer === 1 && app.mode === "challenge" && app.session) app.session.forfeit(0); // perfect-wall constraint violated
        break;
      }
      case "overtime": banner(T("OVERTIME")); audio.event("overtime"); break;
      case "budget-exhausted":
        if (e.player === me) { caption(T("Move budget exhausted — defend with what you have")); audio.event("budget"); }
        break;
      case "terminal":
        if (app.mode !== "hosted") { render.feedback("terminal", null, 4); endMatch(); }
        break;
    }
  }
}

function updateHud(): void {
  const s = app.session?.state;
  if (!s) return;
  const ticks = s.timeLimitTicks && !s.inOvertime ? Math.max(0, s.timeLimitTicks - s.activeTicks) : s.activeTicks;
  const sec = Math.floor(ticks / 60);
  app.clock = s.inOvertime ? T("OT") : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  if (s.moveBudget) app.budget = T("Budget {n} u", { n: Math.round(s.moveBudget[0]!) });
  setScores(s.scores[0]!, s.scores[1]!);
  if (!app.clockWarned && s.timeLimitTicks && !s.inOvertime && s.phase === rules.PHASE.ACTIVE && ticks > 0 && ticks <= 600) {
    app.clockWarned = true;
    audio.event("clock-warning");
  }
}

export function boardStateText(): string {
  const s = app.session?.state;
  let puck: { x: number; y: number; vx: number; vy: number }, mallet: { x: number; y: number }, you: number, opp: number;
  if (s) { puck = s.puck; mallet = s.mallets[0]!; you = s.scores[0]!; opp = s.scores[1]!; }
  else if (hosted.cur) {
    const c = hosted.cur, me = hosted.seat;
    puck = { x: c.p[0]!, y: c.p[1]!, vx: c.p[2]!, vy: c.p[3]! }; mallet = { x: c.m[me * 2]!, y: c.m[me * 2 + 1]! }; you = c.s[me]!; opp = c.s[1 - me]!;
    if (me === 1) { puck = { x: rules.TABLE_W - puck.x, y: rules.TABLE_H - puck.y, vx: -puck.vx, vy: -puck.vy }; mallet = { x: rules.TABLE_W - mallet.x, y: rules.TABLE_H - mallet.y }; }
  } else return "";
  const dir = puck.vy < -10 ? T("toward your goal") : puck.vy > 10 ? T("toward the far goal") : T("nearly still");
  return T("Score: you {you}, opponent {opp}.", { you, opp }) + " " +
    T("Puck at column {x} of 100, row {y} of 200, moving {dir} at {speed} units per second.", { x: Math.round(puck.x), y: Math.round(puck.y), dir, speed: Math.round(Math.hypot(puck.vx, puck.vy)) }) + " " +
    T("Your mallet at column {x}, row {y}.", { x: Math.round(mallet.x), y: Math.round(mallet.y) });
}

// ------------------------------------------------------------------ input
function inputAllowed(): boolean {
  if (app.screen !== null) return false;
  if (app.mode === "hosted") return hosted.playing && !hosted.over;
  return !!app.session && !app.paused;
}
function issueMove(x: number, y: number): void {
  if (app.mode === "hosted") { hosted.sendInput(x, y); return; }
  const res = app.session?.move(0, x, y) as { ok: boolean; reason?: string } | undefined;
  if (res && !res.ok && res.reason === "move-budget-exhausted") {
    caption(T("Move budget exhausted"));
    audio.event("invalid");
  }
}
function currentMallet(): { x: number; y: number } | null {
  if (app.session) return app.session.state.mallets[0]!;
  if (hosted.cur) { const me = hosted.seat; return { x: hosted.cur.m[me * 2]!, y: hosted.cur.m[me * 2 + 1]! }; }
  return null;
}
/** Arrow keys / d-pad / the left stick: the target moves 140 units a second (an analog stick proportionally). */
function keyboardStep(): void {
  const dx = value("right") - value("left");
  const dy = value("up") - value("down");
  if (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) { app.keyTarget = null; return; }
  if (!app.keyTarget) { const m = currentMallet(); if (!m) return; app.keyTarget = { x: m.x, y: m.y }; }
  const flip = app.mode === "hosted" && hosted.seat === 1 ? -1 : 1;
  const b = rules.malletBounds(app.mode === "hosted" ? hosted.seat : 0);
  app.keyTarget.x = Math.min(b.maxX, Math.max(b.minX, app.keyTarget.x + dx * 140 * DT * flip));
  app.keyTarget.y = Math.min(b.maxY, Math.max(b.minY, app.keyTarget.y + dy * 140 * DT * flip));
  issueMove(app.keyTarget.x, app.keyTarget.y);
  render.showTargetMarker(app.keyTarget.x, app.keyTarget.y, true);
  ui.setFocus(null);
}

onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const fresh = frame().frame !== app.openedFrame;
  switch (e.action) {
    case "pause":
      if (!fresh) break;
      if (app.screen === null) pauseGame();
      else if (app.screen === "pause") resumeGame();
      else if (app.screen === "settings" || app.screen === "help") closeOverlay();
      else if (app.screen === "results") next();
      else if (app.screen === "lobby") { void hosted.leave(); goTitle(); }
      else if (app.screen !== "title") showScreen("title");
      break;
    case "undo": if (inputAllowed()) doUndo(); break;
    case "camera": if (inputAllowed()) recentre(); break;
    case "hint": if (inputAllowed()) giveHint(); break;
    case "board": if (inputAllowed()) app.boardState = !app.boardState; break;
  }
});

// Pointer and touch on the table: a press that starts off the UI drags the
// mallet; with "Hold to aim" off a mouse also follows without a press. The
// decision is made after the frame's UI is built (ui.pointerOver()).
const touch = { down: false, x: 0, y: 0, id: -1 };
let mouseDown = false;
let pendingPress = false;
let dragging = false;
let lastTouchAt = -1e9;
const lastPointer = { x: NaN, y: NaN };
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouchAt < 0.6) return;
  mouseDown = e.pressed;
  if (e.pressed) pendingPress = true;
  else { dragging = false; render.showTargetMarker(0, 0, false); }
});
onTouch((e) => {
  lastTouchAt = now();
  if (!e.primary) return;
  if (e.phase === "start") { touch.down = true; touch.x = e.x; touch.y = e.y; touch.id = e.id; pendingPress = true; }
  else if (e.phase === "move") { touch.x = e.x; touch.y = e.y; }
  else { touch.down = false; dragging = false; render.showTargetMarker(0, 0, false); }
});
function pointerStep(): void {
  if (!inputAllowed()) { pendingPress = false; dragging = false; return; }
  const p = touch.down ? { x: touch.x, y: touch.y } : pointer();
  if (pendingPress) {
    pendingPress = false;
    if (!ui.pointerOver()) { dragging = true; audio.loadSfx(); }
  }
  const held = touch.down || mouseDown;
  // Follow mode answers pointer movement (the browser build's pointermove), so a still mouse leaves the keys in charge.
  const moved = !!p && (p.x !== lastPointer.x || p.y !== lastPointer.y);
  if (p) { lastPointer.x = p.x; lastPointer.y = p.y; }
  const follow = moved && !touch.down && !held && !settings.holdToAim && primaryPointer() !== "coarse" && !ui.pointerOver();
  if (!p || !((held && dragging) || follow)) return;
  const hit = render.pick(p.x, p.y);
  if (!hit) return;
  issueMove(hit.x, hit.y);
  render.showTargetMarker(hit.x, hit.y, held);
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

audio.setOnCaption((kind, d) => {
  if (!settings.captions) return;
  const text: Record<string, string> = {
    invalid: T("Invalid action"), countdown: T("Starting in {n}", { n: d.remaining ?? 0 }), go: T("Go!"),
    "goal-you": T("Goal for you!"), "goal-opp": T("Goal conceded"), win: T("Victory"), lose: T("Defeat"),
    achievement: T("Achievement unlocked"), overtime: T("Overtime — golden goal"), budget: T("Move budget exhausted"),
    "clock-warning": T("10 seconds left"), save: T("Save!"), draw: T("Draw"),
  };
  caption(text[kind] ?? "");
});

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  applyPalette(settings.palette, preferences().highContrast);
  render.setReducedMotion(preferences().reducedMotion);
  const problems = validateContent();
  if (problems.length) console.warn(`content validation: ${problems.join("; ")}`);
  applyLook();
  render.buildArena(platform.save.progression.cosmetics.theme);
  audio.loadSfx();
  showScreen("title");
});
onPreferencesChange((p) => { render.setReducedMotion(p.reducedMotion); applyPalette(settings.palette, p.highContrast); });
platform.onSettingsChange(() => applyPalette(settings.palette, preferences().highContrast));
onLanguage(() => { if (app.session && app.mode !== "hosted") { setObjective(); updateHud(); } });
onSessionEnded(() => { app.signedOut = true; toast(P("signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => {
  // Backgrounding pauses a solo match (a hosted one runs on the server).
  if (app.screen === null && app.mode !== "hosted" && app.session) pauseGame();
  platform.flush();
});
onQuit(() => platform.flush());

onFixedUpdate(() => {
  stepCount++;
  for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.at <= stepCount) { const t = timers.splice(i, 1)[0]!; t.fn(); }
  if (app.mode === "hosted") {
    if (inputAllowed()) keyboardStep();
    return;
  }
  const s = app.session;
  if (!s || app.paused || app.screen !== null || (s.state.phase as string) === rules.PHASE.TERMINAL) return;
  app.stepAcc += settings.timingAssist ? 0.85 : 1;
  if (app.stepAcc < 1) return;
  app.stepAcc -= 1;
  keyboardStep();
  if (app.ai) {
    const t = app.ai.update(s.state);
    if (t) s.move(1, t.x, t.y);
  }
  app.prevPos = app.curPos;
  s.tick();
  app.curPos = snapshotPositions(s.state);
  const events = s.drainEvents() as GameEvent[];
  if (events.length) handleEvents(events, s.state.puck);
  if (app.lesson && app.lessonState && !app.lessonState.done && app.session === s) updateLesson(events);
  if (app.session === s) updateHud();
  audio.setMusicIntensity(Math.min(1, Math.hypot(s.state.puck.vx, s.state.puck.vy) / 220));
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t = now();
  if (app.banner && t > app.banner.until) app.banner = null;
  if (app.caption && t > app.caption.until) app.caption = null;
  app.toasts = app.toasts.filter((x) => x.until > t);
  if (app.boardState && frame().frame % 30 === 0) app.boardText = boardStateText();
});

onRender((alpha) => {
  drawScreens();
  pointerStep();
  const f = frame();
  if (app.mode === "hosted" && hosted.cur) {
    const prev = hosted.prev ? posFromSnap(hosted.prev) : posFromSnap(hosted.cur);
    const cur = posFromSnap(hosted.cur);
    const a = Math.min(1, Math.max(0, (now() - hosted.curAt) / hosted.interval));
    render.render(frameDt, prev, cur, a, hosted.cur.ph, f.width, f.height);
  } else if (app.session && app.mode !== "hosted") {
    const a = app.paused || app.screen !== null ? 1 : Math.min(1, Math.max(0, alpha));
    render.render(frameDt, app.prevPos, app.curPos, a, app.session.state.phase, f.width, f.height);
  } else {
    // No positions yet (menus, lobby, a hosted match waiting for its first snapshot): the attract view.
    render.render(frameDt, null, null, 1, null, f.width, f.height);
  }
});

export type { Vars };
