/**
 * `useTerminalColors` — reactively expose the host terminal's own colour scheme.
 *
 * OpenTUI does the hard part: it queries the terminal with ANSI escape codes
 * (OSC 10/11 for fg/bg, OSC 4 for the 16-colour palette) and emits a `palette`
 * event when the colours change. This hook is the React adapter over that,
 * normalising OpenTUI's `TerminalColors` into our UI-neutral {@link TerminalPalette}.
 *
 * Two things are load-bearing and easy to miss (both were the cause of the
 * "theme reverts to fallback on terminal theme change" bug):
 *
 *  1. **We must enable DEC private mode 2031 ourselves** (`CSI ? 2031 h`).
 *     OpenTUI *reacts* to the terminal's "colour scheme changed" notification but
 *     never turns the mode on — so without this write, modern terminals never
 *     notify on change and the `palette` event never fires. We disable it
 *     (`CSI ? 2031 l`) on cleanup so we leave the terminal as we found it.
 *  2. **The poll fallback must clear OpenTUI's palette cache first.**
 *     `getPalette()` returns a cached result, so re-querying without
 *     `clearPaletteCache()` would return the *old* colours forever on terminals
 *     that don't support mode 2031.
 *
 * This is a hook, so it lives in the UI layer and may touch the renderer — but it
 * performs no filesystem or process I/O beyond the two control sequences above.
 * The mapping from these colours to a semantic theme is done in
 * `core/theme/terminal.ts`.
 */

import type { CliRenderer, TerminalColors } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import type { TerminalPalette } from "../types/theme.ts";
import { log } from "../lib/logger.ts";

const logger = log("terminal-colors");

// DEC private mode 2031: ask the terminal to emit a notification whenever its
// colour scheme changes. OpenTUI listens for it but does not enable it.
const ENABLE_COLOR_SCHEME_UPDATES = "\x1b[?2031h";
const DISABLE_COLOR_SCHEME_UPDATES = "\x1b[?2031l";

/** How often to re-query on terminals without live change reporting (mode 2031). */
const POLL_INTERVAL_MS = 1000;

/** Bounded per-query timeout so a silent terminal never hangs the poll. */
const QUERY_TIMEOUT_MS = 200;

/** What the hook exposes: the palette snapshot and whether it has resolved yet. */
export interface TerminalColorState {
	/** Latest terminal palette, or `null` until the first query resolves. */
	palette: TerminalPalette | null;
	/** True once the first palette query has resolved. */
	ready: boolean;
}

/** Adapt OpenTUI's `TerminalColors` (16-entry palette + specials) to our shape. */
function toPalette(colors: TerminalColors): TerminalPalette {
	return {
		foreground: colors.defaultForeground,
		background: colors.defaultBackground,
		// OpenTUI reports the palette in standard ANSI order; keep the first 16.
		ansi: colors.palette.slice(0, 16),
	};
}

/** Order-sensitive fingerprint of the terminal colours, to skip no-op updates. */
function signature(colors: TerminalColors): string {
	return [
		colors.defaultForeground,
		colors.defaultBackground,
		...colors.palette,
	].join("|");
}

/**
 * Whether a query result carries any real colour. During a terminal theme
 * switch the terminal can briefly answer with everything `null`; treating that
 * as a valid palette would flash the UI to empty-defaults for a frame, so we
 * ignore it and keep the last-good palette instead.
 */
function hasColour(colors: TerminalColors): boolean {
	return (
		colors.defaultBackground != null ||
		colors.defaultForeground != null ||
		colors.palette.some((c) => c != null)
	);
}

/**
 * One-shot palette query, for fetching colours *before the first paint* so the
 * UI never renders a frame without them. Resolves `null` if the terminal does
 * not answer within `timeoutMs` (e.g. a non-TTY) — the caller falls back.
 */
export async function queryTerminalPalette(
	renderer: CliRenderer,
	timeoutMs = QUERY_TIMEOUT_MS,
): Promise<TerminalPalette | null> {
	try {
		const colors = await renderer.getPalette({ timeout: timeoutMs });
		return hasColour(colors) ? toPalette(colors) : null;
	} catch {
		return null;
	}
}

/**
 * Subscribe to the host terminal's colours. Re-renders the caller whenever the
 * terminal's palette changes (live via mode 2031, or within `POLL_INTERVAL_MS`
 * on terminals that don't support it).
 *
 * @param initial Palette fetched before mount (see {@link queryTerminalPalette}),
 *   used as the starting value so the first render already has terminal colours.
 */
export function useTerminalColors(
	initial: TerminalPalette | null = null,
): TerminalColorState {
	const renderer = useRenderer();
	const [palette, setPalette] = useState<TerminalPalette | null>(initial);
	const [ready, setReady] = useState(initial !== null);

	useEffect(() => {
		let alive = true;
		let lastSignature: string | null = null;

		const update = (colors: TerminalColors) => {
			if (!alive) return;
			// A transient all-null answer during a theme switch is not a real change —
			// ignore it so we hold the last-good palette rather than flashing empty.
			if (!hasColour(colors)) return;
			setReady(true);
			const sig = signature(colors);
			if (sig === lastSignature) return; // unchanged — don't thrash React state
			const first = lastSignature === null;
			lastSignature = sig;
			const next = toPalette(colors);
			setPalette(next);
			// Colours aren't secret, so logging them is fine — this is the trace the
			// developer looks for to confirm live terminal-theme changes are landing.
			logger.debug(
				{ first, foreground: next.foreground, background: next.background },
				first ? "terminal palette detected" : "terminal palette changed",
			);
		};

		// Turn on live change notifications (see file header, point 1). OpenTUI's
		// output backend is process.stdout, so writing the control sequence there
		// reaches the same terminal the renderer drives.
		process.stdout.write(ENABLE_COLOR_SCHEME_UPDATES);

		// Initial fetch + subscribe to live changes.
		renderer
			.getPalette({ timeout: QUERY_TIMEOUT_MS })
			.then(update)
			.catch(() => {});
		renderer.on("palette", update);

		// Fallback poll for terminals without mode 2031. The cache clear is
		// mandatory (see file header, point 2) — without it getPalette() returns the
		// stale cached palette and a theme change is never observed.
		const poll = setInterval(() => {
			renderer.clearPaletteCache();
			renderer
				.getPalette({ timeout: QUERY_TIMEOUT_MS })
				.then(update)
				.catch(() => {});
		}, POLL_INTERVAL_MS);

		return () => {
			alive = false;
			clearInterval(poll);
			renderer.off("palette", update);
			// Restore the terminal to how we found it.
			process.stdout.write(DISABLE_COLOR_SCHEME_UPDATES);
		};
	}, [renderer]);

	return { palette, ready };
}
