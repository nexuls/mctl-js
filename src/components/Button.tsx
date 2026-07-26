/**
 * Button — a clickable, focusable action control.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders a box + text and reports
 * intent through `onClick`. It never performs the action itself — the page/hook
 * wired to `onClick` does, keeping domain logic out of the component layer.
 *
 * The terminal has no native button, so focus and press states are conveyed with
 * colour: an *outline* button in its resting state fills solid when focused, so
 * the active control in a row is unmistakable without a mouse.
 */

import { useState } from "react";
import type { BorderStyle } from "@opentui/core";
import { useKeyboard, type BoxProps } from "@opentui/react";

import { useTheme } from "../hooks/use-theme.tsx";
import { alpha, darken, fade, lighten } from "../lib/colors.ts";
import {
	onAccent,
	resolveState,
	variantColor,
	type Variant,
	type Variants,
} from "./support.ts";

/** Props for {@link Button}. */
export interface ButtonProps {
	/** The button label. */
	children: React.ReactNode;
	/** Invoked on click, or on Enter/Space while the button is focused. */
	onClick?: () => void;
	/** Visual size. `"small"` drops the border for a compact, single-line chip. */
	size?: "small" | "medium" | "large";
	/** Border glyph style for the chip frame. Ignored by `small` and `ghost`, which draw no border. */
	borderStyle?: BorderStyle;
	/** Intent → accent colour. Defaults to `"primary"`. */
	variant?: Variant;
	/**
	 * `"solid"` fills with the accent at rest; `"outline"` (default) shows a
	 * bordered chip that fills on focus; `"ghost"` is borderless text that tints
	 * on focus (for low-emphasis actions like Cancel).
	 */
	kind?: "solid" | "outline" | "ghost";
	/**
	 * Whether the button is currently pressed. Only the pressed button reacts to
	 * mouse release; a page with several buttons drives this from its own press
	 * state so exactly one is active at a time.
	 */
	active?: boolean;
	/**
	 * Whether this button currently holds focus. Only the focused button reacts to
	 * Enter/Space; a page with several buttons drives this from its own focus
	 * state so exactly one is active at a time.
	 */
	focused?: boolean;
	/**
	 * Fired when the button is clicked, before `onClick`, so the page can move its
	 * focus ring here — a mouse click both focuses and activates the button.
	 */
	onFocused?: () => void;
	/** Dim and ignore all interaction. */
	disabled?: boolean;
	/** Styles */
	hoverDarken?: number;
	hoverAlpha?: number;
	activeLighten?: number;
	activeAlpha?: number;
}

/**
 * An action chip. Click with the mouse, or focus it (via the parent's focus
 * management) and press Enter/Space. Sizes to its label with two cells of side
 * padding.
 */
export function Button({
	children,
	onClick,
	size = "medium",
	borderStyle = "rounded",
	variant = "primary",
	kind = "outline",
	active = false,
	focused = false,
	onFocused,
	disabled = false,
	hoverDarken = 0.2,
	hoverAlpha = 1.0,
	activeLighten = 0.2,
	activeAlpha = 1.0,
	...props
}: BoxProps & ButtonProps) {
	const { colors } = useTheme();
	const accent = variantColor(colors, variant);
	const accentHover = alpha(darken(accent, hoverDarken), hoverAlpha);
	const accentActive = alpha(lighten(accent, activeLighten), activeAlpha);
	const accentDisabled = fade(accent, 0.5);

	const [hovered, setHovered] = useState(false);
	const [pressed, setPressed] = useState(false);

	useKeyboard(
		(key) => {
			if (!focused || disabled) return;
			if (key.name !== "return" && key.name !== "space") return;
			if (key.eventType === "release") {
				setPressed(false);
				return;
			}
			if (key.repeated) return;
			setPressed(true);
			onClick?.();
		},
		{ release: true },
	);

	const press = () => {
		if (disabled) return;
		setPressed(true);
		onFocused?.();
		onClick?.();
	};

	// Colour recipes per kind, keyed by visual state. `hover` covers both pointer
	// hover and keyboard focus (the resting-but-targeted look); `active` is the
	// held-down press — an outline chip fills solid and a ghost tints so a press is
	// unmistakable.
	const variants: Record<NonNullable<ButtonProps["kind"]>, Variants> = {
		solid: {
			default: {
				bgColor: accent,
				fgColor: onAccent(colors),
				borderColor: accent,
			},
			hover: {
				bgColor: accentHover,
				fgColor: onAccent(colors),
				borderColor: accentHover,
			},
			active: {
				bgColor: accentActive,
				fgColor: onAccent(colors),
				borderColor: accentActive,
			},
		},
		ghost: {
			default: { fgColor: accent, borderColor: "transparent" },
			hover: {
				bgColor: size !== "small" ? undefined : accentHover,
				fgColor: size !== "small" ? accentHover : onAccent(colors),
				borderColor: accentHover,
			},
			active: {
				bgColor: size !== "small" ? undefined : accentActive,
				fgColor: size !== "small" ? accentActive : onAccent(colors),
				borderColor: accentActive,
			},
		},
		outline: {
			default: { fgColor: accent, borderColor: accent },
			hover: {
				fgColor: size !== "small" ? accentHover : onAccent(colors),
				borderColor: accentHover,
			},
			active: {
				fgColor: size !== "small" ? accentActive : onAccent(colors),
				borderColor: accentActive,
			},
		},
	};

	// Disabled is a fixed dimmed look; otherwise pick the state colours. A button
	// is hovered when the pointer is over it *or* it holds focus, and active only
	// while it is physically pressed.
	const { bgColor, fgColor, borderColor } = disabled
		? {
				bgColor: undefined,
				fgColor: accentDisabled,
				borderColor: accentDisabled,
			}
		: resolveState(variants[kind], {
				hover: hovered || focused,
				active: pressed || active,
			});

	// The chip is just the label with two cells of side padding. `small` renders
	// as a bare, borderless line of tinted text; every other size draws a bordered
	// chip (which the border grows to three rows tall).
	const PADDING_X = 2;
	const showBorder = size !== "small";

	return (
		<box
			border={showBorder && kind !== "ghost"}
			borderStyle={showBorder ? borderStyle : undefined}
			borderColor={showBorder ? borderColor : undefined}
			backgroundColor={bgColor}
			paddingLeft={PADDING_X}
			paddingRight={PADDING_X}
			flexShrink={0}
			alignItems="center"
			justifyContent="center"
			onMouseDown={press}
			onMouseUp={() => setPressed(false)}
			onMouseOver={() => !disabled && setHovered(true)}
			onMouseOut={() => {
				setHovered(false);
				setPressed(false);
			}}
			{...props}
		>
			{typeof children === "string" ? (
				<text fg={fgColor}>{children}</text>
			) : (
				children
			)}
		</box>
	);
}
