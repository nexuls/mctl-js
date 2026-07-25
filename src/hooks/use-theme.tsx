/**
 * Theme context: makes the active {@link Theme} available to every component and
 * lets the app switch themes at runtime.
 *
 * Where the two theme sources meet: the static catalogue comes from a
 * {@link ThemeRegistry} (built-ins + user files, already loaded from disk by the
 * caller in core), while the dynamic `"terminal"` theme is built live from
 * {@link useTerminalColors}. This provider picks between them by id, so a
 * component only ever sees one resolved `Theme` and never has to care which
 * source it came from.
 *
 * UI-layer: it consumes the renderer (via the terminal-colours hook) but does no
 * filesystem I/O — the registry is passed in already populated. Persisting a
 * theme change back to `config.json` is a core concern and is surfaced through
 * the optional `onThemeChange` callback rather than done here.
 */

import { createContext, useContext, useMemo, useState } from "react";
import type { Theme, TerminalPalette, ThemeSummary } from "../types/theme.ts";
import type { ThemeRegistry } from "../core/theme/registry.ts";
import { themeFromTerminalColors } from "../core/theme/terminal.ts";
import { useTerminalColors } from "./use-terminal-colors.ts";

/**
 * The terminal theme derived from an empty palette — all roles resolve to
 * `themeFromTerminalColors`' literal fallbacks. Used only for the sliver of time
 * before the real palette arrives (and only if it wasn't pre-fetched), so the
 * `"terminal"` id never falls back to an unrelated static theme like GitHub.
 */
const EMPTY_TERMINAL_THEME: Theme = themeFromTerminalColors({
  foreground: null,
  background: null,
  ansi: [],
});

/** Value exposed by {@link useTheme}. */
export interface ThemeContextValue {
  /** The fully-resolved active theme. Always defined. */
  theme: Theme;
  /** The active theme's id (may be `"terminal"`). */
  themeId: string;
  /** Switch the active theme by id. Unknown ids fall back gracefully. */
  setThemeId: (id: string) => void;
  /** Every selectable theme, for a picker. */
  themes: ThemeSummary[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** Registry with built-ins + user themes already folded in (`await load()`). */
  registry: ThemeRegistry;
  /** Initial theme id, typically `config.theme`. Defaults to `"terminal"`. */
  initialThemeId?: string;
  /**
   * Terminal palette fetched before mount (see `queryTerminalPalette`). Passing
   * it means the very first render already has terminal colours — no flash from
   * a placeholder theme to the real one on startup.
   */
  initialPalette?: TerminalPalette | null;
  /** Notified when the active theme changes, e.g. to persist to `config.json`. */
  onThemeChange?: (id: string) => void;
  children: React.ReactNode;
}

/**
 * Provide the theme context. Resolves the active theme every render from the
 * current id: the live terminal palette for `"terminal"`, otherwise the
 * registry. An id that resolves to nothing (e.g. a deleted custom theme) falls
 * back to the terminal theme, then to a static default — the UI is never left
 * without colours.
 */
export function ThemeProvider({
  registry,
  initialThemeId = "terminal",
  initialPalette = null,
  onThemeChange,
  children,
}: ThemeProviderProps) {
  const [themeId, setThemeIdState] = useState(initialThemeId);
  const { palette } = useTerminalColors(initialPalette);

  // The dynamic terminal theme, rebuilt whenever the host palette changes. Falls
  // back to the empty-palette terminal theme (never a static theme) so the
  // "terminal" id always reads as a terminal theme. Appearance is derived from
  // the background inside themeFromTerminalColors.
  const terminalTheme = useMemo<Theme>(
    () => (palette ? themeFromTerminalColors(palette) : EMPTY_TERMINAL_THEME),
    [palette],
  );

  const theme = useMemo<Theme>(() => {
    if (registry.isDynamic(themeId)) return terminalTheme;
    // A named theme that no longer resolves (e.g. a deleted custom theme) degrades
    // to the terminal theme rather than an unrelated static default.
    return registry.get(themeId) ?? terminalTheme;
  }, [registry, themeId, terminalTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId,
      themes: registry.list(),
      setThemeId: (id: string) => {
        setThemeIdState(id);
        onThemeChange?.(id);
      },
    }),
    [theme, themeId, registry, onThemeChange],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

/**
 * Read the active theme and theme controls. Throws when used outside a
 * {@link ThemeProvider} — a programming error worth failing loudly on.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
