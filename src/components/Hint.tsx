/**
 * Hint — a row of keyboard shortcut hints, the "press [q] to quit" affordance
 * used along the bottom of pages and dialogs.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders {@link Kbd} caps + text only.
 */

import { useTheme } from "../hooks/use-theme.tsx";
import { useIcons } from "../hooks/use-icons.tsx";
import { Kbd } from "./Kbd.tsx";

/** One shortcut: the key(s) that trigger it and what it does. */
export interface HintItem {
	/**
	 * The key(s) for this action. Multiple keys render as separate caps (e.g.
	 * `["Ctrl", "C"]` → two caps), reading as a chord.
	 */
	keys: string | string[];
	/** What pressing the key does, e.g. `"quit"`, `"cycle theme"`. */
	label: string;
}

/** Props for {@link Hint}. */
export interface HintProps {
	/** The shortcuts to show, left to right. */
	items: HintItem[];
	/** Gap in cells between each hint group. Defaults to 2. */
	gap?: number;
}

/**
 * A horizontal strip of `[key] label` hints. Wraps on narrow terminals so no
 * hint is clipped. Keys use {@link Kbd}; labels are muted so the caps lead the
 * eye.
 */
export function Hint({ items, gap = 1 }: HintProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	return (
		<box flexDirection="row" flexWrap="wrap" columnGap={gap} alignItems="center">
			{items.map((item, i) => {
				const keys = Array.isArray(item.keys) ? item.keys : [item.keys];
				return (
					<>
						<box
							// Index key: hint lists are static per render and never reordered.
							key={`${item.label}-${i}`}
							flexDirection="row"
							gap={1}
							alignItems="center"
							flexShrink={0}
						>
							{keys.map((k, ki) => (
								<Kbd key={ki}>{k}</Kbd>
							))}
							<text fg={colors.muted}>{item.label}</text>
						</box>
						{i === items.length - 1 ? null : (
							<text fg={colors.muted}>{icons.separator}</text>
						)}
					</>
				);
			})}
		</box>
	);
}
