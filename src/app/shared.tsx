/**
 * Small shared page-layer building blocks: a page header, a "coming in Phase N"
 * placeholder, and the server-state → colour mapping. Pure UI (AGENTS.md § 3):
 * they render props and read theme colours; no I/O, no domain state.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";
import type { ThemeColors } from "../types/theme.ts";
import type { ServerState } from "../types/server.ts";
import type { IconName } from "../types/icons.ts";

/** The accent colour a server's run state should read in (badge, dot, label). */
export function serverStateColor(
	colors: ThemeColors,
	state: ServerState,
): string {
	switch (state) {
		case "running":
			return colors.success;
		case "stopped":
			return colors.muted;
		case "unavailable":
			return colors.error;
		default:
			return colors.warning;
	}
}

/**
 * The semantic icon a server's run state reads as. Names, not glyphs — the
 * caller resolves them through `useIcons()`.
 *
 * State is deliberately carried by *both* colour and shape: colour alone fails
 * for colour-blind users and on the handful of themes whose `muted` and
 * `warning` sit close together.
 */
export function serverStateIcon(state: ServerState): IconName {
	switch (state) {
		case "running":
			return "running";
		case "stopped":
			return "stopped";
		case "unavailable":
			return "unavailable";
		default:
			return "unknownState";
	}
}

/** Props for {@link PageHeader}. */
interface PageHeaderProps {
	/** The page title. */
	title: string;
	/** Optional one-line subtitle in the muted colour. */
	subtitle?: string;
}

/** A consistent page title block used at the top of every screen's body. */
export function PageHeader({ title, subtitle }: PageHeaderProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="column" marginBottom={1}>
			<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
				{title}
			</text>
			{subtitle ? <text fg={colors.muted}>{subtitle}</text> : null}
		</box>
	);
}

/** Props for {@link Placeholder}. */
interface PlaceholderProps {
	/** The screen name. */
	title: string;
	/** The roadmap phase this screen arrives in. */
	phase: string;
	/** A short sentence on what will live here. */
	note: string;
}

/**
 * A screen that does not yet exist, shown honestly rather than faked. Used for
 * Jobs/Backups/Network until their phases land — the nav model is complete now,
 * the functionality arrives per roadmap.
 */
export function Placeholder({ title, phase, note }: PlaceholderProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader title={title} />
			<box
				flexGrow={1}
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
				gap={1}
			>
				<text fg={colors.secondary} attributes={TextAttributes.BOLD}>
					{title} arrives in {phase}
				</text>
				<text fg={colors.muted}>{note}</text>
			</box>
		</box>
	);
}
