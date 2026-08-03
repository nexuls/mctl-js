/**
 * useRouter — the TUI's in-memory router (there is no URL to route on).
 *
 * A {@link RouterProvider} owns the current route, its params, and a back-stack;
 * pages read the active route and call `navigate` / `back` via {@link useRouter}.
 * This is the one place that decides "which screen is showing"; the `Router`
 * shell renders it, and pages navigate between each other through it (e.g. the
 * Dashboard's server table opens a detail page with a `serverId` param).
 *
 * UI-layer hook — React state only, no I/O, no domain knowledge beyond a
 * {@link RouteId}.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RouteId, RouteParams } from "../app/routes.ts";

/** The current location. */
interface Location {
  route: RouteId;
  params: RouteParams;
}

/** The router API exposed to pages and the shell. */
export interface Router {
  /** The active route. */
  route: RouteId;
  /** The active route's params (empty object when none). */
  params: RouteParams;
  /** Go to `route`, pushing the current location onto the back-stack. */
  navigate: (route: RouteId, params?: RouteParams) => void;
  /** Return to the previous location; no-op at the root. */
  back: () => void;
  /** Whether there is somewhere to go `back` to. */
  canBack: boolean;
}

const RouterContext = createContext<Router | undefined>(undefined);

/** Props for {@link RouterProvider}. */
interface RouterProviderProps {
  /** The route to start on. Defaults to `"dashboard"`. */
  initialRoute?: RouteId;
  params?: RouteParams;
  children: ReactNode;
}

/**
 * Provide router state to the tree. Keeps a simple back-stack so `Esc` /
 * back-navigation returns to the previous screen (e.g. from a server's detail
 * page back to the Dashboard) rather than always quitting.
 */
export function RouterProvider({
  initialRoute = "dashboard",
  params = {},
  children,
}: RouterProviderProps) {
  const [location, setLocation] = useState<Location>({
    route: initialRoute,
    params: params,
  });
  const [stack, setStack] = useState<Location[]>([]);

  const navigate = useCallback(
    (route: RouteId, params: RouteParams = {}) => {
      setLocation((current) => {
        // Ignore a navigate to the identical location (same route + same params)
        // so it doesn't pollute the back-stack with duplicates.
        if (
          current.route === route &&
          current.params.serverId === params.serverId
        ) {
          return current;
        }
        setStack((s) => [...s, current]);
        return { route, params };
      });
    },
    [],
  );

  const back = useCallback(() => {
    setStack((s) => {
      if (s.length === 0) return s;
      const previous = s[s.length - 1];
      if (previous) setLocation(previous);
      return s.slice(0, -1);
    });
  }, []);

  const value = useMemo<Router>(
    () => ({
      route: location.route,
      params: location.params,
      navigate,
      back,
      canBack: stack.length > 0,
    }),
    [location, navigate, back, stack.length],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/** Access the router. Throws if used outside a {@link RouterProvider}. */
export function useRouter(): Router {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used within a RouterProvider");
  return ctx;
}
