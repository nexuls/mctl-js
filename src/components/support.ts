/**
 * Shared vocabulary for the component library — pure helpers and types, no JSX
 * and no I/O.
 *
 * **Pure-UI, page-layer rules apply** (AGENTS.md § 3): nothing here touches the
 * filesystem, spawns processes, or calls `Bun.*`. It only describes how the
 * components map the theme's semantic roles onto visual states.
 */

import type { ThemeColors } from "../types/theme.ts";

/**
 * A semantic colour role from the active theme (`"primary"`, `"error"`, …). Every
 * component colours itself by role rather than by a raw hex so a theme swap
 * re-skins the whole UI — the one colour rule in AGENTS.md § architecture.
 */
export type SemanticColor = keyof ThemeColors;

/**
 * The intent behind an interactive element, mapped to a semantic role. This is
 * the shared "variant" language every actionable component speaks (buttons,
 * progress bars, badges) so a `primary` button and a `primary` bar pull the same
 * hue.
 */
export type Variant =
	| "primary"
	| "secondary"
	| "success"
	| "warning"
	| "error"
	| "info"
	| "neutral";

/**
 * Resolve a {@link Variant} to the concrete accent hex for the active palette.
 * `neutral` falls back to `foreground` so a variant-less element still has a
 * sensible ink colour.
 */
export function variantColor(colors: ThemeColors, variant: Variant): string {
	if (variant === "neutral") return colors.foreground;
	return colors[variant];
}

/**
 * The text colour to lay *on top of* a filled accent (a solid button, a keycap).
 * The page background reads as the natural "paper" colour against every accent
 * in both the light and dark variants of our built-in themes, so it is the
 * safe, theme-agnostic choice for on-accent ink.
 */
export function onAccent(colors: ThemeColors): string {
	return colors.background;
}

/**
 * The concrete colours for one visual state of a control. `bgColor` is optional
 * because unfilled states (a resting outline/ghost chip) draw no background.
 */
export interface StateColors {
	/** Background fill, or `undefined` to leave the surface unfilled. */
	bgColor?: string;
	/** Text/ink colour. */
	fgColor: string;
	/** Border colour (ignored by borderless kinds). */
	borderColor: string;
}

/**
 * A control's colours across its interactive states. `default` is the resting
 * look; `hover` and `active` override it when the control is hovered or active.
 * The terminal has no pointer hover, so for a {@link "./Button".Button} "active"
 * means focused. Omitted states fall back to `default`.
 */
export interface Variants {
	default: StateColors;
	hover?: StateColors;
	active?: StateColors;
}

/**
 * Pick the {@link StateColors} for a control from its {@link Variants}, given
 * which interactive state it is in. `active` wins over `hover`, and either falls
 * back to `default` when that state is not defined for the variant.
 */
export function resolveState(
	variants: Variants,
	state: { hover?: boolean; active?: boolean },
): StateColors {
	if (state.active && variants.active) return variants.active;
	if (state.hover && variants.hover) return variants.hover;
	return variants.default;
}

/** Clamp `n` into the inclusive `[min, max]` range. */
export function clamp(n: number, min: number, max: number): number {
	return n < min ? min : n > max ? max : n;
}

/**
 * Decide whether a set of option labels laid out as horizontal tabs will fit
 * within `available` cells. Used by {@link "./Form".Select} to choose between the
 * side-by-side tab layout (few, short options) and the vertical dropdown (many
 * or long options) — the adaptive behaviour called for in the field spec.
 *
 * The estimate mirrors how a tab row is drawn: each label gets one cell of
 * padding on each side, and tabs are separated by a single divider cell.
 */
export function optionsFitAsTabs(labels: string[], available: number): boolean {
	if (labels.length === 0) return true;
	const PADDING_PER_TAB = 2; // one cell each side of the label
	const DIVIDER = 1; // between adjacent tabs
	const total =
		labels.reduce((sum, label) => sum + label.length + PADDING_PER_TAB, 0) +
		DIVIDER * (labels.length - 1);
	return total <= available;
}

/** What a pointer landed on inside a `<tab-select>` row. */
export type TabSelectHit =
	/** A tab, identified by its index in the full (unscrolled) option list. */
	| { kind: "tab"; index: number }
	/** One of the end arrows: `-1` walks the strip left, `1` right. */
	| { kind: "scroll"; direction: -1 | 1 }
	/** Empty space, or a row that is not the tab row. */
	| { kind: "none" };

/** Geometry of a `<tab-select>`, as the caller can read it off the renderable. */
export interface TabSelectGeometry {
	/** Pointer column relative to the renderable's left edge. */
	offsetX: number;
	/** Pointer row relative to the renderable's top edge. */
	offsetY: number;
	/** The renderable's width in cells. */
	width: number;
	/** Cells per tab (`tabWidth`). */
	tabWidth: number;
	/** Number of options. */
	count: number;
	/** The currently-selected option index — this is what fixes the scroll offset. */
	selectedIndex: number;
}

/**
 * Resolve a pointer position inside a `<tab-select>` to the tab (or end arrow)
 * drawn under it. OpenTUI's `TabSelectRenderable` handles keys only — it has no
 * mouse behaviour and keeps its scroll offset private — so {@link "./Form".Select}
 * has to reconstruct the layout to make clicking and hovering work.
 *
 * The maths mirrors `TabSelectRenderable.refreshFrameBuffer` /
 * `updateScrollOffset` in `@opentui/core` 0.4.5: tabs are laid out left to right
 * at a fixed `tabWidth` starting from the scroll offset, that offset **is derived
 * from the selection** (it keeps the selected tab near the middle of the strip),
 * and the `‹` / `›` arrows are painted over the first and last cell of the row
 * whenever the options overflow. Arrows therefore win over the tab beneath them,
 * exactly as they do on screen.
 *
 * Pure, and exported so the geometry is testable without a renderer.
 */
export function tabSelectHit(geometry: TabSelectGeometry): TabSelectHit {
	const { offsetX, offsetY, width, tabWidth, count, selectedIndex } = geometry;
	if (offsetY !== 0 || offsetX < 0 || offsetX >= width || count === 0) {
		return { kind: "none" };
	}

	const maxVisible = Math.max(1, Math.floor(width / tabWidth));
	const scrollOffset = Math.max(
		0,
		Math.min(selectedIndex - Math.floor(maxVisible / 2), count - maxVisible),
	);

	if (count > maxVisible) {
		if (offsetX === 0 && scrollOffset > 0) {
			return { kind: "scroll", direction: -1 };
		}
		if (offsetX === width - 1 && scrollOffset + maxVisible < count) {
			return { kind: "scroll", direction: 1 };
		}
	}

	const slot = Math.floor(offsetX / tabWidth);
	if (slot >= maxVisible) return { kind: "none" };
	const index = scrollOffset + slot;
	return index < count ? { kind: "tab", index } : { kind: "none" };
}
