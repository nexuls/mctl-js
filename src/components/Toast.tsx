/**
 * Toast — a transient notification card and the stacked, screen-anchored viewport
 * it lives in.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): everything here renders props and
 * reports intent through callbacks. It owns no timers, no queue, and no domain
 * state — {@link "../hooks/use-toast".ToastProvider} owns all of that and feeds
 * this file a plain list of {@link ToastVisual}s. That split is deliberate: the
 * card can be rendered (and tested) with no scheduler running.
 *
 * The terminal has no window manager and no notification area, so a "viewport" is
 * an absolutely-positioned, content-sized box anchored to one screen corner/edge
 * at a high `zIndex`, mounted at the root of the tree (see `App.tsx`). It is
 * deliberately *not* full-screen: a full-screen overlay would sit over the page
 * and intercept mouse events meant for it.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";
import { Kbd } from "./Kbd.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { variantColor, type Variant } from "./support.ts";
import { alpha } from "../lib/colors.ts";

/** Where a stack of toasts is anchored on screen. */
export type ToastPosition =
	| "top-left"
	| "top-center"
	| "top-right"
	| "bottom-left"
	| "bottom-center"
	| "bottom-right";

/** Every {@link ToastPosition}, for iteration. */
export const TOAST_POSITIONS: readonly ToastPosition[] = [
	"top-left",
	"top-center",
	"top-right",
	"bottom-left",
	"bottom-center",
	"bottom-right",
];

/**
 * An optional action offered by a toast ("Undo", "Retry", "View logs").
 *
 * A terminal toast is not focusable — it would fight the page's focus ring — so
 * an action is reachable by mouse click, and by a single key when `key` is set.
 * The provider binds that key globally while the toast is showing, so pick
 * something unlikely to collide (see `use-toast.tsx` for the capture guard that
 * stops it stealing keystrokes from a live text field).
 */
export interface ToastAction {
	/** Button label, e.g. `"Retry"`. */
	label: string;
	/**
	 * Key that triggers the action while the toast is showing (an OpenTUI key
	 * name such as `"r"`). Omit for a click-only action.
	 */
	key?: string;
	/** What to run. The toast is dismissed after this returns. */
	onAction: () => void;
}

/** The default glyph for each variant, used when no `icon` is given. */
export const TOAST_ICONS: Record<Variant, string> = {
	primary: "●",
	secondary: "◆",
	success: "✔",
	warning: "▲",
	error: "✖",
	info: "ℹ",
	neutral: "·",
};

/** Spinner frames for a `loading` toast, cycled by the provider's ticker. */
export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;

/** Default card width in cells, when the caller does not pick one. */
export const DEFAULT_TOAST_WIDTH = 42;

/** How many wrapped lines the title and the description are each allowed. */
const TITLE_LINES = 2;
const DESCRIPTION_LINES = 3;

/**
 * Everything {@link ToastCard} needs to draw one toast. This is the presentation
 * shape only: the provider's record adds scheduling fields (delay, TTL, paused)
 * that never reach the card.
 */
export interface ToastVisual {
	/** Stable id, used as the React key and to route callbacks. */
	id: string;
	/** The headline. Wrapped to at most two lines. */
	title: string;
	/** Optional supporting line(s), wrapped to at most three. */
	description?: string;
	/** Intent → accent colour for the border, icon, and meter. */
	variant: Variant;
	/** Override the variant's default glyph, or `false` to draw no icon. */
	icon?: string | false;
	/** Draw an animated spinner in place of the icon (work in flight). */
	loading?: boolean;
	/** Show the ✕ affordance and dismiss on click. */
	dismissible?: boolean;
	/** Optional action offered alongside the message. */
	action?: ToastAction;
	/** Card width in cells. Defaults to {@link DEFAULT_TOAST_WIDTH}. */
	width?: number;
	/**
	 * Fraction of the time-to-live still remaining, `1`→`0`. When set, a meter is
	 * drawn along the bottom of the card; omit it to draw none.
	 */
	remaining?: number;
}

/**
 * Wrap `text` to `width` cells, greedily by word, breaking words that are longer
 * than a line. At most `maxLines` lines are returned; when the text does not fit,
 * the last line is truncated with an ellipsis so nothing is silently lost.
 *
 * Terminal text does not reflow on its own here — each line is rendered as its
 * own `<text>` — so wrapping is our job. Exported for unit testing.
 */
export function wrapText(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	const lines: string[] = [];
	let line = "";

	const push = (value: string) => {
		lines.push(value);
		line = "";
	};

	for (const word of words) {
		if (lines.length >= maxLines) break;
		if (line.length === 0 && word.length > width) {
			// A single word longer than the line: hard-break it across lines.
			let rest = word;
			while (rest.length > width && lines.length < maxLines) {
				push(rest.slice(0, width));
				rest = rest.slice(width);
			}
			line = rest;
			continue;
		}
		const candidate = line.length === 0 ? word : `${line} ${word}`;
		if (candidate.length <= width) {
			line = candidate;
		} else {
			push(line);
			line = word.length > width ? word.slice(0, width) : word;
		}
	}
	if (line.length > 0 && lines.length < maxLines) lines.push(line);

	if (lines.length === 0) return [];
	// Anything that did not fit is signalled on the final line rather than dropped.
	const consumed = lines.join(" ").replace(/\s+/g, " ").trim();
	const wanted = words.join(" ");
	if (consumed.length < wanted.length) {
		const last = lines[lines.length - 1] ?? "";
		lines[lines.length - 1] =
			last.length >= width ? `${last.slice(0, Math.max(0, width - 1))}…` : `${last}…`;
	}
	return lines;
}

