/**
 * Console — the full-screen view of one server's output, the peer of
 * `mctl logs -f` and `mctl exec`.
 *
 * The pane itself is {@link ConsoleView}, shared with the Server page's Console
 * tab; this page is the route wrapper that gives it the whole screen and a
 * header. Page-layer (AGENTS.md § 3): no I/O of its own.
 */

import { useState } from "react";
import { useHints } from "../../hooks/use-hints.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import { useRouter } from "../../hooks/use-router.tsx";
import { useServer } from "../../hooks/use-servers.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { serverStateColor, serverStateIcon } from "../shared.tsx";
import { ConsoleView } from "./ConsoleView.tsx";

export function Console() {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { params } = useRouter();
	const id = params.serverId ?? "";
	const { data: server } = useServer(id);
	const [lineCount, setLineCount] = useState(0);

	// The command line owns the keyboard on this page, so the only page-specific
	// key is Enter; the shell's strip supplies Esc and stands its own character
	// shortcuts down while the field is capturing.
	useHints([{ keys: "Enter", label: "send command" }], { scope: "context" });

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
				<text fg={colors.muted}>({lineCount} lines)</text>
			</box>

			<ConsoleView
				id={id}
				state={server?.state}
				focused
				onLineCount={setLineCount}
			/>
		</box>
	);
}

export { ConsoleView } from "./ConsoleView.tsx";
