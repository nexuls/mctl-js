/**
 * Route definitions for the TUI — the set of screens the router can show and the
 * navigation rail's ordering. Pure data + types, no JSX and no I/O.
 *
 * `server` and `create` are intentionally **not** in {@link NAV}: they are
 * reached from the Dashboard's server table and `server` needs a `serverId`
 * param, so a bare digit shortcut could not address it.
 *
 * There is no `console` route. A server's console is one of the Server page's
 * tabs, so it is only ever reached through that server — a full-screen console
 * addressed on its own duplicated the tab and gave the same output two homes.
 */

/** Every screen the router can render. */
export type RouteId =
	| "dashboard"
	| "server"
	| "create"
	| "jobs"
	| "backups"
	| "network"
	| "settings";

/** Parameters a route may carry. */
export interface RouteParams {
	/** The server to show, for the `server` route. */
	serverId?: string;
}

/** One entry in the navigation rail. */
export interface NavItem {
	id: RouteId;
	/** Rail label. */
	label: string;
	/** Digit shortcut that jumps to this route from anywhere. */
	digit: string;
}

/**
 * The navigation rail, left to right. Digits `1..5` are the keyboard shortcuts.
 * Jobs/Backups/Network are placeholder screens until their phases land, but they
 * appear now so the shell is complete and the nav model is real, not retrofitted.
 *
 * There is no separate Servers screen: the server table lives on the Dashboard,
 * which is both the summary and the fleet list.
 */
export const NAV: NavItem[] = [
	{ id: "dashboard", label: "Dashboard", digit: "1" },
	{ id: "jobs", label: "Jobs", digit: "2" },
	{ id: "backups", label: "Backups", digit: "3" },
	{ id: "network", label: "Network", digit: "4" },
	{ id: "settings", label: "Settings", digit: "5" },
];
