/**
 * ProgressBar — a horizontal progress meter with a family of track styles.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders a coloured track only. It maps
 * an amount to a filled bar; the caller supplies the amount from a Job's progress
 * events — the component knows nothing about downloads or installs.
 *
 * Drawn as rows of glyphs rather than nested boxes so a bar is one flexible line
 * that composes anywhere (inside a toast, a table cell, a form row). The glyph
 * tables in {@link PROGRESS_STYLES} are the whole visual vocabulary: pick a
 * {@link ProgressBarStyle} for weight/texture, a {@link Variant} (or
 * {@link ProgressThreshold}s) for colour, and a {@link ProgressReadout} for the
 * trailing number.
 *
 * The layout maths lives in exported pure helpers (`fillGlyphs`,
 * `indeterminateGlyphs`, `thresholdVariant`) so it is unit-testable without a
 * renderer — see `ProgressBar.test.ts`.
 */

import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";
import { clamp, variantColor, type Variant } from "./support.ts";
import { mix } from "../lib/colors.ts";

/**
 * The track's visual language. Styles differ in weight and texture, not in
 * meaning — all of them read as "this much of that".
 *
 * - `blocks` — full block over a light shade. The default; heaviest, most legible.
 * - `smooth` — like `blocks` but the leading cell is drawn with an eighth-block
 *   glyph, giving eight sub-cell steps instead of one (best for slow progress).
 * - `shaded` — medium over light shade; quieter than `blocks` at the same width.
 * - `line` — a one-cell-tall rule, matching the `Tabs`/`NavRail` rule language.
 *   Use where a bar must sit under text without shouting.
 * - `smooth-line` — `line` with half-cell steps, so a narrow rule still moves on
 *   small increments.
 * - `dots` — braille cells; reads as a dotted gauge, good next to small type.
 * - `segments` — discrete filled/empty units, for counts (3 of 8 mods installed).
 * - `ascii` — no box-drawing at all, for terminals/fonts that mangle Unicode.
 */
export type ProgressBarStyle =
	| "blocks"
	| "smooth"
	| "shaded"
	| "line"
	| "smooth-line"
	| "dots"
	| "segments"
	| "ascii";

/** The glyphs one {@link ProgressBarStyle} draws its track with. */
export interface ProgressGlyphs {
	/** Glyph for a fully filled cell. */
	fill: string;
	/** Glyph for an unfilled cell. */
	empty: string;
	/**
	 * Optional sub-cell fill steps, ordered from the least ink to the most and
	 * excluding the full cell — so `n` partials give a style `n + 1` steps per
	 * cell (`smooth` has seven eighth-blocks, `smooth-line` one half-rule). A
	 * style without them rounds to whole cells.
	 */
	partials?: readonly string[];
}

/**
 * The glyph table for every style. Exported so a page can preview the styles (or
 * a test can assert on them) without duplicating the characters.
 */
export const PROGRESS_STYLES: Record<ProgressBarStyle, ProgressGlyphs> = {
	blocks: { fill: "█", empty: "░" },
	// U+2588 FULL BLOCK plus the seven partial blocks U+258F..U+2589. Ordered
	// left-to-right by how much of the cell they ink, which is what lets the
	// leading cell show eighths of progress.
	smooth: {
		fill: "█",
		empty: "░",
		partials: ["▏", "▎", "▍", "▌", "▋", "▊", "▉"],
	},
	shaded: { fill: "▓", empty: "░" },
	line: { fill: "━", empty: "─" },
	// U+2578 HEAVY LEFT is the only sub-cell step the heavy rule has — it inks the
	// left half of the cell — so this style steps in halves where `smooth` steps in
	// eighths. Still twice the resolution of `line`, which is what a thin bar needs
	// most: at 24 cells a whole-cell rule sits still for 4% at a time.
	"smooth-line": { fill: "━", empty: "─", partials: ["╸"] },
	dots: { fill: "⣿", empty: "⣀" },
	segments: { fill: "▰", empty: "▱" },
	ascii: { fill: "#", empty: "-" },
};

