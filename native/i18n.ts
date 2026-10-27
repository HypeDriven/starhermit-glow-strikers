// Localization: the browser build's string tables (js/i18n/strings.js and
// strings-content.js: English source strings as keys, the nine StarHermit
// locales, en-GB / es-ES / fr-CA carrying only their differences from en-US /
// es-419 / fr-FR) and its account strings (js/platform-strings.js), in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replaced the game's own
// Language menu (sh-language.js); the browser build's DOM observer became
// explicit T() calls.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import "../js/i18n/strings.js";
import "../js/i18n/strings-content.js";
import { pickLocale } from "../js/i18n/locale.js";
import { platformStrings } from "../js/platform-strings.js";

type Table = Record<string, string>;
const TABLES = (globalThis as unknown as { GS_STRINGS: Record<string, Table> }).GS_STRINGS;
const PARENT: Record<string, string> = { "en-GB": "en-US", "es-ES": "es-419", "fr-CA": "fr-FR" };

let locale = "";
const listeners = new Set<() => void>();
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  ui.setLanguage(locale);
  for (const fn of listeners) fn();
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export function onLanguage(fn: () => void): void { listeners.add(fn); }

function lookup(key: string): string {
  for (let l: string | undefined = locale; l; l = PARENT[l]) {
    const t = TABLES[l];
    if (t && Object.prototype.hasOwnProperty.call(t, key)) return t[key]!;
  }
  return key;
}

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  const s = lookup(String(key));
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

export type PlatformKey = keyof ReturnType<typeof platformStrings>;
/** An account string (sign-in, invites, leaderboard lines) in the player's language. */
export function P(key: PlatformKey, vars?: Vars | null): string {
  const s = String(platformStrings(locale)[key] ?? key);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
