// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the play HUD (objective pill, your score,
// the clock and the opponent's score, Pause; the banner; the travel budget,
// the caption strip, Undo and Board state; the board-state panel), the
// toasts, and the screens (title with its key art, record rail and More rail;
// the journey, challenge and lesson lists; the match setup with the practice
// difficulty; pause / match menu; results with the breakdown table, stars,
// achievements and the leaderboard line; help; settings; achievements;
// leaderboards; the hosted lobby with room code, seats, invites and chat;
// the session-expired dialog). The browser's media queries are layouts
// picked by the window's logical size: wide (≥ 1024 px: the title's two
// rails beside the menu), compact (no rails, the More row under the menu),
// portrait phone (smaller objective and panel padding) and short landscape
// (≤ 500 px tall: tighter panels and art).
import { clipboard, frame, openMenu } from "starhermit:engine";
import { bindings } from "starhermit:input";
import * as ui from "starhermit:ui";
import { player, requestSignIn } from "starhermit:platform";
import { ACHIEVEMENTS, CHALLENGES, JOURNEY, LESSONS, dailyConfig } from "../js/content.js";
import { TERMINAL } from "../js/rules.js";
import { PALETTES } from "../js/progress.js";
import { P, T } from "./i18n.ts";
import * as audio from "./audio.ts";
import * as platform from "./platform.ts";
import {
  DIFFICULTIES, MECHANICS, app, begin, doUndo, canUndo, cfgName, closeOverlay, goTitle, hosted, leaveMatch, next, openChallenge,
  openDaily, openLeaderboard, openLobby, openOverlay, openPractice, openStage, pauseGame, quickPlay, restart, resumeGame, retry,
  settings, showScreen, startLesson, toast, today, type Content,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; portrait: boolean; shortLand: boolean; narrow: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, portrait: lh > lw && lw <= 700, shortLand: lw > lh && lh <= 500, narrow: lw <= 560 };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; sub?: string; style?: string[]; disabled?: boolean; act: () => void }
const PLAIN = ["btn"];
const buttonWidth = (b: Btn): number => Math.max(textWidth(b.text, b.style ?? PLAIN, "button"), b.sub ? textWidth(b.sub, "btn-sub") + 34 : 0) + 2;
/** A button `width` wide (null: its text's); a second line (sub) and labels too long for it wrap inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = b.disabled ? { disabled: true } : {};
  const s: ui.Style = width != null ? { width } : {};
  const primary = style.includes("btn-primary");
  const inner = (width ?? buttonWidth(b)) - 34;
  if (b.sub || (width != null && buttonWidth(b) > width)) {
    opts.content = () => ui.column(`${b.id}-face`, () => {
      const main = primary ? "btn-main-primary" : "btn-main";
      if (textWidth(b.text, main) <= inner) ui.style(main, { text: { align: "center" } }).label(b.text);
      else ui.style(main, { text: { align: "center" } }).paragraph(b.text, inner);
      if (b.sub) {
        if (textWidth(b.sub, "btn-sub") <= inner) ui.style("btn-sub").label(b.sub);
        else ui.style("btn-sub", { text: { align: "center" } }).paragraph(b.sub, inner);
      }
    }, { width: inner, align: "center", spacing: 1 });
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) { tap(b.id); b.act(); }
}
/** The browser build's UI tap on every action (the quieter back tap for Back, Leave and Menu). */
function tap(id: string): void { audio.event(/back|leave|menu/i.test(id) ? "ui-back" : "ui"); }
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap), each row stretched to the width. */
function flow(label: string, list: Btn[], width: number, gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      const total = row.reduce((n, b) => n + Math.min(width, buttonWidth(b)), 0) + gap * (row.length - 1);
      const extra = row.length ? Math.max(0, (width - total) / row.length) : 0;
      for (const b of row) button(b, Math.min(width, buttonWidth(b) + extra));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string | null, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : ["body"];
  if (center) styles.push({ text: { align: "center" } });
  const u = ui.style(...styles);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) {
    if (center) ui.row(`c-${text.slice(0, 24)}`, () => { u.label(text); }, { width, justify: "center" });
    else u.label(text);
  } else u.paragraph(text, width);
}

// ------------------------------------------------------------------ the frame
function firstLabel(): string | null {
  switch (app.screen) {
    case "title": return T("Play");
    case "setup": return T("Start");
    case "pause": return app.mode === "hosted" ? T("Back to Match") : T("Resume");
    case "results": return app.results?.canRetry ? T("Retry") : T("Menu");
    case "expired": return P("playLocal");
    default: return null;
  }
}

export function drawScreens(): void {
  const L = layoutNow();
  const age = frame().frame - app.openedFrame;
  if (app.focusNext && app.screen && age >= 2) {
    const first = firstLabel();
    if (first) ui.setFocus(first);
    app.focusNext = false;
  }
  const inMatch = !!app.session || (app.mode === "hosted" && hosted.playing);
  if (inMatch && (app.screen === null || app.screen === "pause")) hud(L);
  switch (app.screen) {
    case "title": titleScreen(L); break;
    case "journey": journeyScreen(L); break;
    case "challenges": challengesScreen(L); break;
    case "learn": learnScreen(L); break;
    case "setup": setupScreen(L); break;
    case "pause": pauseScreen(L); break;
    case "results": resultsScreen(L); break;
    case "help": helpScreen(L); break;
    case "settings": settingsScreen(L); break;
    case "achievements": achievementsScreen(L); break;
    case "leaderboard": leaderboardScreen(L); break;
    case "lobby": lobbyScreen(L); break;
    case "expired": expiredScreen(L); break;
    default: break;
  }
  toasts(L);
}

