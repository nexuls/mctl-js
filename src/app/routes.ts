/**
 * Route definitions for the TUI — the set of screens the router can show and the
 * navigation rail's ordering. Pure data + types, no JSX and no I/O.
 *
 * The `server` (detail) route is intentionally **not** in {@link NAV}: it is
 * reached by selecting a row on the Servers page (it needs a `serverId` param),
 * not from the persistent rail.
 */

/** Every screen the router can render. */
export type RouteId =
  | "dashboard"
  | "servers"
  | "server"
  | "jobs"
  | "backups"
  | "network"
  | "settings";

/** Parameters a route may carry (only the server detail page needs one today). */
export interface RouteParams {
  /** The server whose detail page to show, for the `server` route. */
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
 * The navigation rail, top to bottom. Digits `1..6` are the keyboard shortcuts.
 * Jobs/Backups/Network are placeholder screens until their phases land, but they
 * appear now so the shell is complete and the nav model is real, not retrofitted.
 */
export const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", digit: "1" },
  { id: "servers", label: "Servers", digit: "2" },
  { id: "jobs", label: "Jobs", digit: "3" },
  { id: "backups", label: "Backups", digit: "4" },
  { id: "network", label: "Network", digit: "5" },
  { id: "settings", label: "Settings", digit: "6" },
];
