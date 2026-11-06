// Localization: assets/strings.json, nine locales keyed by the US-English text
// (en-GB, es-ES and fr-CA carry only their differences), on the engine's string
// tables, which follow the runtime's interface language (the player's choice in
// Options › Language, else the account's or the device's) along their locale
// chain. Account lines are the engine's `starhermit.*`; this game's own room and
// session lines are `acct.*`.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export function currentLocale(): string { return strings.locale; }
export function onLanguage(fn: () => void): void { strings.onChange(fn); }

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(String(key), vars ?? undefined); }
/** A room or session line in the player's language. */
export function P(key: string, vars?: Vars | null): string { return strings.t(`acct.${key}`, vars ?? undefined); }
