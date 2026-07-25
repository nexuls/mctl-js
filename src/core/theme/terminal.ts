/**
 * Build the dynamic "terminal" theme from the host terminal's own palette.
 *
 * This is what lets MCTL blend into whatever colour scheme the user already runs
 * (their Alacritty/Kitty/iTerm theme) instead of imposing one. The mapping is a
 * pure function of a {@link TerminalPalette} snapshot — no I/O, no UI, no OpenTUI
 * import — so it stays in core and is trivially testable. The snapshot itself is
 * produced by `hooks/use-terminal-colors.ts` from OpenTUI's palette query.
 *
 * Every role is filled with a fallback chain because any terminal-reported entry
 * may be `null`: we never hand the UI an undefined colour.
 */

import type {
  Theme,
  ThemeAppearance,
  ThemeColors,
  TerminalPalette,
} from "../../types/theme.ts";

/** The reserved id of the dynamic terminal theme. */
export const TERMINAL_THEME_ID = "terminal";

// Standard ANSI palette indices, named for readability at the mapping site.
const ANSI = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightBlue: 12,
  brightMagenta: 13,
} as const;

/** First non-null candidate, or the final literal fallback. */
function pick(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (c) return c;
  }
  // Unreachable in practice — callers always end the chain with a literal.
  return "#808080";
}

/**
 * The host's current light/dark mode, derived from its terminal background
 * brightness. This is the "current mode" that selects a theme's light or dark
 * variant (see {@link ThemeColorScheme}) — even for static themes, the host mode
 * still comes from the terminal, since that is the only signal of whether the
 * user's environment is light or dark.
 *
 * Falls back to `dark` when the background is unreported/unparseable, since most
 * terminals are dark.
 */
export function terminalAppearance(palette: TerminalPalette): ThemeAppearance {
  const luma = relativeLuma(palette.background);
  if (luma === null) return "dark";
  return luma > 0.5 ? "light" : "dark";
}

/** 0..1 perceived brightness of a `#rgb`/`#rrggbb` colour, or `null` if unparseable. */
function relativeLuma(hex: string | null): number | null {
  if (!hex) return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  let body = m[1] as string;
  if (body.length === 3) {
    body = body
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const r = parseInt(body.slice(0, 2), 16) / 255;
  const g = parseInt(body.slice(2, 4), 16) / 255;
  const b = parseInt(body.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Map a terminal palette snapshot to MCTL's semantic colour roles.
 *
 * The result is a `{ default }` scheme, not a light/dark pair: the snapshot
 * already reflects whatever mode the terminal is *currently* in, so there is only
 * ever one palette to expose. When the terminal switches light↔dark the snapshot
 * changes and this is called again — the mode is captured in the colours
 * themselves, and the host mode is read separately via {@link terminalAppearance}.
 *
 * @param palette Snapshot of the terminal's fg/bg + 16 ANSI colours.
 */
export function themeFromTerminalColors(palette: TerminalPalette): Theme {
  const a = palette.ansi;
  const colors: ThemeColors = {
    background: pick(palette.background, a[ANSI.black], "#000000"),
    foreground: pick(palette.foreground, a[ANSI.white], "#c0c0c0"),
    // A panel background one step off the page: the ANSI "black" cell usually
    // reads as a near-background surface on dark terminals; fall back to bg.
    surface: pick(a[ANSI.black], palette.background, "#1a1a1a"),
    border: pick(a[ANSI.brightBlack], a[ANSI.black], "#3a3a3a"),
    muted: pick(a[ANSI.brightBlack], a[ANSI.white], "#808080"),
    primary: pick(a[ANSI.blue], a[ANSI.brightBlue], "#3b78ff"),
    secondary: pick(a[ANSI.magenta], a[ANSI.brightMagenta], "#b048c0"),
    success: pick(a[ANSI.green], "#2ea043"),
    warning: pick(a[ANSI.yellow], "#d29922"),
    error: pick(a[ANSI.red], "#f85149"),
    info: pick(a[ANSI.cyan], a[ANSI.blue], "#39c5cf"),
  };

  return {
    id: TERMINAL_THEME_ID,
    name: "Terminal Default",
    source: "terminal",
    colors: { default: colors },
  };
}
