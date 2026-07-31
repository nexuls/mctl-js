/**
 * Tabs — a horizontal tab bar for switching between peer views (e.g. a Server
 * page's Overview / Console / Backups sections).
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): controlled and stateless — it renders
 * the given `activeId` and reports selection through `onChange`; the parent owns
 * which tab is active.
 *
 * This is distinct from OpenTUI's `<tab-select>` (a *form input* that commits a
 * value): page tabs need mouse clicks per tab and an underlined active marker,
 * so they are drawn directly.
 */

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../hooks/use-theme.tsx";

/** One tab. */
export interface TabItem {
  /** Stable id reported back through `onChange`. */
  id: string;
  /** Visible tab label. */
  label: string;
}

/** Props for {@link Tabs}. */
export interface TabsProps {
  /** The tabs, left to right. */
  items: TabItem[];
  /** The currently-active tab id (controlled). */
  activeId: string;
  /** Invoked with the id of a newly-selected tab. */
  onChange: (id: string) => void;
  /**
   * Whether the bar has keyboard focus. When focused, Left/Right (and h/l) move
   * between tabs. Mouse clicks always work regardless of focus.
   */
  focused?: boolean;
  /**
   * Fired when a tab is clicked, so the page can move its focus ring to the bar —
   * a click both focuses the bar and selects the clicked tab.
   */
  onFocused?: () => void;
}

/**
 * A row of tabs. The active tab is drawn in the accent colour, bold, with an
 * underline bar beneath it; inactive tabs are muted. Keyboard navigation wraps
 * around at both ends.
 */
export function Tabs({
  items,
  activeId,
  onChange,
  focused = false,
  onFocused,
}: TabsProps) {
  const { colors } = useTheme();
  const activeIndex = Math.max(0, items.findIndex((t) => t.id === activeId));

  useKeyboard((key) => {
    if (!focused || items.length === 0) return;
    if (key.name === "left" || key.name === "h") {
      const next = items[(activeIndex - 1 + items.length) % items.length];
      if (next) onChange(next.id);
    } else if (key.name === "right" || key.name === "l") {
      const next = items[(activeIndex + 1) % items.length];
      if (next) onChange(next.id);
    }
  });

  return (
    <box flexDirection="row" gap={2} alignItems="flex-start">
      {items.map((tab) => {
        const active = tab.id === activeId;
        return (
          <box
            key={tab.id}
            flexDirection="column"
            alignItems="center"
            flexShrink={0}
            onMouseDown={() => {
              onFocused?.();
              onChange(tab.id);
            }}
          >
            <text
              fg={active ? colors.primary : colors.muted}
              attributes={active ? TextAttributes.BOLD : undefined}
            >
              {tab.label}
            </text>
            {/* Underline bar under the active tab; blank (not a hidden glyph)
                for inactive ones so it reads correctly in any theme. The bar
                thickens while the row holds keyboard focus — that is the only
                cue that ←/→ will move between tabs, and it costs no extra row
                (a border or background would). */}
            <text fg={colors.primary}>
              {active
                ? (focused ? "━" : "─").repeat(tab.label.length)
                : " ".repeat(tab.label.length)}
            </text>
          </box>
        );
      })}
    </box>
  );
}