function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw - 32, 520);
  ui.place("toasts", { anchor: "bottom-start", x: (L.lw - w) / 2, y: 70 }, () => {
    app.toasts.forEach((t, i) => {
      ui.column(`toast-${i}`, () => {
        if (textWidth(t.text, "toast") + 38 <= w) ui.style("toast").label(t.text);
        else ui.style("toast").paragraph(t.text, w - 38);
      }, { align: "center", width: w });
    });
  }, { spacing: 8, width: w });
}

// ------------------------------------------------------------------ HUD
function hud(L: Layout): void {
  const m = 10;
  const compact = L.portrait || L.narrow;
  const pauseW = 52;
  // Top row: objective (start), scores + clock (centre), Pause (end).
  const scoresW = 3 * 46 + 12 + 30;
  const objMax = Math.max(80, Math.min(42 * 8, (L.lw - scoresW) / 2 - m - 8));
  const objCls = compact ? ["hud-objective", "hud-objective-compact"] : ["hud-objective"];
  if (app.objective) {
    ui.place("hud-objective", { anchor: "top-start", x: m, y: 8 }, () => {
      const inner = objMax - (compact ? 22 : 26);
      if (textWidth(app.objective, objCls) <= inner) ui.style(...objCls).label(app.objective);
      else ui.style(...objCls).paragraph(app.objective, inner);
    }, { width: Math.min(objMax, textWidth(app.objective, objCls) + (compact ? 24 : 28)) });
  }
  ui.place("hud-score", { anchor: "top", y: compact && textWidth(app.objective, objCls) + 28 > objMax ? 8 : 8 }, () => {
    ui.row("hud-score-row", () => {
      ui.style("score-pill", "score-you").id("score-you").label(String(app.scores[0]));
      ui.style("score-pill", "score-clock").id("hud-clock").label(app.clock);
      ui.style("score-pill", "score-opp").id("score-opp").label(String(app.scores[1]));
    }, { spacing: 6, align: "center" });
  });
  ui.place("hud-pause", { anchor: "top-end", x: m, y: 8 }, () => {
    if (ui.style("hud-btn", { width: pauseW }).id("btn-pause").button(T("Pause game"), { content: () => { ui.style("body", { text: { weight: "700" } }).label("II"); } })) { tap("pause"); pauseGame(); }
  });
  // Banner.
  if (app.banner || (app.mode === "hosted" && hosted.cur?.ph === "waiting")) {
    const text = app.banner?.text ?? T("Waiting for your opponent…");
    ui.place("hud-banner", { anchor: "top-start", x: 0, y: L.lh * 0.22 }, () => {
      const cls = ["hud-banner", ...(ui.preferences().reducedMotion ? ["hud-banner-plain"] : [])];
      const size = Math.max(26, Math.min(48, L.lw * 0.06));
      const st = { text: { size } };
      if (textWidth(text, [...cls]) * size / 41.6 <= L.lw - 32) ui.style(...cls, st).id("hud-banner").label(text);
      else ui.style(...cls, st, { text: { align: "center" } }).paragraph(text, L.lw - 32);
    }, { width: L.lw, align: "center" });
  }
  // Bottom row: budget, captions, Undo + Board state.
  const acts: Btn[] = [];
  if (canUndo()) acts.push({ id: "btn-undo", text: T("Undo"), style: ["hud-btn"], act: doUndo });
  acts.push({ id: "btn-boardstate", text: T("Board state"), style: ["hud-btn"], act: () => { app.boardState = !app.boardState; } });
  const left = !!settings.leftHanded;
  ui.place("hud-actions", { anchor: left ? "bottom-start" : "bottom-end", x: m, y: 8 }, () => {
    ui.row("hud-actions-row", () => {
      for (const b of acts) if (ui.style(...b.style!).id(b.id).button(b.text, b.id === "btn-boardstate" ? { selected: app.boardState } : {})) { tap(b.id); b.act(); ui.setFocus(null); }
    }, { spacing: 8, align: "end" });
  });
  if (app.budget) {
    ui.place("hud-budget", { anchor: left ? "bottom-end" : "bottom-start", x: m, y: 8 }, () => { ui.style("hud-budget").id("hud-budget").label(app.budget!); });
  }
  if (app.caption) {
    const w = Math.min(L.lw - 40, 520);
    ui.place("captions", { anchor: "bottom", y: compact ? 64 : 18 }, () => {
      if (textWidth(app.caption!.text, "captions") <= w) ui.style("captions").id("captions").label(app.caption!.text);
      else ui.style("captions").paragraph(app.caption!.text, w);
    });
  }
  if (app.boardState) {
    const w = Math.min(L.lw - 2 * m, 40 * 8);
    ui.place("boardstate", { anchor: left ? "bottom-end" : "bottom-start", x: m, y: 64 + (app.budget ? 44 : 0) }, () => {
      ui.style("body").paragraph(app.boardText || T("Board state"), w - 30);
    }, { style: "boardstate", width: w });
  }
}