/** What (if anything) is printed alongside the track. */
export type ProgressReadout =
	/** Nothing — the bar alone. */
	| "none"
	/** `NN%`. */
	| "percent"
	/** `value/max`, rounded to whole numbers (`3/8`). */
	| "fraction";

/**
 * A colour switch that trips at a given fill level: the bar takes the `variant`
 * of the *last* threshold whose `at` is ≤ the current fraction.
 *
 * This is how a meter says something the fraction alone cannot — a disk-usage
 * bar going `success → warning → error` as it fills, or a download staying
 * `info` until it completes. Order does not matter; `thresholdVariant` sorts.
 */
export interface ProgressThreshold {
	/** Fill fraction in `[0, 1]` at which this variant takes over. */
	at: number;
	/** The variant to use from `at` upward. */
	variant: Variant;
}

/** Frames per second for a self-driven {@link ProgressBarProps.indeterminate} sweep. */
const SWEEP_FPS = 12;

/** Props for {@link ProgressBar}. */
export interface ProgressBarProps {
	/**
	 * Amount done. Interpreted against {@link ProgressBarProps.max}, so with the
	 * default `max` of `1` this is a fraction in `[0, 1]`. Out-of-range values are
	 * clamped.
	 */
	value: number;
	/** The value that means "complete". Defaults to `1` (i.e. `value` is a fraction). */
	max?: number;
	/** Track width in cells. Defaults to 24. */
	width?: number;
	/** Fill colour intent. Defaults to `"primary"`. */
	variant?: Variant;
	/** Track glyph language. Defaults to `"blocks"`. */
	style?: ProgressBarStyle;
	/**
	 * Colour switches by fill level (see {@link ProgressThreshold}). When none
	 * matches the current fraction, {@link ProgressBarProps.variant} is used.
	 */
	thresholds?: readonly ProgressThreshold[];
	/** Trailing readout. Defaults to `"none"`. */
	readout?: ProgressReadout;
	/**
	 * Custom readout text, overriding {@link ProgressBarProps.readout}. Receives
	 * the clamped fraction alongside the raw value and max.
	 */
	format?: (info: { value: number; max: number; fraction: number }) => string;
	/** Draw the readout before the track instead of after it. */
	readoutFirst?: boolean;
	/** Caption drawn before the track, in the muted colour. */
	label?: string;
	/** Wrap the track in muted `[` `]` delimiters. */
	brackets?: boolean;
	/**
	 * Render the unfilled track in the accent colour, heavily dimmed toward the
	 * border colour, instead of plain border grey. Reads as one continuous meter
	 * rather than a bar sitting in a groove.
	 */
	tintTrack?: boolean;
	/** Bold the filled run. Useful when a bar must win against busy chrome. */
	bold?: boolean;
	/**
	 * Draw a second, half-height row beneath the track so the bar reads as a
	 * thicker element in a dense layout.
	 */
	thick?: boolean;
	/**
	 * Progress is unknown: sweep a lit window back and forth instead of filling.
	 * `value` is ignored and any percent readout is suppressed (there is no
	 * percentage to report).
	 */
	indeterminate?: boolean;
	/**
	 * Animation frame for the {@link ProgressBarProps.indeterminate} sweep. Supply
	 * it to drive the animation from a caller that already has a ticker (as the
	 * toast provider does for spinners); omit it and the bar runs its own.
	 */
	frame?: number;
	/**
	 * Show a trailing `NN%` readout.
	 *
	 * @deprecated Pass `readout="percent"` instead. Kept because it is the shape
	 * the first callers were written against; it is ignored when `readout` is set.
	 */
	showPercent?: boolean;
}

/**
 * Pick the variant a bar should draw at `fraction`, given a base variant and an
 * optional set of {@link ProgressThreshold}s. The last threshold at or below the
 * fraction wins; with no matching threshold the base variant stands.
 *
 * Pure — exported for testing and for callers that need to colour a readout to
 * match the bar.
 */
