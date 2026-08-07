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
import { ConsoleView } from "../ConsoleView.tsx";

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