// ------------------------------------------------------------------ screens
/** A screen (the browser's `.screen` over the window) with its panel centred, scrolling when taller than the room. */
function screen(key: string, L: Layout, maxW: number, build: (inner: number) => void, footerBtns?: () => void): void {
  const pad = L.narrow ? 12 : 16;
  const width = Math.max(200, Math.min(maxW, L.lw - pad * 2));
  const padX = L.portrait ? 16 : L.shortLand ? 14 : 24;
  const inner = width - padX * 2 - 2;
  const avail = Math.max(120, L.lh - pad * 2);
  const h = lastHeight.get(key) ?? 0;
  const panelCls = L.portrait ? ["panel", "panel-compact"] : L.shortLand ? ["panel", "panel-short"] : ["panel"];
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column(`scr-${key}-center`, () => {
      ui.column(`${key}-panel`, () => {
        const body = (): void => {
          const r = ui.column(`${key}-body`, () => build(inner), { spacing: 12, width: inner });
          lastHeight.set(key, r.height / L.sc);
        };
        const footH = footerBtns ? 72 : 0;
        const room = avail - footH - padX * 2;
        if (h > room) ui.scrollArea(`${key}-scroll`, { width: inner + 12, height: room }, () => body());
        else body();
        if (footerBtns) ui.column(`${key}-footer`, footerBtns, { width: inner, padding: { top: 12 } });
      }, { style: panelCls, width, spacing: 0, ...(L.portrait ? {} : {}) });
    }, { width: L.lw, height: L.lh, justify: "center", align: "center" });
  }, { style: "screen", width: L.lw, height: L.lh });
}
function h2(text: string, id: string): void { ui.style("h2").id(id).heading(text); }
const back = (): void => showScreen("title");

// --- title
function titleScreen(L: Layout): void {
  const p = platform.save.progression;
  const done = p.journeyCompleted.length;
  const daily = dailyConfig(today());
  const day = String(daily.id).replace(/^daily-/, "");
  const accountLine = accountText();
  const moreBtns = (): Btn[] => {
    const list: Btn[] = [
      { id: "btn-achievements", text: T("Achievements"), style: ["btn", "btn-small"], act: () => showScreen("achievements") },
      { id: "btn-leaderboards", text: T("Leaderboards"), style: ["btn", "btn-small"], act: openLeaderboard },
      { id: "btn-settings", text: T("Settings"), style: ["btn", "btn-small"], act: () => openOverlay("settings") },
      { id: "btn-help", text: T("How to Play"), style: ["btn", "btn-small"], act: () => openOverlay("help") },
    ];
    if (!player()) list.push({ id: "btn-signin", text: P("signIn"), style: ["btn", "btn-small"], act: () => { void requestSignIn().catch(() => undefined); } });
    else {
      const link = platform.inviteLink();
      if (link) list.push({ id: "btn-invite-link", text: P("invite"), style: ["btn", "btn-small"], act: () => { try { clipboard.writeText(link); toast(P("inviteCopied")); } catch { toast(P("inviteFailed")); } } });
    }
    return list;
  };
  const centre = (w: number): void => {
    art("title-art", "assets/key-art.webp", w, L.shortLand ? 70 : L.portrait ? 110 : 150);
    ui.row("title-logo-row", () => { ui.style("title-logo", L.narrow || L.shortLand ? "title-logo-compact" : null).id("title-logo").heading("GLOW STRIKERS"); }, { width: w, justify: "center" });
    para(T("Defend your goal. Strike the light."), w, "title-sub", true);
    if (accountLine) para(accountLine, w, "dim", true);
    ui.column("menu", () => {
      const list: Btn[] = [
        { id: "btn-play", text: T("Play"), sub: T("Jump straight into a match"), style: ["btn", "btn-primary"], act: quickPlay },
        { id: "btn-daily", text: T("Daily Challenge"), sub: T("Daily — {day} · shared seed", { day }), act: openDaily },
        { id: "btn-journey", text: T("Journey"), sub: T("{n}/{total} stages", { n: done, total: JOURNEY.length }), act: () => showScreen("journey") },
        { id: "btn-challenges", text: T("Challenges"), act: () => showScreen("challenges") },
        { id: "btn-learn", text: settings.tutorialDone ? T("Learn (replay)") : T("Learn"), sub: T("Interactive lessons"), act: () => showScreen("learn") },
        { id: "btn-practice", text: T("Practice"), act: openPractice },
        { id: "btn-hosted", text: T("Hosted Play"), act: openLobby },
      ];
      for (const b of list) button(b, w);
    }, { spacing: 10, width: w, padding: { top: 6 } });
    if (!L.wide) {
      ui.column("more-row", () => flow("more-flow", moreBtns(), w, 8), { padding: { top: 10 }, width: w });
    }
  };
  if (L.wide) {
    const W = Math.min(1180, L.lw - 32);
    screen("title", L, W, (inner) => {
      const rail = 240, gap = 24;
      const mid = inner - rail * 2 - gap * 2;
      ui.row("title-rails", () => {
        ui.column("rail-left", () => {
          ui.style("h3").heading(T("Journey"));
          para(T("{n} / {total} stages cleared", { n: done, total: JOURNEY.length }), rail, "rail-p");
          ui.style("h3", { margin: { top: 8 } }).heading(T("Record"));
          para(T("{wins} wins · {losses} losses", { wins: p.wins, losses: p.losses }), rail, "rail-p");
          para(T("Best streak: {n}", { n: p.bestStreak }), rail, "rail-p");
        }, { width: rail, spacing: 8 });
        ui.column("title-centre", () => centre(mid), { width: mid, spacing: 8 });
        ui.column("rail-right", () => {
          ui.style("h3").heading(T("More"));
          ui.column("more-col", () => { for (const b of moreBtns()) button(b, rail); }, { spacing: 10, width: rail });
        }, { width: rail, spacing: 8 });
      }, { spacing: gap, align: "start" });
    });
  } else {
    screen("title", L, 560, (inner) => centre(inner));
  }
}
function accountText(): string {
  const me = player();
  if (!me) return app.signedOut ? P("signedOut") : "";
  const st = platform.syncState();
  const key = st === "saving" ? "Playing as {name} · cloud save saving…" : st === "synced" ? "Playing as {name} · cloud save synced" : "Playing as {name} · cloud save offline";
  return T(key, { name: me.displayName });
}
/** An authored illustration (assets/*.webp) as a box's cover image over the page colour (it stays dark if the image is missing). */
function art(id: string, path: string, w: number, h: number): void {
  ui.style("art", { background: [{ image: path, size: "cover" }, "#070a18"] })
    .column(id, () => { ui.widget("", { role: "none", size: { width: 1, height: h - 2 } }); }, { width: w, height: h });
}

