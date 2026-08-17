/**
 * The Server page's shared presentation vocabulary: a titled {@link Panel}, a
 * `label: value` {@link Detail} row, a {@link Meter} for numbers that only mean
 * something against a ceiling, and the small formatters the tabs share.
 *
 * Pure UI (AGENTS.md § 3): everything here renders props and theme colours. It
 * lives beside the tabs rather than in `components/` because the label column
 * width and the panel chrome are this page's layout, not the app's kit — a
 * second page wanting them is the signal to promote them, not this one.
 */

import type { ReactNode } from "react";
import type { FocusRing } from "../../hooks/use-focus-ring.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { ProgressBar } from "../../components/index.ts";
import type { Server } from "../../types/server.ts";
import type { ServerInsight, ServerSize } from "../../core/server/inspect.ts";

/**
 * Label column width inside a panel, so every row's values line up — across
 * panels *and* across tabs, which is why it is one exported constant rather
 * than a per-panel choice.
 */
export const LABEL_WIDTH = 13;

/** Terminal width at or above which a tab lays its panels out in two columns. */
export const TWO_COLUMN_WIDTH = 96;

/** What every tab body is handed by the {@link "./index".ServerDetail} container. */
export interface ServerTabProps {
	/** The server view model, re-derived from disk by `useServer`. */
	server: Server;
	/** The cheap-tier inspection, once the first poll resolves. */
	insight?: ServerInsight;
	/** The expensive-tier directory walk, once it resolves. */
	size?: ServerSize;
	/** True while this tab holds the page's focus ring. */
	focused?: boolean;
	/**
	 * Reports that this tab has opened (or closed) a modal of its own.
	 *
	 * The container's focus ring must stand down while a modal is up, or one Tab
	 * moves the page's focus *behind* the dialog — and only the tab knows its own
	 * modal state. See `useFocusRing`'s "only one ring listens at a time".
	 */
	onModal?: (open: boolean) => void;
	/**
	 * The container's focus ring, for a tab whose body is a form.
	 *
	 * A tab with several controls cannot open a ring of its own — only one ring
	 * may listen at a time, so a second would move the page's focus behind the
	 * tab's. Instead the tab exports its ids (`serverSettingsRingIds`), the
	 * container splices them into *its* ring while that tab is active, and hands
	 * the ring back down here.
	 */
	focus?: FocusRing;
	/**
	 * Reports the state of a tab's form, so the container can build the ring
	 * members for it: which are disabled (Save/Revert follow `dirty`) and which
	 * exist at all (a field behind a toggle). Both facts live in the tab, and a
	 * ring member whose `disabled` disagrees with its control — or that names a
	 * control not on screen — is the defect `useFocusRing` guards against.
	 */
	onFormState?: (state: ServerSettingsFormState) => void;
	/** Ask the container to re-read the server after this tab wrote to it. */
	onRefresh?: () => void;
}

/** The state of a tab's form, reported up so the container can size its ring. */
export interface ServerSettingsFormState {
	/** Whether the tab's buffer differs from disk. */
	dirty: boolean;
	/** Whether the pinned-Java field is currently on screen. */
	javaPinned: boolean;
}

/** A `label: value` detail row. */
export function Detail({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color?: string;
}) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.muted}>{label.padEnd(LABEL_WIDTH)}</text>
			<text fg={color ?? colors.foreground}>{value}</text>
		</box>
	);
}

/** A bordered, titled section of a tab. */
export function Panel({
	title,
	accent,
	children,
}: {
	title: string;
	accent?: string;
	children: ReactNode;
}) {
	const { colors } = useTheme();
	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={colors.border}
			title={` ${title} `}
			titleColor={accent ?? colors.secondary}
			paddingX={1}
			marginBottom={1}
			flexGrow={1}
		>
			{children}
		</box>
	);
}

/**
 * A metered row: a label, a bar, and a readout. Used where a number only means
 * something against a ceiling — players against slots, memory against the heap
 * the JVM was given.
 */
export function Meter({
	label,
	value,
	max,
	readout,
	variant,
}: {
	label: string;
	value: number;
	max: number;
	readout: string;
	variant: "primary" | "success" | "info" | "warning";
}) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1} alignItems="center">
			<text fg={colors.muted}>{label.padEnd(LABEL_WIDTH)}</text>
			<ProgressBar
				value={max > 0 ? Math.min(value, max) : 0}
				max={max > 0 ? max : 1}
				width={18}
				style="smooth"
				variant={variant}
				readout="none"
			/>
			<text fg={colors.foreground}>{readout}</text>
		</box>
	);
}

/**
 * A short line explaining why a tab has nothing to show — a stopped server, a
 * subsystem that has not landed yet. Said out loud rather than left as an empty
 * panel: a mysterious gap reads as a bug.
 */
export function EmptyNote({ children }: { children: ReactNode }) {
	const { colors } = useTheme();
	return <text fg={colors.muted}>{children}</text>;
}

/** Human-readable Java field: a resolved major, or an explicit pin. */
export function javaLabel(server: Server, empty: string): string {
	if (server.java === undefined) return empty;
	return typeof server.java === "number"
		? String(server.java)
		: `${server.java.pinned} (pinned)`;
}

/**
 * Lay a tab's panels out in two columns when the terminal can carry them and one
 * when it cannot. Every tab that has more than one panel uses this, so the whole
 * page reflows at the same width rather than tab by tab.
 */
export function Columns({
	wide,
	left,
	right,
	paddingX = 1,
}: {
	wide: boolean;
	left: ReactNode;
	right: ReactNode;
	paddingX?: number;
}) {
	if (!wide) {
		return (
			<box flexDirection="column" flexGrow={1} paddingX={paddingX}>
				{left}
				{right}
			</box>
		);
	}
	return (
		<box
			flexDirection="row"
			gap={1}
			alignItems="flex-start"
			paddingX={paddingX}
		>
			<box flexDirection="column" flexGrow={1} flexBasis={0}>
				{left}
			</box>
			<box flexDirection="column" flexGrow={1} flexBasis={0}>
				{right}
			</box>
		</box>
	);
}
