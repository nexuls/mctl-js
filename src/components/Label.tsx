/**
 * Label — a small, consistent text label for form controls and sections.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders text only; no I/O.
 *
 * Fields render their label on the box border (see {@link "./Form".Field}), so
 * this standalone component is for the cases that sit *outside* a field: a group
 * heading, an inline caption, or a bare label above a custom control.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../hooks/use-theme.tsx";

/** Props for {@link Label}. */
export interface LabelProps {
  /** The label text. */
  children: string;
  /**
   * Draw in the accent colour to signal focus/importance. Defaults to the muted
   * role so labels stay quiet next to the values they describe.
   */
  emphasis?: boolean;
  /** Append a dim `*` marker to signal a required field. */
  required?: boolean;
}

/**
 * A single line of label text. Muted by default, accented when `emphasis` is set
 * (e.g. the field it labels is focused). A `required` marker is drawn in the
 * warning role so it reads as "needs attention" rather than "error".
 */
export function Label({ children, emphasis = false, required = false }: LabelProps) {
  const { colors } = useTheme();
  return (
    <text
      fg={emphasis ? colors.primary : colors.muted}
      attributes={emphasis ? TextAttributes.BOLD : TextAttributes.DIM}
    >
      {children}
      {required ? <span fg={colors.warning}> *</span> : null}
    </text>
  );
}
