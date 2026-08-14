/**
 * The Server page's tab model — the one list every part of the page reads.
 *
 * Kept separate from the container so adding a screen is a single row here plus
 * one file under `tabs/` and one `case` in the container's switch (the union
 * makes a missing case a type error, not a blank screen).
 *
 * No I/O, no JSX: this is data.
 */

/** A screen of the Server page. */
export type ServerTabId =
	| "overview"
	| "console"
	| "players"
	| "world"
	| "content"
	| "backups"
	| "performance"
	| "network"
	| "settings";

/** One tab in the bar, left to right. */
export interface ServerTab {
	id: ServerTabId;
	/** Tab bar label — kept short; the bar scrolls rather than wraps. */
	label: string;
	/** One-line description of the screen, shown under the bar. */
	description: string;
}

/**
 * The tabs, in reading order: what the server *is* doing (overview, console,
 * players), then what it *contains* (world, content, backups), then how it is
 * *run* (performance, network, settings).
 */
export const SERVER_TABS: readonly ServerTab[] = [
	{
		id: "overview",
		label: "Overview",
		description: "State, live status and the lifecycle actions.",
	},
	{
		id: "console",
		label: "Console",
		description: "Live server output, and a line to send back.",
	},
	{
		id: "players",
		label: "Players",
		description: "Who is online now, and who the server knows about.",
	},
	{
		id: "world",
		label: "World",
		description: "The world, and every rule server.properties sets.",
	},
	{
		id: "content",
		label: "Content",
		description: "Mods, plugins, datapacks and the resource pack.",
	},
	{
		id: "backups",
		label: "Backups",
		description: "Archives of this server's world and configuration.",
	},
	{
		id: "performance",
		label: "Performance",
		description: "CPU, memory and threads of the server process.",
	},
	{
		id: "network",
		label: "Network",
		description: "How players reach this server.",
	},
	{
		id: "settings",
		label: "Settings",
		description: "What mctl.json records about this server.",
	},
] as const;

/** The default tab a freshly-opened server page shows. */
export const DEFAULT_SERVER_TAB: ServerTabId = "content";

/** Look a tab up by id, falling back to the default. */
export function serverTab(id: string): ServerTab {
	return (
		SERVER_TABS.find((tab) => tab.id === id) ??
		// The list is never empty, but the union cannot express that to TS.
		(SERVER_TABS[0] as ServerTab)
	);
}

/** True when `id` names a real tab. */
export function isServerTabId(id: string): id is ServerTabId {
	return SERVER_TABS.some((tab) => tab.id === id);
}