/** Props for {@link ToastCard}. */
export interface ToastCardProps {
	/** What to draw. */
	toast: ToastVisual;
	/** Current spinner glyph, supplied by the provider's ticker. */
	spinner?: string;
	/** Dismiss requested — the ✕ was clicked, or the card body was. */
	onDismiss?: () => void;
	/** The action was clicked. The provider dismisses afterwards. */
	onAction?: () => void;
	/** Pointer entered the card — the provider pauses the TTL. */
	onPause?: () => void;
	/** Pointer left the card — the provider resumes the TTL. */
	onResume?: () => void;
}

/**
 * One toast, drawn as a bordered card tinted by its variant: an icon column, a
 * bold title, optional wrapped description, an optional action chip, and an
 * optional time-to-live meter along the bottom.
 *
 * Clicking a dismissible card dismisses it; hovering it pauses its countdown (the
 * provider decides, this component only reports the pointer).
 */
export function ToastCard({
	toast,
	spinner,
	onDismiss,
	onAction,
	onPause,
	onResume,
}: ToastCardProps) {
	const { colors } = useTheme();
	const accent = variantColor(colors, toast.variant);
	const width = toast.width ?? DEFAULT_TOAST_WIDTH;
	const dismissible = toast.dismissible ?? true;

	// Interior width: the border eats two cells and the card pads one each side.
	const inner = Math.max(1, width - 4);
	// The icon column (glyph + gap) and the trailing ✕ shrink the text column.
	const glyph = toast.loading
		? (spinner ?? SPINNER_FRAMES[0])
		: toast.icon === false
			? undefined
			: (toast.icon ?? TOAST_ICONS[toast.variant]);
	const textWidth = Math.max(1, inner - (glyph ? 2 : 0) - (dismissible ? 2 : 0));

	const titleLines = wrapText(toast.title, textWidth, TITLE_LINES);
	const descriptionLines = toast.description
		? wrapText(toast.description, textWidth, DESCRIPTION_LINES)
		: [];

	return (
		<box
			width={width}
			flexShrink={0}
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={accent}
			backgroundColor={alpha(colors.surface, 1)}
			paddingLeft={1}
			paddingRight={1}
			// A click anywhere on a dismissible card dismisses it. The action chip's
			// own handler runs first and OpenTUI mouse events bubble, so clicking the
			// action both fires it and closes the toast — which is what it means.
			onMouseDown={dismissible ? onDismiss : undefined}
			onMouseOver={onPause}
			onMouseOut={onResume}
		>
			<box flexDirection="row" gap={1}>
				{glyph ? (
					<text fg={accent} flexShrink={0}>
						{glyph}
					</text>
				) : null}
				<box flexDirection="column" flexGrow={1}>
					{titleLines.map((line, i) => (
						<text key={`t${i}`} fg={colors.foreground} attributes={TextAttributes.BOLD}>
							{line}
						</text>
					))}
					{descriptionLines.map((line, i) => (
						<text key={`d${i}`} fg={colors.muted}>
							{line}
						</text>
					))}
					{toast.action ? (
						<box flexDirection="row" gap={1} alignItems="center" marginTop={1}>
							{toast.action.key ? <Kbd accent>{toast.action.key}</Kbd> : null}
							<box onMouseDown={onAction}>
								<text fg={accent} attributes={TextAttributes.BOLD}>
									{toast.action.label}
								</text>
							</box>
						</box>
					) : null}
				</box>
				{dismissible ? (
					<box flexShrink={0} onMouseDown={onDismiss}>
						<text fg={colors.muted}>✕</text>
					</box>
				) : null}
			</box>
			{toast.remaining === undefined ? null : (
				<ProgressBar value={toast.remaining} width={inner} variant={toast.variant} />
			)}
		</box>
	);
}

/** Props for {@link ToastViewport}. */
export interface ToastViewportProps {
	/** Which screen anchor this stack hangs from. */
	position: ToastPosition;
	/** The toasts to draw, already ordered for this position. */
	toasts: ToastVisual[];
	/** Cells of clearance from the screen edges. Defaults to 1. */
	margin?: number;
	/** Current spinner glyph for any `loading` toast. */
	spinner?: string;
	/** A card requested dismissal. */
	onDismiss?: (id: string) => void;
	/** A card's action was clicked. */
	onAction?: (id: string) => void;
	/** The pointer entered a card. */
	onPause?: (id: string) => void;
	/** The pointer left a card. */
	onResume?: (id: string) => void;
}

/**
 * One anchored stack of toasts. Absolutely positioned against its parent — mount
 * it at the root of the tree so "parent" means the screen.
 *
 * Centred positions stretch edge to edge (`left` **and** `right` set) and centre
 * their children, since a content-sized box cannot centre itself; the stack is
 * still only as tall as its cards, so it never covers the page.
 */
export function ToastViewport({
	position,
	toasts,
	margin = 0,
	spinner,
	onDismiss,
	onAction,
	onPause,
	onResume,
}: ToastViewportProps) {
	if (toasts.length === 0) return null;

	const [edge, align] = position.split("-") as [
		"top" | "bottom",
		"left" | "center" | "right",
	];

	return (
		<box
			position="absolute"
			zIndex={2000}
			top={edge === "top" ? margin : undefined}
			bottom={edge === "bottom" ? margin : undefined}
			left={align === "right" ? undefined : margin}
			right={align === "left" ? undefined : margin}
			flexDirection="column"
			alignItems={
				align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start"
			}
			gap={1}
		>
			{toasts.map((toast) => (
				<ToastCard
					key={toast.id}
					toast={toast}
					spinner={spinner}
					onDismiss={onDismiss && (() => onDismiss(toast.id))}
					onAction={onAction && (() => onAction(toast.id))}
					onPause={onPause && (() => onPause(toast.id))}
					onResume={onResume && (() => onResume(toast.id))}
				/>
			))}
		</box>
	);
}
