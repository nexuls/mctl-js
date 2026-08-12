/**
 * Types for the icon system: the glyph *sets* MCTL can draw in, the semantic
 * icon *names* the UI asks for, and the resolved map between them.
 *
 * No glyphs and no I/O here — this module only *describes* the shape. The glyph
 * table lives in `core/icons/catalogue.ts` and set resolution in
 * `core/icons/detect.ts`, mirroring how `types/theme.ts` describes themes while
 * `core/theme/` holds the palettes.
 *
 * **Why semantic names.** A component asks for `icons.success`, never for `"✔"`.
 * That is the same rule the theme system enforces for colour (`colors.error`,
 * never `"#f00"`), and it is what makes a whole-app glyph swap a one-line config
 * change instead of a grep.
 */

/**
 * A concrete family of glyphs the UI can be drawn with.
 *
 * These are the *rendering* sets, not the user-facing choice — `config.icons`
 * offers `auto | nerd | ascii` (see `IconMode` in `types/config.ts`), and `auto`
 * resolves to one of these three. `unicode` exists as the middle tier `auto`
 * lands on: a terminal can almost always draw `●` and `✔` without a Nerd Font
 * installed, so falling straight from `nerd` to `ascii` would needlessly
 * downgrade the majority of terminals.
 *
 * - `nerd` — Nerd Font glyphs (Private Use Area). Requires a patched font.
 * - `unicode` — plain Unicode symbols. Works in any UTF-8 terminal.
 * - `ascii` — 7-bit ASCII only. The universal fallback.
 */
export type IconSet = "nerd" | "unicode" | "ascii";

/** Every {@link IconSet}, in decreasing order of richness. */
export const ICON_SETS: readonly IconSet[] = ["nerd", "unicode", "ascii"];

/**
 * The semantic icons the UI can ask for. Adding one means adding a row to
 * `ICONS` in `core/icons/catalogue.ts` — the table is exhaustive over this
 * union, so a missing glyph is a type error rather than a blank cell.
 */
export type IconName =
	// ---- Intent / status -----------------------------------------------------
	/** A completed, correct, or accepted thing. */
	| "success"
	/** Something needing attention but not broken. */
	| "warning"
	/** A failure. */
	| "error"
	/** Neutral supporting information. */
	| "info"
	/** An open question or an unknown value. */
	| "question"

	// ---- Server / job run state ---------------------------------------------
	/** A server that is up (pid/session probed alive). */
	| "running"
	/** A server that is down but available. */
	| "stopped"
	/** A registered server whose path or `mctl.json` is missing. */
	| "unavailable"
	/** A server whose state could not be determined. */
	| "unknownState"

	// ---- Selection controls --------------------------------------------------
	/** A selected radio option. */
	| "radioOn"
	/** An unselected radio option. */
	| "radioOff"
	/** A ticked checkbox (drawn inside the caller's brackets). */
	| "checkOn"
	/** An unticked checkbox. */
	| "checkOff"

	// ---- Wizard / stepper ----------------------------------------------------
	/** A step already completed. */
	| "stepDone"
	/** The step being shown. */
	| "stepActive"
	/** A step not yet reached. */
	| "stepTodo"

	// ---- Chrome --------------------------------------------------------------
	/** The dismiss affordance on a toast or dialog. */
	| "close"
	/** A generic filled marker. */
	| "bullet"
	/** A generic secondary marker. */
	| "diamond"
	/** The divider between inline items (hint strips, summary lines). */
	| "separator"
	/** Truncation marker appended to clipped text. */
	| "ellipsis"
	/** Stands in for a value that is absent or not applicable. */
	| "emptyValue"

	// ---- Arrows --------------------------------------------------------------
	/** Back / previous. */
	| "arrowLeft"
	/** Forward / next. */
	| "arrowRight"
	/** Up in a list. */
	| "arrowUp"
	/** Down in a list. */
	| "arrowDown"
	/** A state transition, as in `stopped → running`. */
	| "transition"
	/** The marker on the selected row of a list. Distinct from {@link transition}
	 * so a list caret and an arrow in prose can look different. */
	| "caret"

	// ---- Rules (the tab-bar underline) ---------------------------------------
	/** The heavy rule run under a focused tab bar. */
	| "ruleLine"
	/** The light rule run, used when the bar does not hold focus. */
	| "ruleQuiet"
	/** The cap drawn to the left of an accented rule segment. */
	| "ruleCapLeft"
	/** The cap drawn to the right of an accented rule segment. */
	| "ruleCapRight"

	// ---- Domain --------------------------------------------------------------
	/** Server implementations / loaders (Paper, Fabric, Forge…). */
	| "loader"
	/** A server, or the servers collection. */
	| "server"
	/** A runtime session (tmux/docker/foreground). */
	| "session"
	/** A backup archive. */
	| "backup"
	/** Networking — ports, tunnels, DNS. */
	| "network"
	/** A filesystem directory. */
	| "folder"
	/** A Java runtime. */
	| "java"
	/** Configuration. */
	| "settings"
	/** One remaining point of a player's health meter. */
	| "heartFull"
	/** One lost point of a player's health meter. */
	| "heartEmpty"
	/** One remaining point of a player's hunger meter. */
	| "foodFull"
	/** One lost point of a player's hunger meter. */
	| "foodEmpty";

/**
 * A fully-resolved glyph table: every {@link IconName} mapped to the string to
 * draw. This is what {@link "../hooks/use-icons".useIcons} hands components.
 *
 * Values are single-cell strings in every set, so swapping sets never changes
 * layout width — a rule that matters in a terminal, where a two-cell glyph in
 * one set would shift every column beside it.
 */
export type IconMap = Readonly<Record<IconName, string>>;
