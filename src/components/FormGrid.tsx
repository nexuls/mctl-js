/**
 * FormGrid — a responsive column layout for form fields.
 *
 * **Pure-UI** (AGENTS.md § 3): it measures its own laid-out width and lays its
 * children out in as many columns as fit. No I/O, no domain knowledge.
 *
 * Forms here were one field per row at every width, which reads fine at 60
 * columns and wastes two thirds of a 140-column terminal — the create form ran
 * off the bottom of the screen while the right half of it was empty. A terminal
 * has no media queries and OpenTUI's `width` vocabulary (`number | "<n>%" |
 * "auto"`) never hands a component a real number, so the column count has to be
 * derived from a *measured* width (see {@link useBoxWidth}) rather than declared.
 *
 * Children are laid out **row-major, in declaration order**, which is what keeps
 * a page's Tab ring (declared in the same order) matching what the eye sees.
 * Wrap a child in {@link FormGridItem} to give it more than one column — a
 * read-only path row or a preview strip usually wants `span="full"`.
 *
 * ```tsx
 * <FormGrid minColumnWidth={46}>
 *   <Input label="Name" … />
 *   <Select label="Kind" … />
 *   <FormGridItem span="full"><Checkbox … /></FormGridItem>
 * </FormGrid>
 * ```
 */

import type { BoxRenderable } from "@opentui/core";
import { Children, isValidElement, useRef } from "react";
import { clamp } from "./support.ts";
import { useBoxWidth } from "./use-box-width.ts";

/**
 * Narrowest a column may become before the grid drops to fewer of them. A form
 * field below roughly this width cannot hold its label on the top border and its
 * hint on the bottom one without both being truncated.
 */
const DEFAULT_MIN_COLUMN_WIDTH = 46;

/** Props for {@link FormGridItem}. */
export interface FormGridItemProps {
	/**
	 * How many columns this item occupies. `"full"` means the whole row whatever
	 * the current column count is. Clamped to the columns available.
	 */
	span?: number | "full";
	children: React.ReactNode;
}

/**
 * Marks a child of {@link FormGrid} as spanning more than one column.
 *
 * It renders nothing itself — the grid reads its `span` and renders its
 * `children` into the cell — so it never adds a box to the tree.
 */
export function FormGridItem({ children }: FormGridItemProps) {
	return <>{children}</>;
}

/** Props for {@link FormGrid}. */
export interface FormGridProps {
	/** Narrowest a column may be, in cells. Defaults to 46. */
	minColumnWidth?: number;
	/**
	 * Ceiling on the column count. Two is the default because a form is read as
	 * pairs; three only pays off on genuinely wide terminals and is opt-in.
	 */
	maxColumns?: number;
	/** Cells between columns. Defaults to 2. */
	gap?: number;
	/** Blank rows between grid rows. Defaults to 1, matching `FormGroup`. */
	rowGap?: number;
	children: React.ReactNode;
}

/**
 * How many columns fit in `width`, given the narrowest a column may be and the
 * gap between them.
 *
 * Pure and exported for testing. An unmeasured width (0, before the first
 * layout) yields one column, so the first frame is the narrow layout and widens
 * once yoga has run — the safe direction, since a too-wide guess would truncate
 * every field for a frame.
 */
export function columnsFor(
	width: number,
	minColumnWidth: number,
	maxColumns: number,
	gap: number,
): number {
	if (width <= 0 || minColumnWidth <= 0) return 1;
	// n columns need n minimums plus the (n-1) gaps between them.
	const fits = Math.floor((width + gap) / (minColumnWidth + gap));
	return clamp(fits, 1, Math.max(1, maxColumns));
}

/**
 * Pack items of the given spans into rows of `columns` columns.
 *
 * Greedy and order-preserving: an item that does not fit in what is left of the
 * current row starts a new one, and never jumps ahead of an item declared before
 * it. That is what keeps the visual order identical to the declaration order,
 * and therefore to the page's focus ring.
 *
 * @returns one array of item indices per row.
 */
export function packRows(spans: number[], columns: number): number[][] {
	const rows: number[][] = [];
	let row: number[] = [];
	let used = 0;
	for (const [index, rawSpan] of spans.entries()) {
		const span = clamp(rawSpan, 1, columns);
		if (used + span > columns && row.length > 0) {
			rows.push(row);
			row = [];
			used = 0;
		}
		row.push(index);
		used += span;
	}
	if (row.length > 0) rows.push(row);
	return rows;
}

/** Resolve one child's span, honouring a {@link FormGridItem} wrapper. */
function spanOf(child: React.ReactNode, columns: number): number {
	if (!isValidElement(child) || child.type !== FormGridItem) return 1;
	const { span } = child.props as FormGridItemProps;
	if (span === "full") return columns;
	return clamp(span ?? 1, 1, columns);
}

/**
 * Lay children out in as many columns as the measured width allows.
 */
export function FormGrid({
	minColumnWidth = DEFAULT_MIN_COLUMN_WIDTH,
	maxColumns = 2,
	gap = 2,
	rowGap = 1,
	children,
}: FormGridProps) {
	// The ref is attached to the one box this component always renders — a ref on
	// a conditional branch would never be measured (see `useBoxWidth`).
	const ref = useRef<BoxRenderable | null>(null);
	const measured = useBoxWidth(ref);

	const items = Children.toArray(children).filter(Boolean);
	const columns = columnsFor(measured, minColumnWidth, maxColumns, gap);
	const spans = items.map((child) => spanOf(child, columns));
	const rows = packRows(spans, columns);

	return (
		<box ref={ref} flexDirection="column" gap={rowGap} flexShrink={0}>
			{rows.map((row) => {
				const filled = row.reduce((sum, index) => sum + (spans[index] ?? 1), 0);
				return (
					<box
						// Rows are stable in order and the children they hold are keyed by
						// the first item's key, which is stable across a reflow.
						key={`row-${row[0]}`}
						flexDirection="row"
						gap={gap}
						flexShrink={0}
						alignItems="stretch"
					>
						{row.map((index) => (
							<box
								key={index}
								// `flexBasis={0}` with a proportional `flexGrow` is what makes
								// every column an equal share of the row regardless of what is
								// in it; sizing to content would let a long hint widen its
								// column and stagger the fields beneath it.
								flexBasis={0}
								flexGrow={spans[index]}
								flexDirection="column"
							>
								{items[index]}
							</box>
						))}
						{/* A short last row keeps its columns their normal width rather than
						    stretching one field across the page. */}
						{filled < columns ? (
							<box flexBasis={0} flexGrow={columns - filled} />
						) : null}
					</box>
				);
			})}
		</box>
	);
}
