/**
 * Zod schemas and inferred types for MCTL's theming system.
 *
 * A **theme** is a small set of *semantic* colour roles (background, foreground,
 * accents, status colours) — never raw ANSI indices or component-specific names.
 * The UI colours itself by role (`theme.colors.error`, `theme.colors.primary`),
 * so swapping a theme re-skins every screen without touching a component.
 *
 * The Zod schema is the source of truth and is applied at the disk boundary when
 * loading user theme files from `~/.config/mctl/themes/*.json` (AGENTS.md § "Zod
 * at every boundary"). This module is pure description + validation: no I/O, no
 * UI. Loading/resolving lives in `core/theme/`.
 */

import { z } from "zod";

/**
 * A CSS-style hex colour: `#rgb` or `#rrggbb`. User theme files must use hex so a
 * theme renders identically regardless of the host terminal's ANSI palette (a
 * named colour like `"red"` would resolve to whatever the terminal maps it to,
 * defeating the point of a fixed theme).
 */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: "must be a hex colour like #rgb or #rrggbb",
  });

/**
 * The semantic colour roles every theme must define. Kept deliberately small —
 * one responsibility per role — so a new theme is quick to author and every
 * component has a role to reach for. Add a role only when a component genuinely
 * cannot express itself with the existing set.
 */
export const ThemeColors = z.object({
  /** Page background. */
  background: HexColor,
  /** Primary body text. */
  foreground: HexColor,
  /** Slightly offset background for panels/boxes that sit on `background`. */
  surface: HexColor,
  /** Box borders and separators. */
  border: HexColor,
  /** De-emphasised text: hints, timestamps, disabled labels. */
  muted: HexColor,
  /** Main accent: focus, selection, active nav, primary actions. */
  primary: HexColor,
  /** Secondary accent, used sparingly to distinguish from `primary`. */
  secondary: HexColor,
  /** Positive state: running, healthy, completed. */
  success: HexColor,
  /** Cautionary state: pending, degraded, needs attention. */
  warning: HexColor,
  /** Failure state: stopped-with-error, validation failures. */
  error: HexColor,
  /** Informational accent: neutral highlights, tips. */
  info: HexColor,
});
export type ThemeColors = z.infer<typeof ThemeColors>;

/**
 * Whether a theme reads as light or dark. Informational — it lets the UI pick
 * complementary decorations (e.g. shadow direction) and lets Settings group
 * themes. Optional in user files; inferred from background brightness when the
 * terminal-default theme is built.
 */
export const ThemeAppearance = z.enum(["dark", "light"]);
export type ThemeAppearance = z.infer<typeof ThemeAppearance>;

/**
 * On-disk shape of a user theme file (`~/.config/mctl/themes/<id>.json`). The
 * theme's `id` is **not** stored in the file — it is derived from the filename
 * (mirroring how a server id derives from its directory name), so a file cannot
 * disagree with itself about its own identity.
 */
export const ThemeFile = z.object({
  /** Human-readable name shown in the theme picker. */
  name: z.string().min(1),
  appearance: ThemeAppearance.optional(),
  colors: ThemeColors,
});
export type ThemeFile = z.infer<typeof ThemeFile>;

/**
 * A fully-resolved theme: a {@link ThemeFile} plus the identity fields the
 * registry attaches (`id`, and `source` telling where it came from). This is the
 * object handed to the UI.
 */
export interface Theme {
  /** Stable id used in `config.theme` and the picker. */
  id: string;
  /** Human-readable name. */
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  /** Where the theme came from — drives grouping and override precedence. */
  source: ThemeSource;
}

/** Provenance of a theme. `terminal` is the dynamic host-terminal palette. */
export type ThemeSource = "builtin" | "custom" | "terminal";

/**
 * Lightweight listing entry for the theme picker — identity without the full
 * colour set, so Settings can enumerate options cheaply.
 */
export interface ThemeSummary {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  source: ThemeSource;
}

/**
 * A neutral snapshot of the host terminal's colours, decoupled from any TUI
 * library's type. `hooks/use-terminal-colors.ts` adapts OpenTUI's palette into
 * this shape, and `core/theme/terminal.ts` maps it to a {@link Theme} — so core
 * stays free of any UI dependency.
 *
 * `ansi` holds the 16 standard palette entries in the conventional order
 * (0 black, 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan, 7 white, then
 * 8–15 the bright variants). Any entry may be `null` when the terminal did not
 * report it.
 */
export interface TerminalPalette {
  /** Default foreground (text) colour, or `null` if unreported. */
  foreground: string | null;
  /** Default background colour, or `null` if unreported. */
  background: string | null;
  /** The 16 ANSI colours in standard order; entries may be `null`. */
  ansi: ReadonlyArray<string | null>;
}
