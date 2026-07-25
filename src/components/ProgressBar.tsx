/**
 * ProgressBar — a determinate horizontal progress meter.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders a coloured track only. It maps
 * a 0..1 fraction to a filled bar; the caller supplies the fraction from a Job's
 * progress events — the component knows nothing about downloads or installs.
 *
 * Drawn as a single row of block glyphs rather than nested boxes so the fill has
 * sub-cell precision isn't needed and the whole bar is one flexible line.
 */

import { useTheme } from "../hooks/use-theme.tsx";
import { clamp, variantColor, type Variant } from "./support.ts";

/** Filled and empty track glyphs. Full block over a light shade reads cleanly in both light and dark terminals. */
const FILLED = "█";
const EMPTY = "░";

/** Props for {@link ProgressBar}. */
export interface ProgressBarProps {
  /** Progress as a fraction in `[0, 1]`. Values outside are clamped. */
  value: number;
  /** Track width in cells. Defaults to 24. */
  width?: number;
  /** Fill colour intent. Defaults to `"primary"`. */
  variant?: Variant;
  /** Show a trailing `NN%` readout after the bar. */
  showPercent?: boolean;
}

/**
 * A fixed-width progress bar. The filled portion is `round(value * width)` cells
 * in the accent colour; the remainder is a muted shade so the full track is
 * always visible.
 */
export function ProgressBar({
  value,
  width = 24,
  variant = "primary",
  showPercent = false,
}: ProgressBarProps) {
  const { colors } = useTheme();
  const fraction = clamp(value, 0, 1);
  const filledCells = Math.round(fraction * width);
  const emptyCells = width - filledCells;

  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text>
        <span fg={variantColor(colors, variant)}>{FILLED.repeat(filledCells)}</span>
        <span fg={colors.border}>{EMPTY.repeat(emptyCells)}</span>
      </text>
      {showPercent ? (
        <text fg={colors.muted}>{`${Math.round(fraction * 100)}%`}</text>
      ) : null}
    </box>
  );
}
