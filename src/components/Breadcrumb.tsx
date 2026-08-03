/**
 * Breadcrumb — the navigation trail showing where the user is in the page
 * hierarchy (e.g. `Servers › survival › Console`).
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders text and reports clicks via
 * each crumb's `onClick`. It performs no navigation itself — the Router (wired
 * through the page) does.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";

/** One segment of the trail. */
export interface Crumb {
	/** The segment text. */
	label: string;
	/**
	 * Invoked when this crumb is clicked. Omit for a non-navigable crumb (the
	 * current page's own last crumb is typically inert).
	 */
	onClick?: () => void;
}

/** Props for {@link Breadcrumb}. */
export interface BreadcrumbProps {
	/** Segments from root (first) to current (last). */
	items: Crumb[];
	/** Separator glyph between crumbs. Defaults to `"›"`. */
	separator?: string;
}

/**
 * A single-line breadcrumb trail. Ancestor crumbs are muted and clickable; the
 * final crumb is drawn in the accent colour and bold to mark the current
 * location. Separators are always muted.
 */
export function Breadcrumb({ items, separator = "›" }: BreadcrumbProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
			{items.map((crumb, i) => {
				const isLast = i === items.length - 1;
				return (
					<box
						key={i}
						flexDirection="row"
						gap={1}
						alignItems="center"
						flexShrink={0}
					>
						<box onMouseDown={crumb.onClick} flexShrink={0}>
							<text
								fg={isLast ? colors.primary : colors.muted}
								attributes={isLast ? TextAttributes.BOLD : undefined}
							>
								{crumb.label}
							</text>
						</box>
						{isLast ? null : <text fg={colors.muted}>{separator}</text>}
					</box>
				);
			})}
		</box>
	);
}
