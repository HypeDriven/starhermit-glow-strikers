// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, sliders, selects, text fields,
// scroll bars) fall back to. The browser build's body classes that swapped
// the palette are token sets here: the three colour-vision palettes (the
// game's setting) and high contrast (the runtime's accessibility option).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};

const PALETTES: Record<string, Tokens> = {
  deuteranopia: { accent: "#4dd7ff", "accent-warm": "#ffb84d" },
  protanopia: { accent: "#59d8ff", "accent-warm": "#ffd24d" },
  tritanopia: { accent: "#4dffd2", "accent-warm": "#ff5c5c" },
};
const HIGH_CONTRAST: Tokens = { panel: "#000000f5", line: "#8fa4ff", text: "#ffffff", "text-dim": "#d4dbff" };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 20, padding: 8, spacing: 8, radius: 12,
    text: "#e8ecff", muted: "#9aa6d0", panel: "#0d1228", control: "#0d1228", hovered: "#16204a",
    pressed: "#1c2a5c", field: "#0d1228", accent: "#38e6ff", focus: "#38e6ff", outline: "#2a3a66",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    checkbox: {
      text: { color: "$text" }, minHeight: 40,
      parts: { box: { background: "$panel-solid", border: { width: 1, color: "$line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$text" }, background: "$panel-solid", border: { width: 1, color: "$line" }, radius: 8, minHeight: 40 },
    textField: { text: { color: "$text" }, background: "$panel-solid", border: { width: 1, color: "$line" }, radius: 8, minHeight: 40 },
    scrollArea: { parts: { bar: { background: "$text-dim", radius: 4 } } },
  });
}

let paletteKey = "";
/** The palette tokens: high contrast over the colour-vision palette over the sheet's. */
export function applyPalette(palette: string, highContrast: boolean): void {
  const key = `${palette}:${highContrast}`;
  if (key === paletteKey) return;
  paletteKey = key;
  const tokens: Tokens = { ...base, ...(PALETTES[palette] ?? {}) };
  if (highContrast) Object.assign(tokens, HIGH_CONTRAST);
  ui.setTokens(tokens);
}
