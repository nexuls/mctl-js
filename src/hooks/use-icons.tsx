/**
 * Icon context: makes the active glyph set available to every component, and
 * lets the app switch sets at runtime.
 *
 * The mirror image of {@link "./use-theme".ThemeProvider} — colour and glyphs
 * are the two halves of "appearance", and both follow the same rules: the
 * catalogue is pure data in `core/`, the provider does **no filesystem I/O**,
 * and persisting a change back to `config.json` is surfaced through
 * `onModeChange` (with `subscribeMode` as the reverse bridge for a change made
 * by another instance or a hand-edit) rather than performed here.
 *
 * ## The one deliberate difference from the theme provider
 *
 * {@link useIcons} **does not throw** outside a provider; it falls back to the
 * auto-detected set. A component with no colours is unrenderable, so `useTheme`
 * failing loudly is right — but every icon has a working default, and a pure-UI
 * component in the kit must stay mountable in a test (or a preview script)
 * without a provider it does not otherwise need. Nothing is silently wrong: the
 * fallback is the same set `auto` would have chosen.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { iconsFor, resolveIconSet, spinnerFor } from "../core/icons/index.ts";
import type { IconMode } from "../types/config.ts";
import type { IconMap, IconSet } from "../types/icons.ts";

/**
 * The set used when no provider is mounted — resolved once from the process
 * environment, exactly as `auto` would resolve it. Module-level so it is
 * referentially stable: {@link useIcons} hands it straight to consumers.
 */
const FALLBACK_SET: IconSet = resolveIconSet("auto", process.env);

/** Value exposed by {@link useIcons}. */
export interface IconContextValue {
	/** The glyphs to draw with: `icons.icons.success`, … (see {@link icons}). */
	icons: IconMap;
	/** The set those glyphs came from, for a picker's "resolved to …" caption. */
	set: IconSet;
	/** The configured mode. `"auto"` unless the user pinned a set. */
	mode: IconMode;
	/** Switch the mode. Persisted by the provider's `onModeChange`. */
	setMode: (mode: IconMode) => void;
	/** Animation frames for a spinner in the active set. Length varies by set. */
	spinner: readonly string[];
}

const IconContext = createContext<IconContextValue | null>(null);

export interface IconProviderProps {
	/** Initial mode, typically `config.icons`. Defaults to `"auto"`. */
	initialMode?: IconMode;
	/** Notified when the mode changes, e.g. to persist to `config.json`. */
	onModeChange?: (mode: IconMode) => void;
	/**
	 * Bridge for mode changes made **outside** this provider — another `mctl`
	 * instance, or a hand-edit of `config.json`. Called once on mount with an
	 * `apply` callback; return an unsubscribe. **Must be referentially stable** —
	 * it is an effect dependency. See `ThemeProviderProps.subscribeThemeId` for
	 * the same pattern and why it is a prop rather than a bus subscription.
	 */
	subscribeMode?: (apply: (mode: IconMode) => void) => () => void;
	children: React.ReactNode;
}

/**
 * Provide the icon context. Resolves the mode to a concrete set on every
 * change, reading `MCTL_ICONS` and the terminal-detection heuristics through
 * `core/icons` — the React tree never inspects the environment itself.
 */
export function IconProvider({
	initialMode = "auto",
	onModeChange,
	subscribeMode,
	children,
}: IconProviderProps) {
	const [mode, setModeState] = useState<IconMode>(initialMode);

	// Follow the persisted mode when it changes underneath us. Local state only —
	// `onModeChange` is deliberately NOT fired, since the value came *from* the
	// persisted config and re-persisting it would be a write loop between
	// instances (the exact bug the theme bridge had to be fixed for).
	useEffect(() => {
		if (!subscribeMode) return;
		return subscribeMode((next) => setModeState(next));
	}, [subscribeMode]);

	// `process.env` is read on every resolve rather than captured once, so an
	// `MCTL_ICONS` override set for the process is honoured no matter when the
	// mode changes.
	const set = useMemo<IconSet>(() => resolveIconSet(mode, process.env), [mode]);

	const value = useMemo<IconContextValue>(
		() => ({
			icons: iconsFor(set),
			spinner: spinnerFor(set),
			set,
			mode,
			setMode: (next: IconMode) => {
				setModeState(next);
				onModeChange?.(next);
			},
		}),
		[set, mode, onModeChange],
	);

	return <IconContext value={value}>{children}</IconContext>;
}

/**
 * Read the active glyph set.
 *
 * Outside an {@link IconProvider} this returns the auto-detected set rather
 * than throwing (see the module comment) — so a component can be mounted bare
 * in a test and still draw sensible glyphs.
 */
export function useIcons(): IconContextValue {
	const ctx = useContext(IconContext);
	return ctx ?? FALLBACK;
}

/** The context value used when no provider is mounted. Built once. */
const FALLBACK: IconContextValue = Object.freeze({
	icons: iconsFor(FALLBACK_SET),
	spinner: spinnerFor(FALLBACK_SET),
	set: FALLBACK_SET,
	mode: "auto" as IconMode,
	// No provider means nothing owns the mode; a caller that wants to change it
	// must mount one. Silently ignoring is right here — throwing would punish a
	// component for a wiring choice made far above it.
	setMode: () => {},
});
