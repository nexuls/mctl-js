/**
 * NavRail — the persistent navigation bar that sits directly under the shell's
 * top border. It renders {@link NAV} as a horizontal row of tabs: the active
 * route is a filled pill, the rest are quiet, and a rule underneath separates
 * the bar from the page body — accented only under the active tab, plain
 * everywhere else. Keyboard digit shortcuts are owned by the
 * {@link "./Router".Router} shell, not here.
 *
 * The rule is a **second row of per-tab segments**, not the container's bottom
 * border: a border is one colour for its whole side, so it cannot mark just the
 * active tab. Each segment is width-locked to its tab by {@link tabWidth} (both
 * the tab and its segment are given that exact width, so the two rows can never
 * drift), and a tail run sized from the terminal width carries the rule out to
 * the right edge.
 *
 * Tabs and rule share one horizontally scrollable viewport so a narrow terminal
 * scrolls the bar instead of wrapping it — and the accent segment scrolls with
 * the tab it belongs to.
 *
 * Page-layer (AGENTS.md § 3): renders props, reports clicks; no I/O.
 */

import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../hooks/use-theme.tsx";
import { useIcons } from "../hooks/use-icons.tsx";
import { alpha, mix } from "../lib/colors.ts";
import { ScrollBox } from "../components/index.ts";
import { onAccent } from "../components/support.ts";
import { NAV, type NavItem, type RouteId } from "./routes.ts";

/** Props for {@link NavRail}. */
interface NavRailProps {
	/** The route currently shown (highlighted). */
	active: RouteId;
	/** Navigate to a route (fired on click). */
	onNavigate: (route: RouteId) => void;
}

/** One cell of padding on each side of a tab's contents. */
const TAB_PADDING_X = 1;
/** One cell between a tab's digit hint and its label. */
const TAB_GAP = 1;

/**
 * The exact cell width of a tab: side padding + digit + gap + label. Both the
 * tab and its underline segment are laid out at this width, which is what keeps
 * the accent under the active tab aligned with the tab itself.
 */
function tabWidth(item: NavItem): number {
	return (
		TAB_PADDING_X * 2 + item.digit.length + TAB_GAP + item.label.length + 1
	);
}

/** Props for {@link NavTab}. */
interface NavTabProps {
	/** The nav entry this tab stands for. */
	item: NavItem;
	/** The colour of the rule segment under this tab. */
	sepColor: string;
	/** Whether this tab's route is the one on screen. */
	active: boolean;
	/** Fired when the tab is clicked. */
	onSelect: () => void;
}

/**
 * One tab in the bar. The active tab is a solid pill in the primary accent with
 * on-accent ink; inactive tabs are muted text that lifts to a faint wash on
 * hover. Hover is local presentation state, so it lives here rather than in the
 * parent (same pattern as {@link "../components/Button".Button}).
 *
 * This is deliberately *not* a `Button`: a Button colours its own label from its
 * variant matrix, and the tab needs two inks in one chip (a dim digit plus the
 * label) with a resting look — muted, not accented — that no button kind has.
 */
function NavTab({ item, sepColor, active, onSelect }: NavTabProps) {
	const { colors } = useTheme();
	const [hovered, setHovered] = useState(false);

	const ink = active
		? onAccent(colors)
		: hovered
			? colors.foreground
			: colors.muted;
	// On the filled pill the digit is blended toward the fill so it reads as a
	// hint rather than a second label; off the pill DIM does the same job.
	const digitInk = active ? mix(onAccent(colors), colors.primary, 0.55) : ink;

	return (
		<>
			<text fg={sepColor}>{"|"}</text>
			<box
				flexDirection="row"
				flexShrink={0}
				width={tabWidth(item) - 1}
				gap={TAB_GAP}
				paddingLeft={TAB_PADDING_X}
				paddingRight={TAB_PADDING_X}
				backgroundColor={
					active
						? colors.primary
						: hovered
							? alpha(colors.foreground, 0.12)
							: undefined
				}
				onMouseDown={onSelect}
				onMouseOver={() => setHovered(true)}
				onMouseOut={() => setHovered(false)}
			>
				<text
					fg={digitInk}
					attributes={active ? undefined : TextAttributes.DIM}
				>
					{item.digit}
				</text>
				<text fg={ink} attributes={active ? TextAttributes.BOLD : undefined}>
					{item.label}
				</text>
			</box>
		</>
	);
}

export function NavRail({ active, onNavigate }: NavRailProps) {
	const { width: viewportWidth } = useTerminalDimensions();
	const { colors } = useTheme();
	// The rule glyphs come from the active icon set: they are box-drawing, which a
	// non-UTF-8 terminal cannot draw, so ASCII substitutes `=`/`-` runs.
	const { icons } = useIcons();
	// The server-scoped routes have no tab of their own, so they light up the
	// Dashboard tab that owns the server table they were opened from. Resolved
	// once and shared by both rows.
	const isActive = (item: NavItem) =>
		item.id === active ||
		(item.id === "dashboard" &&
			(active === "server" || active === "console" || active === "create"));

	const rule = alpha(colors.border, 0.6);

	const BRAND = "MCTL ";
	const RightTextWidth = BRAND.length;

	const consumed =
		1 +
		RightTextWidth +
		NAV.reduce((sum, item) => sum + tabWidth(item), 0) +
		1 +
		2;
	const tailCells = Math.max(0, viewportWidth - consumed);

	return (
		<ScrollBox
			// Two rows: the tabs, and the rule segments beneath them.
			height={2}
			width="100%"
			flexShrink={0}
			viewportOptions={{ flexDirection: "column" }}
			scrollX={true}
			scrollY={false}
			scrollbarOptions={{ visible: false }}
		>
			<box flexDirection="row" flexShrink={0} height={1} paddingX={1}>
				<text flexShrink={0} fg={colors.primary}>{BRAND}</text>
				{NAV.map((item) => (
					<NavTab
						key={item.id}
						item={item}
						active={isActive(item)}
						sepColor={rule}
						onSelect={() => onNavigate(item.id)}
					/>
				))}
			</box>
			<box flexDirection="row" flexShrink={0} height={1}>
				<text fg={rule} attributes={TextAttributes.DIM} flexShrink={0}>
					{icons.ruleLine.repeat(1 + RightTextWidth)}
				</text>
				{NAV.map((item) => {
					const active = isActive(item);
					const width = tabWidth(item) - 1;

					return (
						<>
							<text fg={rule} attributes={TextAttributes.DIM} flexShrink={0}>
								{active ? icons.ruleCapRight : icons.ruleLine}
							</text>
							<text
								key={item.id}
								width={width}
								flexShrink={0}
								fg={isActive(item) ? colors.primary : rule}
								attributes={active ? undefined : TextAttributes.DIM}
							>
								{icons.ruleLine.repeat(width)}
							</text>
							{active && (
								<text fg={rule} attributes={TextAttributes.DIM} flexShrink={0}>
									{icons.ruleCapLeft}
								</text>
							)}
						</>
					);
				})}
				{/* Carry the rule out to the right edge past the last tab. */}
				<box flexGrow={1} flexShrink={1} overflow="hidden">
					<text fg={rule} attributes={TextAttributes.DIM}>
						{icons.ruleLine.repeat(tailCells)}
					</text>
				</box>
			</box>
		</ScrollBox>
	);
}
