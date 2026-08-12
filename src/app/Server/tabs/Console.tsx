/**
 * Console tab — the server's live output inside the Server page.
 *
 * The pane is {@link ConsoleView}. This is the **only** way into a server's
 * console — there is no `console` route — so the output is always reached
 * through the server that produced it. The tab owns its own scrolling (the
 * command line is pinned under a scrolling pane), which is why the container
 * hosts it without a scrollbox.
 */

import type { ServerTabProps } from "../panels.tsx";
import { memo, useEffect, useState } from "react";
import { AnsiText, Input, ScrollBox } from "../../../components/index.ts";
import { stripAnsi } from "../../../lib/ansi.ts";
import { useConsole } from "../../../hooks/use-console.ts";
import { useCaptureKeys } from "../../../hooks/use-input-capture.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import type { ServerState } from "../../../types/server.ts";

/** Props for {@link ConsoleTab} — the tab props plus the ring hand-off. */
export interface ConsoleTabProps extends ServerTabProps {
	/** Move the page's focus ring to the command line (a click in the pane). */
	onFocused?: () => void;
}

export function ConsoleTab({ server, focused, onFocused }: ConsoleTabProps) {
	return (
		<ConsoleView
			id={server.id}
			state={server.state}
			focused={focused}
			onFocused={onFocused}
		/>
	);
}

/**
 * Colour a console line by what it says.
 *
 * Minecraft's log format is `[HH:MM:SS LEVEL]: message`, so the level is the one
 * reliable signal available without parsing the whole line. Anything MCTL cannot
 * classify (a JVM warning, a stack trace) stays in the default foreground rather
 * than being guessed at.
 *
 * This is only the *default* colour — a line that colours itself (a modded
 * server's log4j console appender emits ANSI) overrides it run by run, so the
 * classification is stripped of escapes first: an escape before the `#` would
 * otherwise defeat the crash-banner test.
 */
export function lineColor(
	line: string,
	colors: { foreground: string; muted: string; warning: string; error: string },
): string {
	const plain = stripAnsi(line);
	if (/\b(ERROR|SEVERE|FATAL)\b/.test(plain)) return colors.error;
	if (/\bWARN(ING)?\b/.test(plain)) return colors.warning;
	if (/^\s*#/.test(plain)) return colors.muted; // JVM crash-report banner lines
	return colors.foreground;
}

/** Props for {@link ConsoleLine}. */
interface ConsoleLineProps {
	/** The raw captured line, escapes and all. */
	line: string;
	/** 1-based position in the buffer, shown in the gutter. */
	number: number;
	/** Width of the number gutter, sized to the widest number in the buffer. */
	gutterWidth: number;
}

/**
 * One row of the console: a right-aligned line number and the line itself.
 *
 * Memoised because it is not one component but up to {@link MAX_LINES} of them:
 * a booting server appends to the buffer several times a second, and without
 * this every existing row would re-classify and re-parse its text on each of
 * those renders.
 */
const ConsoleLine = memo(function ConsoleLine({
	line,
	number,
	gutterWidth,
}: ConsoleLineProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" width="100%">
			<box
				width={gutterWidth}
				flexDirection="row"
				justifyContent="flex-end"
				paddingRight={2}
			>
				<text fg={colors.muted}>{number}</text>
			</box>
			<AnsiText
				text={line}
				fg={lineColor(line, colors)}
				selectable
				selectionBg={colors.secondary}
			/>
		</box>
	);
});

/** Props for {@link ConsoleView}. */
export interface ConsoleViewProps {
	/** Server id whose console to follow. */
	id: string;
	/** Probed run state, used only to label the command line honestly. */
	state?: ServerState;
	/**
	 * Whether the command line has the keyboard. It also gates the input capture,
	 * so an unfocused console leaves the surrounding page's shortcuts alive.
	 */
	focused?: boolean;
	/** Fired on a click in the pane, so a host page can move its ring here. */
	onFocused?: () => void;
	/** Reported so a host page can show the line count in its own chrome. */
	onLineCount?: (count: number) => void;
}

export function ConsoleView({
	id,
	state,
	focused = true,
	onFocused,
	onLineCount,
}: ConsoleViewProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const toast = useToast();
	const { lines, error, send } = useConsole(id);
	const [command, setCommand] = useState("");

	useCaptureKeys(focused);

	const lineCount = lines.length;
	// Reported from an effect, not from the render body: the host stores it in
	// state, and setting a parent's state while rendering a child is exactly the
	// update-during-render React refuses to do quietly.
	useEffect(() => {
		onLineCount?.(lineCount);
	}, [lineCount, onLineCount]);

	const submit = async () => {
		const text = command.trim();
		if (text === "") return;
		setCommand("");
		const failure = await send(text);
		if (failure) toast.error("Command not sent", { description: failure });
	};

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			border={["top"]}
			borderColor={colors.border}
			borderStyle="rounded"
			onMouseDown={onFocused}
		>
			<ScrollBox
				flexGrow={1}
				enableAccel
				paddingX={1}
				stickyScroll
				stickyStart="bottom"
			>
				{error ? (
					<text fg={colors.error}>{error}</text>
				) : lines.length === 0 ? (
					<text fg={colors.muted}>
						No output captured. Start the server to see its console here.
					</text>
				) : (
					lines.map((line, i) => (
						// Index keys are correct here: the buffer is append-and-drop-front,
						// so a line's identity *is* its position in the current window.
						<ConsoleLine
							key={i}
							line={line}
							number={i + 1}
							gutterWidth={lineCount.toString().length + 3}
						/>
					))
				)}
			</ScrollBox>

			<Input
				label="Command"
				hint={
					state === "running"
						? "sent to the server console"
						: "the server is not running"
				}
				value={command}
				onChange={setCommand}
				onSubmit={() => void submit()}
				onFocused={onFocused}
				focused={focused}
				width="100%"
				formFieldProps={{
					border: ["top"],
					borderColor: colors.border,
					titleColor: colors.border,
					prefix: <text fg={colors.primary}>{icons.caret}</text>,
				}}
			/>
		</box>
	);
}