// --- lists
function listItem(id: string, label: string, w: number, opts: { title: string; sub?: string; lead?: string; tag?: string; stars?: string; done?: boolean; disabled?: boolean; act: () => void }): void {
  const inner = w - 26;
  const right = opts.tag ? textWidth(opts.tag, "tag") + 22 : opts.stars ? textWidth(opts.stars, "stars") + 6 : 0;
  const leadW = opts.lead ? textWidth(opts.lead, "item-t") + 8 : 0;
  const textW = Math.max(60, inner - right - leadW - 12);
  const clicked = ui.style("list-item", opts.done ? "list-done" : null, { width: w }).id(id).button(label, {
    disabled: !!opts.disabled,
    content: () => {
      ui.row(`${id}-face`, () => {
        if (opts.lead) ui.style("item-t").label(opts.lead);
        ui.column(`${id}-txt`, () => {
          para(opts.title, textW, "item-t");
          if (opts.sub) para(opts.sub, textW, "item-sub");
        }, { width: textW, spacing: 2 });
        if (opts.tag) ui.style("tag").label(opts.tag);
        else if (opts.stars) ui.style("stars").label(opts.stars);
      }, { spacing: 8, align: "center", width: inner });
    },
  });
  if (clicked && !opts.disabled) { tap(id); opts.act(); }
}
function backFooter(id: string): () => void {
  return () => { button({ id, text: T("Back"), act: back }, null); };
}

function journeyScreen(L: Layout): void {
  const p = platform.save.progression;
  screen("journey", L, 560, (w) => {
    h2(T("Journey"), "journey-heading");
    para(T("Forty authored stages. Concepts are introduced alone, combined, then tested in Mastery stages."), w, "dim");
    ui.column("journey-list", () => {
      for (const s of JOURNEY) {
        const unlocked = s.index === 0 || p.journeyCompleted.includes(JOURNEY[s.index - 1]!.id);
        const stars = p.journeyStars[s.id] ?? 0;
        const done = p.journeyCompleted.includes(s.id);
        const name = T(s.name);
        const label = done ? T("Stage {n}: {name}, completed with {stars} stars", { n: s.index + 1, name, stars })
          : unlocked ? T("Stage {n}: {name}", { n: s.index + 1, name }) : T("Stage {n}: {name}, locked", { n: s.index + 1, name });
        listItem(`stage-${s.index + 1}`, label, w, {
          lead: `${s.index + 1}.`, title: name, sub: s.mechanics.map((m) => T(MECHANICS[m] ?? m)).join(" · "),
          tag: s.mastery && !done ? T("MASTERY") : undefined, stars: done ? "★".repeat(stars) + "☆".repeat(3 - stars) : undefined,
          done, disabled: !unlocked, act: () => openStage(s as unknown as Content),
        });
      }
    }, { spacing: 6, width: w });
  }, backFooter("btn-journey-back"));
}

function challengesScreen(L: Layout): void {
  const p = platform.save.progression;
  screen("challenges", L, 560, (w) => {
    h2(T("Challenges"), "challenges-heading");
    para(T("Constrained goals: clocks, travel budgets, altered layouts."), w, "dim");
    ui.column("challenge-list", () => {
      for (const c of CHALLENGES) {
        const done = p.challengesDone.includes(c.id);
        listItem(`ch-${c.id}`, T(c.name), w, { title: T(c.name), sub: T(c.description), stars: done ? "✓" : undefined, done, act: () => openChallenge(c as unknown as Content) });
      }
    }, { spacing: 6, width: w });
  }, backFooter("btn-challenges-back"));
}

