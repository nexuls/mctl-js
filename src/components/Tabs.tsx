/**
 * Tabs — a horizontal tab bar for switching between peer views (e.g. a Server
 * page's Overview / Console / Backups sections, or Settings' groups).
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): controlled and stateless — it renders
 * the given `activeId` and reports selection through `onChange`; the parent owns
 * which tab is active.
 *
 * This is distinct from OpenTUI's `<tab-select>` (a *form input* that commits a
 * value): page tabs need mouse clicks per tab and an underlined active marker,
 * so they are drawn directly.
 *
 * The look is deliberately the same as {@link "../app/NavRail".NavRail}, so a
 * page's group tabs read as a smaller sibling of the app's nav bar rather than a
 * second, unrelated tab language: two rows — the tabs, then a rule beneath them —
 * with the active tab drawn as a filled pill and the rule accented only under it.
 * The rule is a **row of per-tab segments**, not a `border={["bottom"]}`: a
 * border is one colour for its whole side, so it could not mark just the active
 * tab. Each segment is width-locked to its tab by {@link tabWidth} (the tab and
 * its segment are both given that exact width, so the rows can never drift) and
 * every segment is `flexShrink={0}` — without that, yoga shrinks the segments
 * once they overflow and the accent ends up narrower than the tab it belongs to.
 */

import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import { useTheme } from "../hooks/use-theme.tsx";
import { useIcons } from "../hooks/use-icons.tsx";
import { alpha, mix } from "../lib/colors.ts";
import { ScrollBox } from "./ScrollBox.tsx";
import { onAccent } from "./support.ts";

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
  /**
   * Optional short label drawn in the accent colour to the *left* of the first
   * tab — the same slot NavRail gives the `MCTL` brand. Use it to name what the
   * tabs belong to (a server's initials, a section's). Not clickable; it is a
   * caption, not a tab. Keep it short: it is laid out inline, so a long string
   * pushes the tabs off a narrow terminal.
   */
  initials?: string;
  /**
   * Cells of inset on each side of the *tabs* (and the caption). The rule row is
   * deliberately **not** inset — it runs under the padding and out to both
   * edges, so the bar reads as a divider spanning the page rather than a
   * floating chip row. Pad here rather than on a wrapper box for exactly that
   * reason: a wrapper's padding would push the rule in too.
   */
  paddingX?: number;
}

/** One cell of padding on each side of a tab's label. */
const TAB_PADDING_X = 1;

/**
 * The exact cell width a tab occupies: its leading separator, side padding and
 * label. Both the tab and its rule segment are laid out from this number, which
 * is what keeps the accent aligned under the tab.
 */
function tabWidth(item: TabItem): number {
  return 1 + TAB_PADDING_X * 2 + item.label.length;
}

/** Props for {@link Tab}. */
interface TabProps {
  /** The entry this tab stands for. */
  item: TabItem;
  /** Colour of the separator drawn before this tab. */
  sepColor: string;
  /** Whether this tab is the one on screen. */
  active: boolean;
  /** Fired when the tab is clicked. */
  onSelect: () => void;
}

/**
 * One tab chip. The active tab is a solid pill in the primary accent with
 * on-accent ink; inactive tabs are muted text that lifts to a faint wash on
 * hover. Hover is local presentation state, so it lives here rather than in the
 * parent (same pattern as {@link "./Button".Button}).
 *
 * This is deliberately *not* a `Button`: a Button colours its label from its own
 * variant matrix and has no kind whose resting look is *muted*, which is what a
 * tab needs so only the active one draws the eye.
 */
function Tab({ item, sepColor, active, onSelect }: TabProps) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);

  const ink = active
    ? onAccent(colors)
    : hovered
      ? colors.foreground
      : colors.muted;

  return (
    <>
      <text fg={sepColor}>{"|"}</text>
      <box
        flexDirection="row"
        flexShrink={0}
        width={tabWidth(item) - 1}
        paddingLeft={TAB_PADDING_X}
        paddingRight={TAB_PADDING_X}
        backgroundColor={
          active
            ? colors.primary
            : hovered
              ? alpha(colors.foreground, 0.12)
              : undefined
        }
        onMouseDown={onSelect}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
      >
        <text fg={ink} attributes={active ? TextAttributes.BOLD : undefined}>
          {item.label}
        </text>
      </box>
    </>
  );
}

