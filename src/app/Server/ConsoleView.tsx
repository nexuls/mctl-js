/**
 * ConsoleView — the scrolling output pane and command line for one server.
 *
 * The console is reachable **only** through the Server page's Console tab —
 * there is no `console` route any more, so a server's output is always entered
 * through the server it belongs to. This file stays separate from that tab
 * because the tab is the wiring (ring hand-off, props) and this is the view.
 *
 * Page-layer: all streaming and sending goes through {@link useConsole}, which
 * drives `RuntimeManager`. No I/O here.
 *
 * The view sticks to the newest line, which is what a console should do; the
 * wheel is left linear so a manual scroll-back is not thrown around.
 *
 * **Key capture follows `focused`, not mounting.** Every keystroke typed here
 * belongs to the server, so while the command line is live the shell's digit
 * shortcuts must stand down — but inside the Server page the same keys have to
 * reach the tab bar when the ring is elsewhere, so the capture is taken only
 * while this view actually holds it.
 */

import { useEffect, useState } from "react";
import { Input, ScrollBox } from "../../components/index.ts";
import { useConsole } from "../../hooks/use-console.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import type { ServerState } from "../../types/server.ts";

/**
 * Colour a console line by what it says.
 *
 * Minecraft's log format is `[HH:MM:SS LEVEL]: message`, so the level is the one
 * reliable signal available without parsing the whole line. Anything MCTL cannot
 * classify (a JVM warning, a stack trace) stays in the default foreground rather
 * than being guessed at.
 */
export function lineColor(
	line: string,
	colors: { foreground: string; muted: string; warning: string; error: string },
): string {
	if (/\b(ERROR|SEVERE|FATAL)\b/.test(line)) return colors.error;
	if (/\bWARN(ING)?\b/.test(line)) return colors.warning;
	if (/^\s*#/.test(line)) return colors.muted; // JVM crash-report banner lines
	return colors.foreground;
}

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
						<box key={i} flexDirection="row" width="100%">
							<box
								width={lineCount.toString().length + 3}
								flexDirection="row"
								justifyContent="flex-end"
								paddingRight={2}
							>
								<text fg={colors.muted}>{i + 1}</text>
							</box>
							<text
								fg={lineColor(line, colors)}
								selectable
								selectionBg={colors.secondary}
							>
								{line}
							</text>
						</box>
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
