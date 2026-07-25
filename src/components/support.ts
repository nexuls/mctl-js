/**
 * Shared vocabulary for the component library — pure helpers and types, no JSX
 * and no I/O.
 *
 * **Pure-UI, page-layer rules apply** (AGENTS.md § 3): nothing here touches the
 * filesystem, spawns processes, or calls `Bun.*`. It only describes how the
 * components map the theme's semantic roles onto visual states.
 */

import type { ThemeColors } from "../types/theme.ts";

/**
 * A semantic colour role from the active theme (`"primary"`, `"error"`, …). Every
 * component colours itself by role rather than by a raw hex so a theme swap
 * re-skins the whole UI — the one colour rule in AGENTS.md § architecture.
 */
export type SemanticColor = keyof ThemeColors;

/**
 * The intent behind an interactive element, mapped to a semantic role. This is
 * the shared "variant" language every actionable component speaks (buttons,
 * progress bars, badges) so a `primary` button and a `primary` bar pull the same
 * hue.
 */
export type Variant =
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "neutral";

/**
 * Resolve a {@link Variant} to the concrete accent hex for the active palette.
 * `neutral` falls back to `foreground` so a variant-less element still has a
 * sensible ink colour.
 */
export function variantColor(colors: ThemeColors, variant: Variant): string {
  if (variant === "neutral") return colors.foreground;
  return colors[variant];
}

/**
 * The text colour to lay *on top of* a filled accent (a solid button, a keycap).
 * The page background reads as the natural "paper" colour against every accent
 * in both the light and dark variants of our built-in themes, so it is the
 * safe, theme-agnostic choice for on-accent ink.
 */
export function onAccent(colors: ThemeColors): string {
  return colors.background;
}

/**
 * The concrete colours for one visual state of a control. `bgColor` is optional
 * because unfilled states (a resting outline/ghost chip) draw no background.
 */
export interface StateColors {
  /** Background fill, or `undefined` to leave the surface unfilled. */
  bgColor?: string;
  /** Text/ink colour. */
  fgColor: string;
  /** Border colour (ignored by borderless kinds). */
  borderColor: string;
}

/**
 * A control's colours across its interactive states. `default` is the resting
 * look; `hover` and `active` override it when the control is hovered or active.
 * The terminal has no pointer hover, so for a {@link "./Button".Button} "active"
 * means focused. Omitted states fall back to `default`.
 */
export interface Variants {
  default: StateColors;
  hover?: StateColors;
  active?: StateColors;
}

/**
 * Pick the {@link StateColors} for a control from its {@link Variants}, given
 * which interactive state it is in. `active` wins over `hover`, and either falls
 * back to `default` when that state is not defined for the variant.
 */
export function resolveState(
  variants: Variants,
  state: { hover?: boolean; active?: boolean },
): StateColors {
  if (state.active && variants.active) return variants.active;
  if (state.hover && variants.hover) return variants.hover;
  return variants.default;
}

/** Clamp `n` into the inclusive `[min, max]` range. */
export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/**
 * Decide whether a set of option labels laid out as horizontal tabs will fit
 * within `available` cells. Used by {@link "./Form".Select} to choose between the
 * side-by-side tab layout (few, short options) and the vertical dropdown (many
 * or long options) — the adaptive behaviour called for in the field spec.
 *
 * The estimate mirrors how a tab row is drawn: each label gets one cell of
 * padding on each side, and tabs are separated by a single divider cell.
 */
export function optionsFitAsTabs(labels: string[], available: number): boolean {
  if (labels.length === 0) return true;
  const PADDING_PER_TAB = 2; // one cell each side of the label
  const DIVIDER = 1; // between adjacent tabs
  const total = labels.reduce(
    (sum, label) => sum + label.length + PADDING_PER_TAB,
    0,
  ) + DIVIDER * (labels.length - 1);
  return total <= available;
}