/**
 * A row of tabs over a rule. Keyboard navigation wraps around at both ends.
 *
 * Keyboard focus is shown by the *weight* of the accented rule segment — heavy
 * (`━`) while the bar holds the ring, light (`─`) otherwise. That is the only
 * cue that ←/→ will move between tabs, and it costs no extra row: a border or a
 * background would either add one or fight the active pill for attention. The
 * pill itself never changes, so which tab is active stays legible unfocused.
 */
export function Tabs({
  items,
  activeId,
  onChange,
  focused = false,
  onFocused,
  initials,
  paddingX = 0,
}: TabsProps) {
  const { colors } = useTheme();
  // Rule glyphs come from the active icon set. The heavy/light pair is
  // load-bearing here — keyboard focus is shown purely as rule weight — which is
  // why the ASCII set carries two distinguishable runs (`=` and `-`) rather than
  // collapsing both to one character.
  const { icons } = useIcons();
  const { width: viewportWidth } = useTerminalDimensions();
  const activeIndex = Math.max(
    0,
    items.findIndex((t) => t.id === activeId),
  );

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

  const rule = alpha(colors.border, 0.6);
  // The accent reads as a quieter line when the bar is not focused, so blend it
  // toward the rule rather than leaving it at full strength.
  const accent = focused ? colors.primary : mix(colors.primary, rule, 0.75);

  // The caption gets one trailing cell of breathing room before the first tab's
  // separator.
  const caption = initials ? `${initials} ` : "";

  // Everything to the left of the first tab — the inset plus the caption — is
  // counted once and spent twice: the rule row opens with a plain run of
  // exactly this many cells, and the tail subtracts it. That is what keeps the
  // two rows aligned, and what lets the rule start at cell 0 while the tabs
  // themselves are inset.
  const leadCells = paddingX + caption.length;

  // A <text> cannot stretch, so the run that carries the rule out to the right
  // edge has to be counted out. Deliberately an *over*estimate (the terminal
  // width ignores whatever padding the host page applies): the surplus is
  // clipped by the overflow box, whereas undershooting leaves a visible gap.
  const tailCells = Math.max(
    0,
    viewportWidth -
      leadCells -
      items.reduce((sum, item) => sum + tabWidth(item), 0),
  );

  return (
    <ScrollBox
      // Two rows: the tabs, and the rule segments beneath them. A narrow
      // terminal scrolls the bar instead of wrapping it — and the accent
      // segment scrolls with the tab it belongs to.
      height={2}
      width="100%"
      flexShrink={0}
      viewportOptions={{ flexDirection: "column" }}
      scrollX={true}
      scrollY={false}
      scrollbarOptions={{ visible: false }}
    >
      {/* The tabs are inset; the rule row below them is not. */}
      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        paddingLeft={paddingX}
        paddingRight={paddingX}
      >
        {caption ? (
          <text flexShrink={0} fg={colors.primary}>
            {caption}
          </text>
        ) : null}
        {items.map((item) => (
          <Tab
            key={item.id}
            item={item}
            active={item.id === activeId}
            sepColor={rule}
            onSelect={() => {
              onFocused?.();
              onChange(item.id);
            }}
          />
        ))}
      </box>
      <box flexDirection="row" flexShrink={0} height={1}>
        {leadCells > 0 ? (
          <text fg={rule} attributes={TextAttributes.DIM} flexShrink={0}>
            {icons.ruleLine.repeat(leadCells)}
          </text>
        ) : null}
        {items.map((item) => {
          const active = item.id === activeId;
          const width = tabWidth(item) - 1;

          return (
            <box key={item.id} flexDirection="row" flexShrink={0}>
              <text fg={rule} attributes={TextAttributes.DIM} flexShrink={0}>
                {active ? icons.ruleCapRight : icons.ruleLine}
              </text>
              <text
                width={width}
                flexShrink={0}
                fg={active ? accent : rule}
                attributes={active ? undefined : TextAttributes.DIM}
              >
                {(active && !focused
                  ? icons.ruleQuiet
                  : icons.ruleLine
                ).repeat(width)}
              </text>
              {active && (
                <text fg={rule} attributes={TextAttributes.DIM} flexShrink={0}>
                  {icons.ruleCapLeft}
                </text>
              )}
            </box>
          );
        })}
        {/* Carry the rule out to the right edge past the last tab. */}
        <box flexGrow={1} flexShrink={1} overflow="hidden">
          <text fg={rule} attributes={TextAttributes.DIM}>
            {icons.ruleLine.repeat(tailCells)}
          </text>
        </box>
      </box>
    </ScrollBox>
  );
}
