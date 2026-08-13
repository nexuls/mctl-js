/**
 * Table — a column-aligned, width-responsive list with a selectable row and an
 * optional panel that expands beneath the selection.
 *
 * **Pure-UI (AGENTS.md § 3):** it renders the rows it is given and reports
 * intent (`onSelect`/`onActivate`) through callbacks. It holds no data, does no
 * I/O, and knows nothing about servers — a page maps its view models into
 * {@link TableColumn.render} and keeps the selection.
 *
 * ## Responsiveness is column *dropping*, not wrapping
 * A terminal cannot reflow a row: a column that does not fit pushes every column
 * after it off the screen or, worse, wraps into a second line and destroys the
 * alignment the table exists for. So the table measures itself and **drops whole
 * columns**, least important first, until the rest fit — then hands the leftover
 * space to the columns that asked for it (`flex`). The result is that the same
 * table reads correctly at 60 cells and at 200, showing progressively more.
 *
 * The layout maths ({@link layoutColumns}) is pure and exported so the drop and
 * distribution rules can be tested without a renderer.
 */

import { TextAttributes, type BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useRef, type ReactNode } from "react";
import { useTheme } from "../hooks/use-theme.tsx";
import { useIcons } from "../hooks/use-icons.tsx";
import { alpha } from "../lib/colors.ts";
import { ScrollBox } from "./ScrollBox.tsx";
import { useBoxWidth } from "./use-box-width.ts";

/** Cells a scrolling table keeps clear on the right for the scrollbar. */
const SCROLLBAR_RESERVE = 1;

/**
 * Cells a row spends on chrome before any cell text: the left and right edges of
 * its rounded border (2) plus its own horizontal padding (2).
 *
 * The header is not inside that border, so it pays for the same cells with
 * padding instead — `ROW_BORDER + ROW_PADDING_X` on the left and the right. Both
 * halves are derived from these constants rather than hand-tuned, because the
 * failure they prevent is a header whose columns sit one cell off its rows,
 * which only shows up once a cell's text is long enough to fill its column.
 */
const ROW_BORDER = 1;
const ROW_PADDING_X = 1;
const ROW_CHROME = (ROW_BORDER + ROW_PADDING_X) * 2;

/** One rendered cell: the text plus how it should be inked. */
export interface TableCell {
	/** The cell's text. Truncated with the icon set's ellipsis when too long. */
	text: string;
	/** Foreground colour; defaults to the table's body colour. */
	fg?: string;
	/** `TextAttributes` bitmask (bold, dim, …). */
	attributes?: number;
}

/** A column definition. `T` is the row type the page renders. */
export interface TableColumn<T> {
	/** Stable identifier, used as the React key and by {@link layoutColumns}. */
	id: string;
	/** Header label. Also the column's floor width when no `min` is given. */
	header: string;
	/** Fixed width in cells. Mutually exclusive with `flex`. */
	width?: number;
	/** Smallest acceptable width for a flexible column. */
	min?: number;
	/**
	 * Largest width a flexible column will grow to. Without it, one flexible
	 * column absorbs every spare cell on a wide terminal and reads as a gulf of
	 * padding; capping it hands the rest to whichever column can still use it.
	 */
	max?: number;
	/**
	 * Share of the leftover width this column absorbs, relative to the other
	 * flexible columns. Omit for a column that should stay at its natural width.
	 */
	flex?: number;
	/**
	 * How valuable this column is when space runs out. **Lower values are dropped
	 * first**; equal priorities drop right-to-left. Defaults to 0.
	 */
	priority?: number;
	/** Never dropped, however narrow the terminal gets. */
	required?: boolean;
	/** Text alignment within the column. Defaults to `"left"`. */
	align?: "left" | "right";
	/** Produce the cell for one row. A bare string is shorthand for `{ text }`. */
	render: (row: T) => TableCell | string;
}

/** A column that survived layout, with its resolved width. */
export interface ResolvedColumn<T> {
	/** The original definition. */
	column: TableColumn<T>;
	/** Width in cells this column will be padded/truncated to. */
	width: number;
}

/**
 * Choose which columns fit in `available` cells and how wide each one is.
 *
 * Three passes, in order:
 *  1. **Natural widths** — `width`, else `min`, else the header's length.
 *  2. **Drop** the lowest-priority columns (rightmost first among equals) until
 *     the remainder fits. `required` columns are never dropped.
 *  3. **Distribute** any leftover across the `flex` columns, proportionally.
 *
 * When even the required columns overflow (a very narrow terminal), the widest
 * columns are shaved one cell at a time so the row still ends where the viewport
 * does rather than spilling past it.
 *
 * Pure — no React, no theme. Exported for tests.
 *
 * @param gap cells rendered between adjacent columns.
 */
