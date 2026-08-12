/**
 * AnsiText — one line of program output, with its ANSI colours honoured.
 *
 * Pure UI: it renders a string it is handed. The escape parsing is a leaf helper
 * (`lib/ansi.ts`); this component owns only the *translation into the app's
 * theme* — an SGR sequence names a palette slot ("green"), and what green looks
 * like here is the active theme's business, not the emitting program's.
 *
 * Why a component and not a formatter: OpenTUI draws into a frame buffer, so
 * escape bytes in a `<text>` child are rendered as literal `[32m` characters.
 * Colour has to arrive as styled child nodes instead.
 */

import { memo, useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import {
	type AnsiColor,
	needsParse,
	parseAnsi,
	xterm256Hex,
} from "../lib/ansi.ts";
import { useTheme } from "../hooks/use-theme.tsx";
import type { ThemeColors } from "../types/theme.ts";

/** Props for {@link AnsiText}. */
export interface AnsiTextProps {
	/** The raw line, escape sequences and all. */
	text: string;
	/** Colour for the runs the line does not colour itself. */
	fg?: string;
	/** Whether the line can be selected for copying. */
	selectable?: boolean;
	/** Highlight colour while selected. */
	selectionBg?: string;
	/** Highlight foreground while selected. */
	selectionFg?: string;
}

/**
 * Map an ANSI colour onto the theme.
 *
 * The 16 palette entries resolve to *semantic roles* rather than literal reds
 * and greens: a theme in MCTL is a role set by design (`types/theme.ts`), and a
 * hard-coded `#00ff00` would be the one thing on screen ignoring the user's
 * theme. The mapping follows the conventional meanings a log emitter is relying
 * on — log4j's default console pattern is green for INFO, yellow for WARN, red
 * for ERROR — so the intent survives the substitution. Bright variants share
 * their base role; the boldness that usually accompanies them carries the
 * distinction.
 *
 * Indices 16–255 have a fixed, terminal-independent definition and are used
 * literally. An explicit 24-bit colour is likewise passed through: a program
 * that names an exact colour has already decided.
 */
export function ansiColor(
	color: AnsiColor,
	colors: ThemeColors,
): string | undefined {
	if (color.kind === "rgb") return color.hex;
	const role = [
		colors.muted, // 0 black — never the literal background colour, or it vanishes
		colors.error, // 1 red
		colors.success, // 2 green
		colors.warning, // 3 yellow
		colors.info, // 4 blue
		colors.secondary, // 5 magenta
		colors.primary, // 6 cyan
		colors.foreground, // 7 white
	][color.index % 8];
	return color.index < 16 ? role : xterm256Hex(color.index);
}

/** The OpenTUI attribute mask for one parsed span. */
function attributesFor(span: {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	blink?: boolean;
	inverse?: boolean;
	strikethrough?: boolean;
}): number {
	let mask = 0;
	if (span.bold) mask |= TextAttributes.BOLD;
	if (span.dim) mask |= TextAttributes.DIM;
	if (span.italic) mask |= TextAttributes.ITALIC;
	if (span.underline) mask |= TextAttributes.UNDERLINE;
	if (span.blink) mask |= TextAttributes.BLINK;
	if (span.inverse) mask |= TextAttributes.INVERSE;
	if (span.strikethrough) mask |= TextAttributes.STRIKETHROUGH;
	return mask;
}

/**
 * Render one line, translating its ANSI styling into styled spans.
 *
 * A line with no escapes takes a fast path and renders as a plain string — that
 * is every line of a vanilla or Paper server, and the console holds thousands of
 * them. Memoised on its props for the same reason: a console tailing a starting
 * server re-renders several times a second with the same lines.
 */
export const AnsiText = memo(function AnsiText({
	text,
	fg,
	selectable,
	selectionBg,
	selectionFg,
}: AnsiTextProps) {
	const { colors } = useTheme();

	const spans = useMemo(
		() => (needsParse(text) ? parseAnsi(text) : undefined),
		[text],
	);

	// A line that is *only* escapes still occupies a row — rendering a childless
	// `<text>` would drop it and shift every line number after it.
	if (!spans || spans.length === 0) {
		return (
			<text
				fg={fg}
				selectable={selectable}
				selectionBg={selectionBg}
				selectionFg={selectionFg}
			>
				{spans ? "" : text}
			</text>
		);
	}

	return (
		<text
			fg={fg}
			selectable={selectable}
			selectionBg={selectionBg}
			selectionFg={selectionFg}
		>
			{spans.map((span, i) => (
				// Index keys: a span's identity *is* its position in the line, and the
				// whole list is rebuilt whenever the line's text changes.
				<span
					key={i}
					fg={span.fg ? ansiColor(span.fg, colors) : undefined}
					bg={span.bg ? ansiColor(span.bg, colors) : undefined}
					attributes={attributesFor(span)}
				>
					{span.text}
				</span>
			))}
		</text>
	);
});
