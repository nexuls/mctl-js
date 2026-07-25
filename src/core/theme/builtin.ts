/**
 * Built-in themes shipped with MCTL. These are always available regardless of
 * what is (or isn't) in `~/.config/mctl/themes/`, so the UI always has a valid
 * theme to fall back to.
 *
 * Pure data — no I/O, no UI. The colours are transcribed from each project's
 * published palette; the source is linked so the next author can re-check them.
 * Add a new built-in by appending a {@link Theme} here and nothing else — the
 * registry picks it up automatically.
 */

import type { Theme } from "../../types/theme.ts";

/**
 * GitHub Dark (the "dark default" variant).
 * Palette: https://primer.style/foundations/color/base-scales — the values used
 * across github.com's dark theme (canvas #0d1117, accent #58a6ff, …).
 */
const github: Theme = {
  id: "github",
  name: "GitHub Dark",
  appearance: "dark",
  source: "builtin",
  colors: {
    background: "#0d1117",
    foreground: "#e6edf3",
    surface: "#161b22",
    border: "#30363d",
    muted: "#8b949e",
    primary: "#58a6ff",
    secondary: "#bc8cff",
    success: "#3fb950",
    warning: "#d29922",
    error: "#f85149",
    info: "#79c0ff",
  },
};

/**
 * Nord — the arctic, north-bluish palette.
 * Palette: https://www.nordtheme.com/docs/colors-and-palettes
 * Polar Night for surfaces (nord0–3), Snow Storm for text (nord4–6), Frost for
 * accents (nord7–10), Aurora for status colours (nord11–15).
 */
const nord: Theme = {
  id: "nord",
  name: "Nord",
  appearance: "dark",
  source: "builtin",
  colors: {
    background: "#2e3440", // nord0
    foreground: "#eceff4", // nord6
    surface: "#3b4252", // nord1
    border: "#434c5e", // nord2
    muted: "#4c566a", // nord3
    primary: "#88c0d0", // nord8
    secondary: "#b48ead", // nord15
    success: "#a3be8c", // nord14
    warning: "#ebcb8b", // nord13
    error: "#bf616a", // nord11
    info: "#81a1c1", // nord9
  },
};

/**
 * All built-in themes, keyed by id. The registry seeds itself from this map, so
 * this is the single place built-ins are declared.
 */
export const BUILTIN_THEMES: ReadonlyMap<string, Theme> = new Map(
  [github, nord].map((t) => [t.id, t]),
);

/**
 * The theme used whenever a requested theme cannot be resolved *and* the live
 * terminal palette is unavailable — e.g. a `config.theme` naming a deleted
 * custom theme, before terminal detection completes. A safe, legible dark theme.
 */
export const FALLBACK_THEME: Theme = github;
