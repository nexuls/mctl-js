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
 * GitHub, with both light and dark palettes — the active one is chosen from the
 * host's current mode.
 * Palette: https://primer.style/foundations/color/base-scales — the values used
 * across github.com's dark theme (canvas #0d1117, accent #58a6ff, …) and light
 * theme (canvas #ffffff, accent #0969da, …).
 */
const github: Theme = {
	id: "github",
	name: "GitHub",
	source: "builtin",
	colors: {
		dark: {
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
		light: {
			background: "#ffffff",
			foreground: "#1f2328",
			surface: "#f6f8fa",
			border: "#d0d7de",
			muted: "#59636e",
			primary: "#0969da",
			secondary: "#8250df",
			success: "#1a7f37",
			warning: "#9a6700",
			error: "#cf222e",
			info: "#0550ae",
		},
	},
};

/**
 * Nord — the arctic, north-bluish palette, with a light Snow Storm variant.
 * Palette: https://www.nordtheme.com/docs/colors-and-palettes
 * Polar Night for surfaces (nord0–3), Snow Storm for text (nord4–6), Frost for
 * accents (nord7–10), Aurora for status colours (nord11–15). The light variant
 * swaps Polar Night and Snow Storm (light canvas, dark text) and reaches for the
 * darker Frost blues (nord9/10) so accents stay legible on a pale background.
 */
const nord: Theme = {
	id: "nord",
	name: "Nord",
	source: "builtin",
	colors: {
		dark: {
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
		light: {
			background: "#eceff4", // nord6
			foreground: "#2e3440", // nord0
			surface: "#e5e9f0", // nord5
			border: "#d8dee9", // nord4
			muted: "#4c566a", // nord3
			primary: "#5e81ac", // nord10 — darker Frost, legible on light
			secondary: "#b48ead", // nord15
			success: "#a3be8c", // nord14
			warning: "#ebcb8b", // nord13
			error: "#bf616a", // nord11
			info: "#81a1c1", // nord9
		},
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
