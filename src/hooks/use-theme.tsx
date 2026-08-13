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
 * the optional `onThemeChange` callback rather than done here — as is the
 * reverse direction, `subscribeThemeId`, which lets the caller push in a theme
 * id changed by another instance or a hand-edit of the config.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
	resolveColors,
	type Theme,
	type ThemeAppearance,
	type ThemeColors,
	type TerminalPalette,
	type ThemeSummary,
} from "../types/theme.ts";
import type { ThemeRegistry } from "../core/theme/registry.ts";
import {
	themeFromTerminalColors,
	terminalAppearance,
} from "../core/theme/terminal.ts";
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
	/** The active theme entry (identity + its full colour scheme). Always defined. */
	theme: Theme;
	/**
	 * The colours to paint with, already resolved for the current host mode. This
	 * is what components read (`colors.primary`, …) — it is the light or dark
	 * variant of {@link theme}, picked by {@link appearance}.
	 */
	colors: ThemeColors;
	/** The host's current light/dark mode, driving which variant is in {@link colors}. */
	appearance: ThemeAppearance;
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
	/**
	 * Bridge for theme changes made **outside** this provider — another `mctl`
	 * instance switching theme, or a hand-edit of `config.json`. Called once on
	 * mount with an `apply` callback; return an unsubscribe.
	 *
	 * It is a prop rather than a bus subscription inside the provider for two
	 * reasons: this hook does no filesystem I/O (re-reading `config.theme` is a
	 * core concern, the mirror image of {@link ThemeProviderProps.onThemeChange}),
	 * and the provider is mounted above `EventBusProvider` so it has no bus in
	 * context. **Must be referentially stable** — it is an effect dependency.
	 */
	subscribeThemeId?: (apply: (id: string) => void) => () => void;
	/**
	 * Bridge for changes to the theme *catalogue* — a file added, edited, or
	 * deleted under `~/.config/mctl/themes/`. Called once on mount with an
	 * `invalidate` callback the caller fires **after** it has re-read the registry
	 * (`await registry.reload()`); the provider then re-resolves the active theme
	 * and the picker's list from the same registry object.
	 *
	 * Same shape and the same reasons as {@link subscribeThemeId}: the reload is
	 * filesystem I/O, which belongs in core, and this provider sits above the
	 * event bus. **Must be referentially stable.**
	 */
	subscribeCatalogue?: (invalidate: () => void) => () => void;
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
	subscribeThemeId,
	subscribeCatalogue,
	children,
}: ThemeProviderProps) {
	const [themeId, setThemeIdState] = useState(initialThemeId);
	// The registry is mutable and reloaded in place, so nothing about its identity
	// changes when its contents do. This counter is the only signal that the
	// memos below have to be recomputed.
	const [catalogue, setCatalogue] = useState(0);
	const { palette } = useTerminalColors(initialPalette);

	// Follow the persisted theme id when it changes underneath us. Only the local
	// state is updated — `onThemeChange` is deliberately NOT fired, since the value
	// came *from* the persisted config and re-persisting it would be a write loop
	// between instances.
	useEffect(() => {
		if (!subscribeThemeId) return;
		return subscribeThemeId((id) => setThemeIdState(id));
	}, [subscribeThemeId]);

	// Follow the themes directory. The caller reloads the registry and then calls
	// back, which is what makes a hand-edited theme file apply live.
	useEffect(() => {
		if (!subscribeCatalogue) return;
		return subscribeCatalogue(() => setCatalogue((n) => n + 1));
	}, [subscribeCatalogue]);

	// The host's current light/dark mode, read from the terminal background. This
	// drives which variant of *any* active theme is painted — static themes
	// included, since the terminal is the only signal of the host mode. Defaults to
	// dark until the palette resolves.
	const appearance = useMemo<ThemeAppearance>(
		() => (palette ? terminalAppearance(palette) : "dark"),
		[palette],
	);

	// The dynamic terminal theme, rebuilt whenever the host palette changes. Falls
	// back to the empty-palette terminal theme (never a static theme) so the
	// "terminal" id always reads as a terminal theme.
	const terminalTheme = useMemo<Theme>(
		() => (palette ? themeFromTerminalColors(palette) : EMPTY_TERMINAL_THEME),
		[palette],
	);

	// `catalogue` is not read in the body on purpose: it is the invalidation
	// signal for the registry's mutable contents, which nothing else can observe.
	// biome-ignore lint/correctness/useExhaustiveDependencies: catalogue invalidates the registry
	const theme = useMemo<Theme>(() => {
		if (registry.isDynamic(themeId)) return terminalTheme;
		// A named theme that no longer resolves (e.g. a deleted custom theme) degrades
		// to the terminal theme rather than an unrelated static default.
		return registry.get(themeId) ?? terminalTheme;
	}, [registry, themeId, terminalTheme, catalogue]);

	// Collapse the active theme's scheme to the concrete palette for the current
	// mode — a `default`-only theme ignores `appearance`, a light/dark theme picks
	// its matching variant.
	const colors = useMemo<ThemeColors>(
		() => resolveColors(theme.colors, appearance),
		[theme, appearance],
	);

	// Same as above: the picker's list has to be rebuilt when the catalogue does.
	// biome-ignore lint/correctness/useExhaustiveDependencies: catalogue invalidates registry.list()
	const value = useMemo<ThemeContextValue>(
		() => ({
			theme,
			colors,
			appearance,
			themeId,
			themes: registry.list(),
			setThemeId: (id: string) => {
				setThemeIdState(id);
				onThemeChange?.(id);
			},
		}),
		[theme, colors, appearance, themeId, registry, onThemeChange, catalogue],
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
