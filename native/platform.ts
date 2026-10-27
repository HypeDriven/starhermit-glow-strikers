// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey clears and stars, lessons, dailies, challenges, record
//   and streaks, achievements, personal-best boards) is the game's save
//   (starhermit:storage `saves`): the browser build's save document
//   (js/progress.js), on the device and in the player's cloud slot, two
//   devices' copies merged on a conflict (mergeSaves). The slot the browser
//   build wrote (the JS SDK's zipped save.json holding { checksum, payload })
//   shows as foreign: it is checked, merged with this device's progress and
//   replaced once (its game settings carried over where unset);
// - the game's own settings (captions, colour palette, left-handed layout,
//   hold to aim, timing assistance, haptics, the tutorial flag) are
//   `settings` (game.<key>, synced with the account); the browser build's
//   per-player settings keys are migrated and removed;
// - the player's name, the invite link, the leaderboard screen's rows and
//   posting a finished match's score to the high-score board through
//   server.js (a practice session whose socket carries { type: 'result',
//   scores }, as the JS SDK's submitScores did).
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, sessions, type Leaderboard } from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import * as G from "../js/progress.js";

export type SaveDoc = ReturnType<typeof G.defaultSave>;
export let save: SaveDoc = G.defaultSave();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** Writes the save (device at once, account debounced by the runtime). */
export function persist(): void {
  try { saves.save(save as unknown as JsonValue, { schema: G.SAVE_VERSION }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
function adopt(other: SaveDoc | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(save);
  const next = G.mergeSaves(other, save) as SaveDoc;
  if (JSON.stringify(next) === before) return false;
  save = next;
  return true;
}
saves.onConflict((local, remote) => ({
  merged: G.mergeSaves(G.docFromSave(remote.data), G.docFromSave(local?.data)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(G.docFromSave(cur.data) as SaveDoc | null)) { persist(); merged(); }
  }
});
/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const parsed = G.docFromBrowserSave(old.text);
  const changed = adopt(parsed ? (parsed.doc as SaveDoc) : null);
  if (parsed) {
    for (const [k, v] of Object.entries(parsed.settings)) {
      if (store.get(k) === undefined) { try { store.set(k, v as JsonValue); settings[k] = v; } catch { /* keep */ } }
    }
    settingsChanged();
  }
  try { saves.save(save as unknown as JsonValue, { schema: G.SAVE_VERSION, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's settings -----------------------------------------------------------------
export interface Settings { captions: boolean; palette: string; leftHanded: boolean; holdToAim: boolean; timingAssist: boolean; haptics: boolean; tutorialDone: boolean; [key: string]: unknown }
export const settings: Settings = { ...G.DEFAULT_SETTINGS };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = G.migrateSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: string, value: boolean | string): void {
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings: kept where the game still has the
// setting (unless this game set it since), then removed from the account.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  let changed = false;
  for (const key of keys) {
    if (!G.BROWSER_SETTING_KEYS.includes(key)) continue;
    const v = G.migrateSetting(key, store.legacy(key));
    if (v !== undefined && store.get(key) === undefined) {
      try { store.set(key, v as JsonValue); settings[key] = v; changed = true; } catch { /* keep the device's */ }
    }
    store.removeLegacy(key);
  }
  if (changed) settingsChanged();
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const d = G.docFromSave(cur?.data) as SaveDoc | null;
  if (d) save = d;
  else if (!cur) persist();
  for (const k of G.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!G.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
}

// --- the player -----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function userId(): string | null { return player()?.userId ?? null; }
export function displayName(): string | null { return player()?.displayName ?? null; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

// --- the StarHermit leaderboard -------------------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { rank: number | null; name: string; score: number; mine: boolean }
/** The platform board's first 20 rows (guests read it too); null when there is no board or it is out of reach. */
export async function fetchLeaderboard(): Promise<{ ok: boolean; entries: BoardRow[] } | null> {
  const me = player();
  try {
    const b = await highScoreBoard();
    if (!b) return { ok: false, entries: [] };
    const page = await leaderboards.entries(b.id, { pageSize: 20 });
    const entries = await Promise.all(page.items.map(async (e) => {
      let name = e.displayName || e.username || "Player " + e.userId.slice(0, 8);
      if (me && e.userId === me.userId) name = me.displayName;
      else if (me) { try { name = (await profile(e.userId)).displayName; } catch { /* the board's name */ } }
      return { rank: e.rank ?? null, name, score: Math.round(Number(e.score) || 0), mine: !!me && e.userId === me.userId };
    }));
    return { ok: true, entries };
  } catch { return null; }
}

/** Signed in only: post a finished match's score through server.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(score: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": Math.round(score) } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

// --- progress helpers (the browser build's Platform methods) ---------------------------------
const nowIso = (): string => new Date().toISOString();
export function unlock(key: string): { key: string; name: string; description: string } | null {
  const a = G.unlock(save, key, nowIso());
  if (a) persist();
  return a;
}
export function submitResult(boardName: string, entry: Record<string, unknown>): unknown {
  const e = G.submitResult(save, boardName, entry, nowIso());
  if (e) persist();
  return e;
}
export function getBoard(boardName: string, key?: string): { name?: string; score: number; durationTicks?: number }[] {
  return G.getBoard(save, boardName, key);
}
