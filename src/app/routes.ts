/**
 * Route definitions for the TUI — the set of screens the router can show and the
 * navigation rail's ordering. Pure data + types, no JSX and no I/O.
 *
 * `server`, `console`, and `create` are intentionally **not** in {@link NAV}:
 * they are reached from the Dashboard's server table and two of them need a
 * `serverId` param, so a bare digit shortcut could not address them.
 */

/** Every screen the router can render. */
export type RouteId =
  | "dashboard"
  | "server"
  | "console"
  | "create"
  | "jobs"
  | "backups"
  | "network"
  | "settings";

/** Parameters a route may carry. */
export interface RouteParams {
  /** The server to show, for the `server` and `console` routes. */
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
