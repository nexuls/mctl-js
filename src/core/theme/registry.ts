/**
 * Theme registry: resolves a theme id to a concrete {@link Theme}, over the set
 * of built-in themes plus user themes discovered in `~/.config/mctl/themes/`.
 *
 * Single responsibility: *own the catalogue of static themes*. It knows nothing
 * about React, the renderer, or the live terminal palette — the dynamic
 * "terminal" theme is handled by the UI layer (`hooks/use-theme`), which is why
 * this registry only lists it as an available option and never stores colours
 * for it. That keeps the registry pure-data and side-effect-free apart from the
 * one explicit `load()` step that reads disk.
 *
 * Depends only on `lib/` (paths, fs, logger) and the Zod schema in
 * `types/theme.ts`. Custom theme files are validated at the boundary; a single
 * malformed file is logged and skipped rather than aborting startup — one bad
 * theme must not make the whole app unlaunchable (the built-ins still resolve).
 */

import { basename } from "node:path";
import { themesDir } from "../../lib/paths.ts";
import { readDirIfExists, readJsonIfExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { ThemeFile, type Theme, type ThemeSummary } from "../../types/theme.ts";
import { BUILTIN_THEMES } from "./builtin.ts";
import { TERMINAL_THEME_ID } from "./terminal.ts";

const logger = log("theme");

/** Summary entry for the dynamic terminal theme (has no static colours). */
const TERMINAL_SUMMARY: ThemeSummary = {
  id: TERMINAL_THEME_ID,
  name: "Terminal Default",
  appearance: "dark", // nominal; the real appearance is resolved live
  source: "terminal",
};

/**
 * Catalogue of resolvable themes. Construct once at startup, call {@link load}
 * to fold in user themes, then treat it as read-only for the session (it is a
 * derived projection of disk, re-`load()`ed if the themes dir changes).
 */
export class ThemeRegistry {
  /** Static themes by id: built-ins first, then custom (custom may override). */
  private readonly themes = new Map<string, Theme>(BUILTIN_THEMES);

  /**
   * Discover and validate user themes from `~/.config/mctl/themes/*.json`,
   * folding each into the catalogue. The theme id is the filename without its
   * `.json` extension (`dracula.json` → `"dracula"`), mirroring how server ids
   * derive from directory names.
   *
   * A custom theme may override a built-in of the same id (explicit user intent)
   * but **not** the reserved `"terminal"` id — that name always means the live
   * host palette. Invalid files are skipped with a warning, never fatal.
   *
   * Safe to call again to refresh after the themes directory changes.
   */
  async load(): Promise<this> {
    const files = await readDirIfExists(themesDir(), ".json");
    for (const file of files) {
      const id = basename(file, ".json");
      if (id === TERMINAL_THEME_ID) {
        logger.warn(
          { file },
          `theme id "${TERMINAL_THEME_ID}" is reserved for the live terminal palette — ignoring`,
        );
        continue;
      }
      const raw = await readJsonIfExists(`${themesDir()}/${file}`);
      const parsed = ThemeFile.safeParse(raw);
      if (!parsed.success) {
        // One malformed theme file must not stop the app from launching.
        logger.warn(
          { file, issues: parsed.error.issues },
          "skipping invalid theme file",
        );
        continue;
      }
      const overrides = this.themes.has(id);
      this.themes.set(id, {
        id,
        name: parsed.data.name,
        appearance: parsed.data.appearance ?? "dark",
        source: "custom",
        colors: parsed.data.colors,
      });
      logger.debug(
        { id, overrides },
        overrides ? "custom theme overrides built-in" : "loaded custom theme",
      );
    }
    return this;
  }

  /** Whether `id` names the dynamic terminal theme (resolved by the UI layer). */
  isDynamic(id: string): boolean {
    return id === TERMINAL_THEME_ID;
  }

  /**
   * Resolve a static theme by id. Returns `undefined` for an unknown id **and**
   * for the dynamic `"terminal"` id (which has no static colours — the caller
   * substitutes the live palette). Callers fall back accordingly.
   */
  get(id: string): Theme | undefined {
    return this.themes.get(id);
  }

  /** Whether `id` resolves to any available theme, static or dynamic. */
  has(id: string): boolean {
    return this.isDynamic(id) || this.themes.has(id);
  }

  /**
   * Every selectable theme as a lightweight summary, for the picker. The dynamic
   * terminal theme is listed first (it is the default out-of-box experience),
   * then static themes sorted by name.
   */
  list(): ThemeSummary[] {
    const statics = [...this.themes.values()]
      .map(
        (t): ThemeSummary => ({
          id: t.id,
          name: t.name,
          appearance: t.appearance,
          source: t.source,
        }),
      )
      .sort((x, y) => x.name.localeCompare(y.name));
    return [TERMINAL_SUMMARY, ...statics];
  }
}