export function thresholdVariant(
	fraction: number,
	base: Variant,
	thresholds?: readonly ProgressThreshold[],
): Variant {
	if (!thresholds || thresholds.length === 0) return base;
	let chosen = base;
	let best = -Infinity;
	for (const threshold of thresholds) {
		if (threshold.at <= fraction && threshold.at >= best) {
			best = threshold.at;
			chosen = threshold.variant;
		}
	}
	return chosen;
}

/**
 * Split a `width`-cell track into its filled and unfilled runs for `fraction`.
 *
 * Styles with `partials` (only `smooth`) render the leading cell at one of eight
 * sub-cell steps, so `filled` can end in a partial glyph; every other style
 * rounds to whole cells. A non-zero fraction always inks at least one cell —
 * otherwise a download that has genuinely started looks like it has not.
 *
 * Pure — exported for testing.
 */
export function fillGlyphs(
	fraction: number,
	width: number,
	glyphs: ProgressGlyphs,
): { filled: string; empty: string } {
	const cells = Math.max(0, Math.floor(width));
	const f = clamp(fraction, 0, 1);
	if (cells === 0) return { filled: "", empty: "" };

	if (!glyphs.partials) {
		let filled = Math.round(f * cells);
		if (f > 0 && filled === 0) filled = 1;
		if (f < 1 && filled === cells) filled = cells - 1;
		return {
			filled: glyphs.fill.repeat(filled),
			empty: glyphs.empty.repeat(cells - filled),
		};
	}

	const exact = f * cells;
	const whole = Math.min(cells, Math.floor(exact));
	const steps = glyphs.partials.length + 1; // eighths: 7 partials + the full cell
	const remainder = Math.floor((exact - whole) * steps);
	const partial =
		whole < cells && remainder > 0
			? (glyphs.partials[remainder - 1] ?? "")
			: "";
	// A started-but-tiny fraction still gets the thinnest visible sliver.
	const lead =
		partial === "" && whole === 0 && f > 0
			? (glyphs.partials[0] ?? "")
			: partial;
	const used = whole + (lead === "" ? 0 : 1);
	return {
		filled: glyphs.fill.repeat(whole) + lead,
		empty: glyphs.empty.repeat(Math.max(0, cells - used)),
	};
}

/**
 * Lay out one frame of an indeterminate sweep: a lit window bouncing between the
 * ends of the track. Returns the three runs — unlit lead-in, lit window, unlit
 * trail — so the caller can colour them independently.
 *
 * The window is a quarter of the track (at least two cells) and reverses at each
 * end rather than wrapping, which reads as activity without implying a direction
 * of travel. Pure — exported for testing.
 */
export function indeterminateGlyphs(
	frame: number,
	width: number,
	glyphs: ProgressGlyphs,
): { lead: string; lit: string; trail: string } {
	const cells = Math.max(0, Math.floor(width));
	if (cells === 0) return { lead: "", lit: "", trail: "" };

	const window = Math.min(cells, Math.max(2, Math.round(cells / 4)));
	const travel = cells - window;
	if (travel <= 0) {
		return { lead: "", lit: glyphs.fill.repeat(cells), trail: "" };
	}

	// Bounce: the frame counter runs over a period of 2×travel and folds back on
	// itself in the second half.
	const period = travel * 2;
	const phase = ((Math.floor(frame) % period) + period) % period;
	const offset = phase <= travel ? phase : period - phase;

	return {
		lead: glyphs.empty.repeat(offset),
		lit: glyphs.fill.repeat(window),
		trail: glyphs.empty.repeat(cells - window - offset),
	};
}

/**
 * A fixed-width progress bar.
 *
 * The filled run is drawn in the accent colour for the resolved variant and the
 * remainder in a muted shade, so the full track is always visible. Everything
 * beyond that — glyph weight, sub-cell precision, colour thresholds, the
 * readout, an indeterminate sweep — is opt-in through props; the default is the
 * plain block bar the first callers were written against.
 */
