/**
 * NavRail — the persistent left navigation. Renders {@link NAV} with each item's
 * digit shortcut, highlights the active route, and navigates on click. Keyboard
 * digit shortcuts are owned by the {@link "./Router".Router} shell, not here.
 *
 * Page-layer (AGENTS.md § 3): renders props, reports clicks; no I/O.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";
import { NAV, type RouteId } from "./routes.ts";

/** Props for {@link NavRail}. */
interface NavRailProps {
  /** The route currently shown (highlighted). */
  active: RouteId;
  /** Navigate to a route (fired on click). */
  onNavigate: (route: RouteId) => void;
}

export function NavRail({ active, onNavigate }: NavRailProps) {
  const { colors } = useTheme();
  return (
    <box
      flexDirection="column"
      width={18}
      flexShrink={0}
      border={["right"]}
      borderColor={colors.border}
      paddingRight={1}
      paddingTop={1}
    >
      {NAV.map((item) => {
        // The server-detail route has no rail entry, so it highlights its parent.
        const isActive = item.id === active || (active === "server" && item.id === "servers");
        return (
          <box
            key={item.id}
            flexDirection="row"
            gap={1}
            onMouseDown={() => onNavigate(item.id)}
          >
            <text fg={isActive ? colors.primary : colors.muted}>
              {isActive ? "▸" : " "}
            </text>
            <text fg={colors.muted}>{item.digit}</text>
            <text
              fg={isActive ? colors.primary : colors.foreground}
              attributes={isActive ? TextAttributes.BOLD : undefined}
            >
              {item.label}
            </text>
          </box>
        );
      })}
    </box>
  );
}