export function layoutColumns<T>(
	columns: TableColumn<T>[],
	available: number,
	gap = 1,
): ResolvedColumn<T>[] {
	if (columns.length === 0 || available <= 0) return [];

	const natural = (c: TableColumn<T>) => c.width ?? c.min ?? c.header.length;
	const kept = [...columns];
	const totalFor = (list: TableColumn<T>[]) =>
		list.reduce((sum, c) => sum + natural(c), 0) +
		gap * Math.max(0, list.length - 1);

	// Pass 2 — drop, least important first. Scanning right-to-left on equal
	// priority means a table listing "id, kind, mc, players" sheds "players"
	// before "kind": later columns are conventionally the less essential ones.
	while (totalFor(kept) > available && kept.length > 1) {
		let victim = -1;
		let worst = Number.POSITIVE_INFINITY;
		for (let i = 0; i < kept.length; i += 1) {
			const c = kept[i] as TableColumn<T>;
			if (c.required) continue;
			const priority = c.priority ?? 0;
			if (priority <= worst) {
				worst = priority;
				victim = i;
			}
		}
		if (victim === -1) break; // Everything left is required.
		kept.splice(victim, 1);
	}

	// Last resort: even at one cell each, the survivors plus their gaps can still
	// overflow a very narrow terminal — three required columns need five cells
	// before any content. Shed from the right (the least significant end) until
	// the minimum footprint fits, `required` included, because a row that spills
	// past the viewport is worse than a missing column.
	while (kept.length > 1 && kept.length + gap * (kept.length - 1) > available) {
		kept.pop();
	}

	const widths = new Map<string, number>(kept.map((c) => [c.id, natural(c)]));
	let used = totalFor(kept);

	// Pass 3 — distribute the leftover across the flexible columns, by weight.
	//
	// Iterative, because a column that hits its `max` must hand its unused share
	// back to the others rather than leaving a hole at the right edge. Each round
	// splits the current spare among the columns still below their cap; a round
	// that hands out nothing ends it (every remaining column is capped, or the
	// spare is smaller than the number of claimants).
	const flexOf = (c: TableColumn<T>) => c.flex ?? 0;
	for (;;) {
		const spare = available - used;
		if (spare <= 0) break;
		const claimants = kept.filter(
			(c) => flexOf(c) > 0 && (widths.get(c.id) ?? 0) < (c.max ?? Infinity),
		);
		if (claimants.length === 0) break;

		const totalFlex = claimants.reduce((sum, c) => sum + flexOf(c), 0);
		let handed = 0;
		claimants.forEach((c, index) => {
			// The last claimant takes the rounding remainder, so a full round always
			// consumes the whole spare — a one-cell gap at the right edge is visible.
			const wanted =
				index === claimants.length - 1
					? spare - handed
					: Math.floor((spare * flexOf(c)) / totalFlex);
			const current = widths.get(c.id) ?? 0;
			const room = (c.max ?? Infinity) - current;
			const share = Math.max(0, Math.min(wanted, room));
			widths.set(c.id, current + share);
			handed += share;
		});
		if (handed === 0) break;
		used += handed;
	}

	// Everything left is required and still too wide: shave the widest column
	// repeatedly. Guaranteed to terminate — every pass removes one cell, and no
	// column shrinks below 1.
	while (used > available) {
		let widest: TableColumn<T> | undefined;
		for (const c of kept) {
			const w = widths.get(c.id) ?? 0;
			if (w > 1 && (!widest || w > (widths.get(widest.id) ?? 0))) widest = c;
		}
		if (!widest) break;
		widths.set(widest.id, (widths.get(widest.id) ?? 1) - 1);
		used -= 1;
	}

	return kept.map((column) => ({
		column,
		width: Math.max(1, widths.get(column.id) ?? 1),
	}));
}

/**
 * Pad or truncate `text` to exactly `width` cells.
 *
 * @param ellipsis the icon set's truncation marker. **Its own length** is
 *   subtracted, not a literal 1 — the ASCII set spells it `"..."`, and assuming
 *   one cell would push the column past `width` and break the alignment this
 *   whole component exists to provide.
 */
export function fitCell(
	text: string,
	width: number,
	ellipsis: string,
	align: "left" | "right" = "left",
): string {
	if (text.length > width) {
		return `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`.slice(
			0,
			width,
		);
	}
	return align === "right" ? text.padStart(width) : text.padEnd(width);
}