export function ProgressBar({
	value,
	max = 1,
	width = 24,
	variant = "primary",
	style = "blocks",
	thresholds,
	readout,
	format,
	readoutFirst = false,
	label,
	brackets = false,
	tintTrack = false,
	bold = false,
	thick = false,
	indeterminate = false,
	frame,
	showPercent = false,
}: ProgressBarProps) {
	const { colors } = useTheme();
	const glyphs = PROGRESS_STYLES[style];
	const fraction = max === 0 ? 0 : clamp(value / max, 0, 1);
	const accent = variantColor(
		colors,
		thresholdVariant(fraction, variant, thresholds),
	);
	const trackColor = tintTrack
		? mix(accent, colors.border, 0.25)
		: colors.border;
	const attributes = bold ? TextAttributes.BOLD : undefined;

	// Self-driven sweep, used only when the bar is indeterminate and the caller
	// has not supplied its own frame counter. It ticks state on this component
	// alone, so an animating bar never re-renders the page around it.
	const [ownFrame, setOwnFrame] = useState(0);
	const selfDriven = indeterminate && frame === undefined;
	useEffect(() => {
		if (!selfDriven) return;
		const timer = setInterval(
			() => setOwnFrame((f) => f + 1),
			1000 / SWEEP_FPS,
		);
		return () => clearInterval(timer);
	}, [selfDriven]);

	const sweep = indeterminate
		? indeterminateGlyphs(frame ?? ownFrame, width, glyphs)
		: undefined;
	const runs = sweep ? undefined : fillGlyphs(fraction, width, glyphs);

	const text = readoutText({
		indeterminate,
		fraction,
		value,
		max,
		format,
		readout: readout ?? (showPercent ? "percent" : "none"),
	});
	const readoutNode = text ? <text fg={colors.muted}>{text}</text> : null;

	const track = (
		<text>
			{brackets ? <span fg={colors.border}>[</span> : null}
			{sweep ? (
				<>
					<span fg={trackColor}>{sweep.lead}</span>
					<span fg={accent} attributes={attributes}>
						{sweep.lit}
					</span>
					<span fg={trackColor}>{sweep.trail}</span>
				</>
			) : (
				<>
					<span fg={accent} attributes={attributes}>
						{runs?.filled}
					</span>
					<span fg={trackColor}>{runs?.empty}</span>
				</>
			)}
			{brackets ? <span fg={colors.border}>]</span> : null}
		</text>
	);

	return (
		<box flexDirection="row" gap={1} alignItems="center">
			{label ? <text fg={colors.muted}>{label}</text> : null}
			{readoutFirst ? readoutNode : null}
			{thick ? (
				// Two rows: the track proper, and a half-height shadow beneath it in the
				// same runs. A terminal cell has no height control, so "thicker" can only
				// mean "more rows" — the lower one uses the half-block so the pair reads
				// as one weighted bar rather than two stacked bars.
				<box flexDirection="column">
					{track}
					<text>
						{brackets ? <span fg={colors.border}> </span> : null}
						<span fg={accent}>
							{"▄".repeat((sweep ? sweep.lit : (runs?.filled ?? "")).length)}
						</span>
						<span fg={trackColor}>
							{"▄".repeat(
								Math.max(
									0,
									width -
										(sweep ? sweep.lit.length : (runs?.filled ?? "").length),
								),
							)}
						</span>
					</text>
				</box>
			) : (
				track
			)}
			{readoutFirst ? null : readoutNode}
		</box>
	);
}

/**
 * Build the readout string, or `undefined` when there is nothing to print. A
 * `format` callback wins over the `readout` mode; an indeterminate bar reports
 * no percentage because it has none, but a custom `format` is still honoured
 * (a caller may want to show elapsed time there).
 */
function readoutText(args: {
	indeterminate: boolean;
	fraction: number;
	value: number;
	max: number;
	readout: ProgressReadout;
	format?: (info: { value: number; max: number; fraction: number }) => string;
}): string | undefined {
	const { indeterminate, fraction, value, max, readout, format } = args;
	if (format) return format({ value, max, fraction });
	if (indeterminate) return undefined;
	if (readout === "percent") return `${Math.round(fraction * 100)}%`;
	if (readout === "fraction") return `${Math.round(value)}/${Math.round(max)}`;
	return undefined;
}
