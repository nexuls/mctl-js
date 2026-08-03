/**
 * Console — a live view of one server's output with a command input, the peer of
 * `mctl logs -f` and `mctl exec`.
 *
 * Page-layer (AGENTS.md § 3): all streaming and sending goes through
 * {@link useConsole}, which drives `RuntimeManager`. The page holds no I/O.
 *
 * The view auto-scrolls to the newest line, which is what a console should do —
 * `ScrollBox` is told to jump to the bottom whenever the line count grows, and
 * the wheel is left linear so a manual scroll-back is not thrown around.
 */

import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Hint, Input, ScrollBox } from "../../components/index.ts";
import { useConsole } from "../../hooks/use-console.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import { useRouter } from "../../hooks/use-router.tsx";
import { useServer } from "../../hooks/use-servers.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import { serverStateColor, serverStateIcon } from "../shared.tsx";

/**
 * Colour a console line by what it says.
 *
 * Minecraft's log format is `[HH:MM:SS LEVEL]: message`, so the level is the one
 * reliable signal available without parsing the whole line. Anything MCTL cannot
 * classify (a JVM warning, a stack trace) stays in the default foreground rather
 * than being guessed at.
 */
function lineColor(
	line: string,
	colors: { foreground: string; muted: string; warning: string; error: string },
): string {
	if (/\b(ERROR|SEVERE|FATAL)\b/.test(line)) return colors.error;
	if (/\bWARN(ING)?\b/.test(line)) return colors.warning;
	if (/^\s*#/.test(line)) return colors.muted; // JVM crash-report banner lines
	return colors.foreground;
}

export function Console() {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { params } = useRouter();
	const toast = useToast();
	const id = params.serverId ?? "";
	const { data: server } = useServer(id);
	const { lines, error, send } = useConsole(id);
	const [command, setCommand] = useState("");
	const scroll = useRef<ScrollBoxRenderable | null>(null);

	// The command field always holds the key capture on this page: every keystroke
	// belongs to the server's console, so the shell's digit shortcuts must stand
	// down for as long as the page is open.
	useCaptureKeys(true);

	const lineCount = lines.length;
	// useEffect(() => {
	// 	// `scrollTop` is clamped by the renderable, so an over-large value is the
	// 	// simplest correct way to say "bottom" without knowing the content height.
	// 	if (lineCount > 0 && scroll.current) {
	// 		scroll.current.scrollTop = Number.MAX_SAFE_INTEGER;
	// 	}
	// }, [lineCount]);

	const submit = async () => {
		const text = command.trim();
		if (text === "") return;
		setCommand("");
		const failure = await send(text);
		if (failure) toast.error("Command not sent", { description: failure });
	};

	return (
		<box flexDirection="column" flexGrow={1}>
			<box
				flexDirection="row"
				gap={2}
				alignItems="center"
				marginBottom={1}
				paddingX={1}
			>
				<text fg={colors.primary}>{server?.name ?? id}</text>
				{server ? (
					<text fg={serverStateColor(colors, server.state)}>
						{icons[serverStateIcon(server.state)]} {server.state}
					</text>
				) : null}
				<text fg={colors.muted}>({lines.length} lines)</text>
			</box>

			<box border={["top"]} borderColor={colors.border} borderStyle="rounded">
				<ScrollBox
					ref={scroll}
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
						server?.state === "running"
							? "sent to the server console"
							: "the server is not running"
					}
					value={command}
					onChange={setCommand}
					onSubmit={() => void submit()}
					focused
					width="100%"
					formFieldProps={{
						border: ["top"],
						borderColor: colors.border,
						titleColor: colors.border,
						prefix: <text fg={colors.primary}>{icons.caret}</text>,
					}}
				/>
			</box>

			<Hint
				items={[
					{ keys: "Enter", label: "send" },
					{ keys: "Esc", label: "back" },
				]}
			/>
		</box>
	);
}