/** Props for {@link Table}. */
export interface TableProps<T> {
	/** Column definitions, left to right. */
	columns: TableColumn<T>[];
	/** The rows to render. */
	rows: T[];
	/** Stable key for a row — the React key and the selection identity. */
	keyOf: (row: T) => string;
	/** Key of the currently selected row, if any. */
	selectedKey?: string;
	/** A click on an unselected row, or a programmatic selection change. */
	onSelect?: (row: T, index: number) => void;
	/**
	 * A click on the **already selected** row. Pairing "click the selection" with
	 * "activate" is what makes the pointer agree with the keyboard, where Enter
	 * acts on the row the caret is already on.
	 */
	onActivate?: (row: T, index: number) => void;
	/** Extra content rendered directly beneath the selected row. */
	renderExpanded?: (row: T, width: number) => ReactNode;
	/** Cells between columns. Defaults to 1. */
	gap?: number;
	/** Hide the header row. */
	hideHeader?: boolean;
	/** Rendered in place of the rows when `rows` is empty. */
	empty?: ReactNode;
	/**
	 * Scroll the rows inside the table, keeping the header pinned above them.
	 *
	 * Only for a page that owns its own scrolling (`OWN_SCROLL` in `Router.tsx`):
	 * the inner scrollbox needs a parent with a **definite height** to resolve
	 * against, which the shell's own scrollbox cannot give it.
	 */
	scrollRows?: boolean;
	/**
	 * Override the measured width. The table normally measures itself and falls
	 * back to the terminal width before its first layout.
	 */
	width?: number;
}

/**
 * A column-aligned table that adapts its column set to the space it is given.
 *
 * The table sizes itself from its own laid-out box, so it fills whatever
 * container it is placed in; the terminal width is only the fallback for the
 * first frame, before yoga has run.
 */
export function Table<T>({
	columns,
	rows,
	keyOf,
	selectedKey,
	onSelect,
	onActivate,
	renderExpanded,
	gap = 1,
	hideHeader = false,
	empty,
	scrollRows = false,
	width,
}: TableProps<T>) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const ref = useRef<BoxRenderable | null>(null);
	const measured = useBoxWidth(ref);
	const { width: terminalWidth } = useTerminalDimensions();

	// The ref is attached on every render path (there is only one), so the
	// measurement can never be gated behind the branch it decides — the trap that
	// once froze `Select` into a dropdown forever.
	const outer = (width ?? (measured || terminalWidth)) - ROW_CHROME;
	// A scrollbox draws its scrollbar *inside* its own width, so the rows would
	// be one cell narrower than the header — and only once the list grew past the
	// viewport, which is a misalignment that appears out of nowhere. The cell is
	// reserved unconditionally (and matched by the header's right padding) so the
	// columns stay put whether the scrollbar is showing or not.
	const available = outer - (scrollRows ? SCROLLBAR_RESERVE : 0);
	const resolved = layoutColumns(columns, available, gap);

	const body = (
		<>
			{rows.map((row, index) => {
				const key = keyOf(row);
				const selected = key === selectedKey;
				return (
					<box
						key={key}
						flexDirection="column"
						flexShrink={0}
						border
						borderColor={selected ? colors.primary : colors.border}
						borderStyle={"rounded"}
					>
						<box
							flexDirection="row"
							gap={gap}
							paddingX={1}
							backgroundColor={
								selected ? alpha(colors.primary, 0.18) : undefined
							}
							onMouseDown={() =>
								selected ? onActivate?.(row, index) : onSelect?.(row, index)
							}
						>
							{resolved.map(({ column, width: cellWidth }) => {
								const produced = column.render(row);
								const cell: TableCell =
									typeof produced === "string" ? { text: produced } : produced;
								return (
									<text
										key={column.id}
										fg={cell.fg ?? colors.foreground}
										attributes={cell.attributes}
									>
										{fitCell(
											cell.text,
											cellWidth,
											icons.ellipsis,
											column.align,
										)}
									</text>
								);
							})}
						</box>
						{selected && renderExpanded ? renderExpanded(row, available) : null}
					</box>
				);
			})}
		</>
	);

	return (
		<box ref={ref} flexDirection="column" flexGrow={1}>
			{hideHeader ? null : (
				<box
					flexDirection="row"
					gap={gap}
					border={rows.length === 0 ? ["bottom"] : undefined}
					borderColor={rows.length === 0 ? colors.border : undefined}
					flexShrink={0}
					// Stand in for the row's border + padding so a header cell starts
					// on the same column as the cell below it, and reserve the
					// scrollbar cell on top of that (the rows lose it inside their own
					// box, the header has to be told).
					paddingLeft={ROW_BORDER + ROW_PADDING_X}
					paddingRight={
						ROW_BORDER + ROW_PADDING_X + (scrollRows ? SCROLLBAR_RESERVE : 0)
					}
				>
					{resolved.map(({ column, width: cellWidth }) => (
						<text
							key={column.id}
							fg={colors.primary}
							attributes={TextAttributes.BOLD}
						>
							{fitCell(
								column.header.toUpperCase(),
								cellWidth,
								icons.ellipsis,
								column.align,
							)}
						</text>
					))}
				</box>
			)}

			{rows.length === 0 ? (
				(empty ?? null)
			) : scrollRows ? (
				<ScrollBox flexGrow={1} flexShrink={1}>
					{body}
				</ScrollBox>
			) : (
				<box flexDirection="column">{body}</box>
			)}
		</box>
	);
}
