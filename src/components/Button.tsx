/**
 * Button — a clickable, focusable action control.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders a box + text and reports
 * intent through `onClick`. It never performs the action itself — the page/hook
 * wired to `onClick` does, keeping domain logic out of the component layer.
 *
 * The terminal has no native button, so focus and press states are conveyed with
 * colour: an *outline* button in its resting state fills solid when focused, so
 * the active control in a row is unmistakable without a mouse.
 */

import { useKeyboard } from "@opentui/react";
import { useTheme } from "../hooks/use-theme.tsx";
import { onAccent, variantColor, type Variant } from "./support.ts";

/** Props for {@link Button}. */
export interface ButtonProps {
  /** The button label. */
  children: string;
  /** Invoked on click, or on Enter/Space while the button is focused. */
  onClick?: () => void;
  /** Intent → accent colour. Defaults to `"primary"`. */
  variant?: Variant;
  /**
   * `"solid"` fills with the accent at rest; `"outline"` (default) shows a
   * bordered chip that fills on focus; `"ghost"` is borderless text that tints
   * on focus (for low-emphasis actions like Cancel).
   */
  kind?: "solid" | "outline" | "ghost";
  /**
   * Whether this button currently holds focus. Only the focused button reacts to
   * Enter/Space; a page with several buttons drives this from its own focus
   * state so exactly one is active at a time.
   */
  focused?: boolean;
  /**
   * Fired when the button is clicked, before `onClick`, so the page can move its
   * focus ring here — a mouse click both focuses and activates the button.
   */
  onFocused?: () => void;
  /** Dim and ignore all interaction. */
  disabled?: boolean;
}

/**
 * An action chip. Click with the mouse, or focus it (via the parent's focus
 * management) and press Enter/Space. Sizes to its label with two cells of side
 * padding.
 */
export function Button({
  children,
  onClick,
  variant = "primary",
  kind = "outline",
  focused = false,
  onFocused,
  disabled = false,
}: ButtonProps) {
  const { colors } = useTheme();
  const accent = variantColor(colors, variant);

  // Only the focused, enabled button consumes Enter/Space. Guarding on `focused`
  // is what keeps multiple mounted buttons from all firing on one keypress.
  useKeyboard((key) => {
    if (!focused || disabled) return;
    if (key.name === "return" || key.name === "space") onClick?.();
  });

  // A mouse click focuses the button (moving the page's focus ring here) and
  // activates it, so pointer users don't have to Tab to it first.
  const press = () => {
    if (disabled) return;
    onFocused?.();
    onClick?.();
  };

  // Resolve the three visual states (rest / focused / disabled) for each kind
  // into concrete border/background/text colours.
  let backgroundColor: string | undefined;
  let borderColor: string;
  let textColor: string;

  if (disabled) {
    backgroundColor = undefined;
    borderColor = colors.border;
    textColor = colors.muted;
  } else if (kind === "solid") {
    backgroundColor = accent;
    borderColor = accent;
    textColor = onAccent(colors);
  } else if (kind === "ghost") {
    backgroundColor = focused ? colors.surface : undefined;
    borderColor = focused ? colors.surface : colors.background;
    textColor = accent;
  } else {
    // outline: fills solid when focused so the active control is obvious.
    backgroundColor = focused ? accent : undefined;
    borderColor = accent;
    textColor = focused ? onAccent(colors) : accent;
  }

  return (
    <box
      border={kind !== "ghost"}
      borderStyle="rounded"
      borderColor={borderColor}
      backgroundColor={backgroundColor}
      paddingLeft={2}
      paddingRight={2}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      onMouseDown={press}
    >
      <text fg={textColor}>{children}</text>
    </box>
  );
}
