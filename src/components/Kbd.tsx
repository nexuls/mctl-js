/**
 * Kbd — a keycap that renders a single keyboard key as a filled pill.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders styled boxes/text only.
 *
 * A keycap is one terminal row tall (a bordered box would force three rows and
 * break inline hint layouts), so the "cap" look comes from a filled background
 * plus one cell of side padding rather than a border.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";
import { onAccent } from "./support.ts";

/** Props for {@link Kbd}. */
export interface KbdProps {
	/** The key label, e.g. `"q"`, `"Esc"`, `"Ctrl"`, `"↵"`. */
	children: string;
	/**
	 * Render as a solid accent pill instead of the default surface pill. Use for
	 * the primary key in a prompt ("press [Enter]") so it stands out.
	 */
	accent?: boolean;
}

/**
 * A single keycap. Sits inline in a row of {@link "./Hint".Hint} items or beside
 * a label. Height is a single cell so it aligns with surrounding text.
 */
export function Kbd({ children, accent = false }: KbdProps) {
	const { colors } = useTheme();
	return (
		<box
			backgroundColor={accent ? colors.primary : colors.surface}
			paddingLeft={accent ? 1 : 0}
			paddingRight={accent ? 1 : 0}
			height={1}
			flexShrink={0}
		>
			<text
				fg={accent ? onAccent(colors) : colors.primary}
				attributes={TextAttributes.BOLD}
			>
				{children}
			</text>
		</box>
	);
}
