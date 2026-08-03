/**
 * StepScaffold — the common layout of a wizard step's content column: a bold
 * title, a muted description, the step's fields, then the footer pinned to the
 * bottom.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): pure layout. Each step supplies its
 * own fields (`children`) and its own `footer` (a {@link WizardFooter} wired to
 * that step's focus ring).
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";

/** Props for {@link StepScaffold}. */
export interface StepScaffoldProps {
	/** Step title, drawn bold. */
	title: string;
	/** One-line description under the title, muted. */
	description?: string;
	/** The step's fields. */
	children: React.ReactNode;
	/** The step's footer (navigation bar). */
	footer: React.ReactNode;
}

/** Lay out one wizard step: header, a growing field area, and a bottom footer. */
export function StepScaffold({
	title,
	description,
	children,
	footer,
}: StepScaffoldProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="column" flexGrow={1} gap={1}>
			<box flexDirection="column" flexShrink={0}>
				<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
					{title}
				</text>
				{description ? <text fg={colors.muted}>{description}</text> : null}
			</box>
			<box flexDirection="column" gap={1} flexGrow={1}>
				{children}
			</box>
			{footer}
		</box>
	);
}
