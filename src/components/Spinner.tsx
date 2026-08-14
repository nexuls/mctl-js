/**
 * Spinner — an animated "work in flight" glyph, with an optional caption.
 *
 * **Pure-UI** (AGENTS.md § 3): it renders the active icon set's spinner frames
 * and knows nothing about what is being waited for.
 *
 * It exists because a hint line reading "loading…" is easy to miss and says
 * nothing about whether the wait is still alive — a version list that takes four
 * seconds and a version list that will never arrive look identical. A moving
 * glyph inside the field itself is the difference.
 *
 * Like {@link "./ProgressBar".ProgressBar}'s indeterminate sweep, it animates
 * itself unless a caller that already owns a ticker supplies `frame` (the toast
 * provider does, so a screen full of toasts repaints once rather than once per
 * card). Self-driven ticking sets state on this component alone, so the page
 * around it is not re-rendered ten times a second.
 */

import { useEffect, useState } from "react";
import { useIcons } from "../hooks/use-icons.tsx";
import { useTheme } from "../hooks/use-theme.tsx";
import { type Variant, variantColor } from "./support.ts";

/** Default animation rate. Fast enough to read as motion, cheap enough to run. */
const SPINNER_FPS = 10;

/** Props for {@link Spinner}. */
export interface SpinnerProps {
	/** Optional muted caption drawn after the glyph. */
	label?: string;
	/** Accent the glyph reads in. Defaults to `"primary"`. */
	variant?: Variant;
	/**
	 * Animation frame, when the caller owns a ticker. Omit it and the spinner
	 * runs its own interval.
	 */
	frame?: number;
	/** Frames per second for the self-driven ticker. Defaults to 10. */
	fps?: number;
}

/**
 * Render one frame of a spinner, plus its caption.
 *
 * The frame count differs per icon set (ASCII has four, the others ten), so the
 * index is always taken modulo the set's length — never assumed.
 */
export function Spinner({
	label,
	variant = "primary",
	frame,
	fps = SPINNER_FPS,
}: SpinnerProps) {
	const { colors } = useTheme();
	const { spinner } = useIcons();

	const [ownFrame, setOwnFrame] = useState(0);
	const selfDriven = frame === undefined;
	useEffect(() => {
		if (!selfDriven) return;
		const timer = setInterval(() => setOwnFrame((f) => f + 1), 1000 / fps);
		return () => clearInterval(timer);
	}, [selfDriven, fps]);

	const glyph = spinner[(frame ?? ownFrame) % spinner.length];

	return (
		<box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
			<text fg={variantColor(colors, variant)} flexShrink={0}>
				{glyph}
			</text>
			{label ? (
				<text fg={colors.muted} flexShrink={0} wrapMode="none">
					{label}
				</text>
			) : null}
		</box>
	);
}