function learnScreen(L: Layout): void {
  const p = platform.save.progression;
  screen("learn", L, 560, (w) => {
    h2(T("Learn"), "learn-heading");
    para(T("One rule at a time — each lesson asks you to perform the action."), w, "dim");
    ui.column("lesson-list", () => {
      for (const l of LESSONS) {
        const done = p.lessonsDone.includes(l.id);
        listItem(`lesson-${l.id}`, T(l.title), w, { title: T(l.title), sub: T(l.text), stars: done ? "✓" : undefined, done, act: () => startLesson(l) });
      }
    }, { spacing: 6, width: w });
  }, backFooter("btn-learn-back"));
}

function metaGrid(id: string, w: number, cells: [string, string][]): void {
  const gap = 8;
  const cols = Math.max(1, Math.min(cells.length, Math.floor((w + gap) / (140 + gap))));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.column(id, () => {
    for (let i = 0; i < cells.length; i += cols) {
      ui.row(`${id}-r${i}`, () => {
        for (const [b, t] of cells.slice(i, i + cols)) {
          ui.column(`${id}-${b}-${t}`, () => { para(b, cw - 22, "meta-b"); para(t, cw - 22, "meta-t"); }, { style: "meta-cell", width: cw, spacing: 2 });
        }
      }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}

function setupScreen(L: Layout): void {
  const cfg = app.setup;
  if (!cfg) { showScreen("title"); return; }
  screen("setup", L, 560, (w) => {
    h2(cfg.title, "setup-heading");
    para(cfg.description, w, "dim");
    metaGrid("setup-meta", w, [
      [T("First to {n}", { n: cfg.targetScore }), T("Win condition")],
      [cfg.timeLimitSeconds ? T("{n} min max", { n: Math.round(cfg.timeLimitSeconds / 60) }) : T("a few minutes"), T("Expected duration")],
      [T("1 vs AI"), T("Players")],
      [cfg.ranked ? T("Recorded") : T("Unranked"), cfg.ranked ? T("Counts on your board") : T("No rating effect")],
    ]);
    if (cfg.practice) {
      ui.row("difficulty-row", () => {
        ui.style("body").label(T("Difficulty"));
        ui.spacer();
        const idx = ui.id("set-difficulty").select(T("Difficulty"), app.practiceDifficulty, DIFFICULTIES.map((d) => T(d.name)));
        if (idx !== app.practiceDifficulty) app.practiceDifficulty = idx;
      }, { style: "setting-row", width: w, align: "center" });
    }
  }, () => {
    const inner = Math.max(200, Math.min(560, L.lw - 32)) - (L.portrait ? 32 : 48) - 2;
    flow("setup-btns", [
      { id: "btn-start", text: T("Start"), style: ["btn", "btn-primary"], act: begin },
      { id: "btn-setup-back", text: T("Back"), act: back },
    ], inner);
  });
}

function pauseScreen(L: Layout): void {
  const hostedMatch = app.mode === "hosted";
  const MODE: Record<string, string> = { practice: "practice", journey: "journey", daily: "daily", challenge: "challenge", learn: "learn", hosted: "hosted" };
  screen("pause", L, 480, (w) => {
    h2(hostedMatch ? T("Match Menu") : T("Paused"), "pause-heading");
    para(`${cfgName(app.matchCfg)} — ${T(MODE[app.mode ?? ""] ?? "")}${hostedMatch ? " · " + T("the server clock keeps running") : ""}`, w, "dim");
    ui.column("pause-menu", () => {
      button({ id: "btn-resume", text: hostedMatch ? T("Back to Match") : T("Resume"), style: ["btn", "btn-primary"], act: resumeGame }, w);
      button({ id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings") }, w);
      button({ id: "btn-pause-help", text: T("How to Play"), act: () => openOverlay("help") }, w);
      if (!hostedMatch) button({ id: "btn-restart", text: T("Restart"), act: restart }, w);
      button({ id: "btn-leave", text: T("Leave Match"), style: ["btn", "btn-danger"], act: leaveMatch }, w);
    }, { spacing: 10, width: w });
  });
}

const TERMINAL_LABEL: Record<string, string> = {
  [TERMINAL.TARGET_SCORE]: "Target score reached", [TERMINAL.TIME_LIMIT]: "Time limit", [TERMINAL.OVERTIME_GOAL]: "Overtime golden goal",
  [TERMINAL.FORFEIT]: "Forfeit", [TERMINAL.MOVE_LIMIT]: "Move budget exhausted",
};
function resultsScreen(L: Layout): void {
  const r = app.results;
  if (!r) { showScreen("title"); return; }
  const b = r.breakdown;
  const artName = r.headline === "Victory" || r.headline === "Lesson complete" ? "results-victory" : r.headline === "Defeat" ? "results-defeat" : null;
  screen("results", L, 560, (w) => {
    if (artName) resultArt(artName, w, L.shortLand ? 60 : L.portrait ? 100 : 130);
    ui.row("results-h", () => { ui.style("h2").id("results-heading").heading(T(r.headline)); }, { width: w, justify: "center" });
    para(r.sub, w, "dim", true);
    if (r.stars != null) {
      ui.row("results-stars", () => { ui.style("stars", { text: { size: 26 } }).label("★".repeat(r.stars!) + "☆".repeat(3 - r.stars!)); }, { width: w, justify: "center" });
    }
    const rows: [string, (p: Record<string, number>) => string][] = [
      ["Goals", (p) => String(p.goals)], ["Shots", (p) => String(p.shots)], ["Saves", (p) => String(p.saves)],
      ["Steals", (p) => String(p.steals)], ["Invalid actions", (p) => String(p.invalidActions)],
      ["Rail bounces", (p) => String(p.wallBounces)], ["Fastest strike", (p) => T("{n} u/s", { n: p.maxPuckSpeed! })],
    ];
    const players = b.players as unknown as Record<string, number>[];
    const numW = Math.max(64, Math.min(120, (w - 120) / 2));
    ui.grid("breakdown", () => {
      ui.style("cell-head", { text: { align: "start" } }).label(T("Component"));
      ui.style("cell-head").label(r.names[0]);
      ui.style("cell-head").label(r.names[1]);
      for (const [label, fn] of rows) {
        ui.style("cell").label(T(label));
        ui.style("cell-num").label(fn(players[0]!));
        ui.style("cell-num").label(fn(players[1]!));
      }
    }, { columns: [{ fr: 1 }, { width: numW, align: "end" }, { width: numW, align: "end" }], gap: 0, width: w, rowStyle: "row-line" });
    const why = b.reason ? ` · ${T(TERMINAL_LABEL[b.reason] ?? b.reason)}` : r.headline === "Lesson complete" ? " · " + T("Lesson objective completed") : "";
    para(`${T("Duration")}: ${Math.round((players[0]!.elapsedTicks ?? 0) / 60)}s${why}`, w, "dim");
    if (r.achievements.length) {
      ui.style("h3").heading(T("Achievements unlocked"));
      for (const a of r.achievements) para(`🏆 ${T(a.name)} — ${T(a.description)}`, w, "body");
    }
    if (r.lb) {
      const lb = r.lb;
      para(lb.pending ? P("lbPosting") : !lb.posted ? P("lbNotPosted") : lb.rank ? P("lbRank", { rank: lb.rank }) : P("lbPosted"), w, "dim", true);
    }
  }, () => {
    const inner = Math.max(200, Math.min(560, L.lw - 32)) - (L.portrait ? 32 : 48) - 2;
    const list: Btn[] = [];
    if (r.canRetry) list.push({ id: "btn-retry", text: T("Retry"), style: ["btn", "btn-primary"], act: retry });
    if (r.next) list.push({ id: "btn-next", text: r.next, style: ["btn", "btn-primary"], act: next });
    list.push({ id: "btn-menu", text: T("Menu"), act: goTitle });
    flow("results-btns", list, inner);
  });
}
function resultArt(name: string, w: number, h: number): void { art(`art-${name}`, `assets/${name}.webp`, w, h); }

// --- help
function keysOf(action: string): string {
  const keys = bindings(action).filter((b) => b.device === "keyboard").map((b) => b.label.replace(/^Arrow /, "").replace("Escape", "Esc"));
  return keys.join("/") || "—";
}
function helpScreen(L: Layout): void {
  screen("help", L, 900, (w) => {
    h2(T("How to Play"), "help-heading");
    para(T("Defend the glowing goal at your end. Strike the puck into your opponent’s goal. First to the target score wins."), w, "body");
    const k = { up: keysOf("up"), down: keysOf("down"), left: keysOf("left"), right: keysOf("right"), pause: keysOf("pause"), undo: keysOf("undo"), camera: keysOf("camera") };
    const cards: [string, string][] = [
      [T("Move"), T("Drag anywhere in your half, or use {up}/{down}/{left}/{right}. Your mallet cannot cross the centre line.", k)],
      [T("Strike"), T("Meet the puck with your mallet. Hit through it toward the far goal; faster mallets strike harder.")],
      [T("Defend"), T("Guard your goal mouth when the puck approaches. Blocks from deep in your half count as saves.")],
      [T("Rails"), T("The luminous rails are live — bank shots off them to bend around defenders.")],
      [T("Pause"), T("{pause} pauses. {undo} undoes in Practice. {camera} recentres the camera.", k)],
      [T("Gamepad"), T("Left stick moves, Start pauses. Buttons can be remapped by your platform.")],
    ];
    const gap = 8;
    const cols = Math.max(1, Math.min(3, Math.floor((w + gap) / (220 + gap))));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("help-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`help-r${i}`, () => {
          for (const [title, body] of cards.slice(i, i + cols)) {
            ui.column(`help-${title}`, () => { para(title, cw - 22, "meta-b"); para(body, cw - 22, "meta-t"); }, { style: "meta-cell", width: cw, spacing: 4 });
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
  }, () => { button({ id: "btn-help-back", text: T("Back"), act: closeOverlay }); });
}

// --- settings
function settingsScreen(L: Layout): void {
  screen("settings", L, 560, (w) => {
    h2(T("Settings"), "settings-heading");
    const check = (key: string, label: string): void => {
      const cur = !!settings[key];
      ui.row(`row-${key}`, () => {
        const nextV = ui.id(`set-${key}`).checkbox(label, cur);
        if (nextV !== cur) platform.setSetting(key, nextV);
      }, { style: "setting-row", width: w, align: "center" });
    };
    const group = (title: string): void => { ui.style("settings-h3", { margin: { top: 10 } }).label(title.toUpperCase()); };
    group(T("Audio"));
    check("captions", T("Captions for audio cues"));
    group(T("Display"));
    ui.row("row-palette", () => {
      para(T("Colour palette"), w * 0.45, "body");
      ui.spacer();
      const names = [T("Default"), T("Deuteranopia-safe"), T("Protanopia-safe"), T("Tritanopia-safe")];
      const idx = Math.max(0, PALETTES.indexOf(String(settings.palette)));
      const n = ui.id("set-palette").select(T("Colour palette"), idx, names);
      if (n !== idx) platform.setSetting("palette", PALETTES[n]!);
    }, { style: "setting-row", width: w, align: "center" });
    group(T("Controls"));
    check("leftHanded", T("Left-handed layout"));
    check("holdToAim", T("Hold to aim (vs. follow)"));
    check("timingAssist", T("Timing assistance"));
    check("haptics", T("Haptics"));
    group(T("Tutorial"));
    ui.row("row-tutorial", () => {
      button({ id: "btn-replay-lessons", text: T("Replay lessons"), style: ["btn", "btn-small"], act: () => showScreen("learn") });
    }, { style: "setting-row", width: w, align: "center" });
    // Sound volumes, graphics, language, key bindings, text size, contrast and reduced motion are the runtime's Options.
    para(T("Sound, graphics, language, controls and accessibility are in the StarHermit Options (F1)."), w, "dim");
    button({ id: "btn-options", text: T("Open Options"), act: () => openMenu() }, Math.min(w, buttonWidth({ id: "", text: T("Open Options"), act: () => undefined })));
  }, () => { button({ id: "btn-settings-back", text: T("Back"), act: closeOverlay }); });
}

// --- achievements and leaderboards
function achievementsScreen(L: Layout): void {
  const unlocked = platform.save.achievements as Record<string, unknown>;
  screen("achievements", L, 560, (w) => {
    h2(T("Achievements"), "achievements-heading");
    ui.column("ach-list", () => {
      for (const a of ACHIEVEMENTS) {
        const got = !!unlocked[a.key];
        ui.row(`ach-${a.key}`, () => {
          ui.style("item-t").label(got ? "🏆" : "🔒");
          ui.column(`ach-${a.key}-t`, () => { para(T(a.name), w - 150, "item-t"); para(T(a.description), w - 150, "item-sub"); }, { width: w - 150, spacing: 2 });
          if (got) ui.style("tag").label(T("UNLOCKED"));
        }, { style: ["list-item", ...(got ? ["list-done"] : [])], width: w, spacing: 10, align: "center" });
      }
    }, { spacing: 6, width: w });
  }, backFooter("btn-ach-back"));
}

function leaderboardScreen(L: Layout): void {
  const v = app.lb;
  screen("leaderboard", L, 560, (w) => {
    h2(T("Leaderboards"), "leaderboard-heading");
    const row = (id: string, name: string, mid: string, score: string, mine = false): void => {
      ui.row(id, () => {
        para(mine ? T("{name} (you)", { name }) : name, w - 150, "item-t");
        ui.spacer();
        if (mid) ui.style("dim").label(mid);
        ui.style("stars").label(score);
      }, { style: "list-item", width: w, spacing: 10, align: "center" });
    };
    ui.style("h3").heading(T("Platform leaderboard"));
    const pl = v?.platform;
    if (pl === "loading") para(T("Loading…"), w, "dim");
    else if (pl && pl.ok && pl.entries.length) ui.column("lb-platform", () => pl.entries.forEach((e, i) => row(`lbp-${i}`, `${e.rank != null ? "#" + e.rank + " " : ""}${e.name}`, "", String(e.score), e.mine)), { spacing: 6, width: w });
    else if (pl && pl.ok) para(T("No entries yet today."), w, "dim");
    else para(T("No platform board for this game — your records below are kept on this device and mirrored to your cloud save."), w, "dim");
    const local = (list: { name?: string; score: number; durationTicks?: number }[], prefix: string): void => {
      ui.column(`lb-${prefix}`, () => list.forEach((e, i) => row(`${prefix}-${i}`, e.name ?? T("You"), `${Math.round((e.durationTicks ?? 0) / 60)}s`, String(e.score))), { spacing: 6, width: w });
    };
    ui.style("h3").heading(T("Personal best — daily (shared seed)"));
    if (v?.daily.length) local(v.daily, "daily"); else para(T("No daily results yet — play today’s seed."), w, "dim");
    ui.style("h3").heading(T("Personal best — journey mastery"));
    if (v?.journey.length) local(v.journey, "journey"); else para(T("Clear a Mastery stage to post a time."), w, "dim");
  }, backFooter("btn-lb-back"));
}

// --- lobby
function lobbyScreen(L: Layout): void {
  const h = hosted;
  screen("lobby", L, 560, (w) => {
    h2(T("Hosted Play"), "lobby-heading");
    if (!player()) {
      para(T("Hosted matches are played on StarHermit: sign in to create or join a room."), w, "dim");
      button({ id: "btn-lobby-signin", text: P("signIn"), style: ["btn", "btn-primary"], act: () => { void requestSignIn().catch(() => undefined); } }, w);
      return;
    }
    if (h.status) para(T(h.status, h.statusVars), w, "dim");
    if (h.joinCode) {
      ui.row("room-code", () => { ui.style("body").label(T("Room code:")); ui.style("room-code").id("room-code").label(h.joinCode!); }, { spacing: 10, width: w, justify: "center", align: "center" });
    }
    if (h.joined) {
      ui.column("seats", () => {
        h.players().forEach((p, i) => {
          const tagText = p.ai ? T("AI") : p.host ? T("Host") : "";
          ui.row(`seat-${i}`, () => {
            para(p.you ? T("{name} (you)", { name: p.name }) : p.name, w - 120, "item-t");
            ui.spacer();
            if (tagText) ui.style("tag").label(tagText);
          }, { style: "list-item", width: w, align: "center" });
        });
        if (h.players().length < 2) ui.row("seat-empty", () => { para(T("— waiting for an opponent —"), w - 30, "item-sub"); }, { style: "list-item", width: w, align: "center" });
      }, { spacing: 6, width: w });
    }
    const btns: Btn[] = [];
    if (!h.joined) {
      btns.push({ id: "btn-create-room", text: T("Create Room"), style: ["btn", "btn-primary"], disabled: h.busy, act: () => { void h.create(); } });
      btns.push({ id: "btn-quick-join", text: T("Quick Join"), disabled: h.busy, act: () => { void h.quickJoin(); } });
    } else if (h.isHost && !h.playing && h.players().length < 2) {
      btns.push({ id: "btn-start-ai", text: T("Start vs AI"), style: ["btn", "btn-primary"], disabled: h.busy, act: () => { void h.startVsAI(); } });
    }
    if (btns.length) flow("lobby-btns", btns, w);
    if (!h.joined) {
      ui.row("join-code", () => {
        const fieldW = Math.min(160, w * 0.45);
        app.joinCode = ui.id("join-code-field").textField("join-code-field", app.joinCode, { maxChars: 8, width: fieldW, placeholder: T("CODE") });
        if (ui.submitted("join-code-field")) void h.joinByCode(app.joinCode);
        button({ id: "btn-join-code", text: T("Join"), disabled: h.busy || !app.joinCode.trim(), act: () => { void h.joinByCode(app.joinCode); } });
      }, { spacing: 8, align: "center" });
    }
    if (h.joined && h.friends) {
      ui.style("h3").heading(P("inviteFriends"));
      if (!h.friends.length) para(P("noFriends"), w, "dim");
      for (const f of h.friends) {
        ui.row(`friend-${f.userId}`, () => {
          para(`${f.name} · ${f.online ? P("online") : P("offline")}`, w - 140, "item-t");
          ui.spacer();
          if (f.invited) ui.style("dim").label(P("invited"));
          else button({ id: `invite-${f.userId}`, text: P("inviteBtn"), style: ["btn", "btn-small"], act: () => { void h.inviteFriend(f.userId); } });
        }, { style: "list-item", width: w, align: "center" });
      }
    }
    if (!h.joined && h.invites.length) {
      ui.style("h3").heading(P("roomInvites"));
      for (const inv of h.invites) {
        ui.row(`inv-${inv.id}`, () => {
          para(P("inviteFrom", { name: inv.name }), w - 200, "item-t");
          ui.spacer();
          button({ id: `accept-${inv.id}`, text: P("accept"), style: ["btn", "btn-small", "btn-primary"], act: () => { void h.acceptInvite(inv.id); } });
          button({ id: `decline-${inv.id}`, text: P("decline"), style: ["btn", "btn-small"], act: () => { void h.declineInvite(inv.id); } });
        }, { style: "list-item", width: w, spacing: 6, align: "center" });
      }
    }
    if (h.joined) {
      ui.style("h3").heading(T("Chat"));
      ui.column("chat-log", () => {
        if (!h.chat.length) para(T("Message (10/min max)"), w - 24, "dim");
        for (const [i, m] of h.chat.slice(-12).entries()) ui.row(`chat-${i}`, () => { para(`${m.from}: ${m.text}`, w - 24, "body"); });
      }, { style: "chat-log", width: w, spacing: 3 });
      ui.row("chat-form", () => {
        app.chatText = ui.id("chat-field").textField("chat-field", app.chatText, { maxChars: 200, width: Math.max(120, w - 100), placeholder: T("Chat message") });
        const send = (): void => { if (app.chatText.trim()) { h.sendChat(app.chatText); app.chatText = ""; } };
        if (ui.submitted("chat-field")) send();
        button({ id: "btn-chat-send", text: T("Send"), style: ["btn", "btn-small"], act: send });
      }, { spacing: 8, align: "center" });
    }
  }, () => {
    button({ id: "btn-lobby-leave", text: h.joined ? T("Leave Room") : T("Back"), style: h.joined ? ["btn", "btn-danger"] : PLAIN, act: () => { void h.leave(); goTitle(); } });
  });
}

function expiredScreen(L: Layout): void {
  const terms = app.expiredReason === "terms-required";
  screen("expired", L, 480, (w) => {
    h2(terms ? P("termsRequired") : P("sessionExpired"), "expired-heading");
    para(terms ? P("termsRequiredBody") : P("sessionExpiredBody"), w, "dim");
    button({ id: "btn-play-local", text: P("playLocal"), style: ["btn", "btn-primary"], act: () => showScreen("title") }, w);
  });
}
