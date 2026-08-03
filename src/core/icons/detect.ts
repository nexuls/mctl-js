/**
 * Icon set resolution: turning the user's `config.icons` preference
 * (`auto | nerd | ascii`) into the concrete {@link IconSet} the UI draws with.
 *
 * UI-free and I/O-free. Every function here is **pure over an environment
 * record** rather than reading `process.env` internally, which is what makes the
 * detection heuristics testable without mutating the process (see
 * `detect.test.ts`). Callers pass `process.env` at the edge.
 *
 * ## Why `auto` is conservative
 *
 * There is **no way to ask a terminal whether its font has Nerd Font glyphs.**
 * A missing glyph renders as tofu (`􏿽`) or, worse, as a two-cell replacement
 * that shifts the layout — a bad enough failure that `auto` only picks `nerd`
 * on *positive* evidence and otherwise settles on `unicode`, which every UTF-8
 * terminal can draw. Users with a patched font in an unrecognised terminal pick
 * `nerd` explicitly; that is a one-time choice, and it is the honest trade.
 */

import type { IconMode } from "../../types/config.ts";
import type { IconSet } from "../../types/icons.ts";

/** The environment slice this module reads. `process.env` satisfies it. */
export type IconEnv = Readonly<Record<string, string | undefined>>;

/**
 * Environment variable that overrides the configured icon mode, following the
 * project's `MCTL_*`-overrides-config convention. Accepts an {@link IconSet}
 * name directly (`nerd` / `unicode` / `ascii`) — unlike the config field it can
 * also name `unicode`, since it exists for debugging and for pinning a set in a
 * script or CI without touching the user's config.
 */
export const ICON_ENV_OVERRIDE = "MCTL_ICONS";

/**
 * Terminals that ship Nerd Font coverage out of the box, so `auto` can pick
 * `nerd` for them without the user configuring anything:
 *
 * - **Ghostty** bundles JetBrains Mono Nerd Font as its default face.
 * - **WezTerm** ships a built-in `Symbols Nerd Font Mono` fallback that is
 *   enabled by default (`font_rules` need not be touched).
 * - **kitty** embeds the Nerd Font symbol ranges and maps them automatically
 *   (kitty ≥ 0.30, https://sw.kovidgoyal.net/kitty/changelog/).
 *
 * Matched case-insensitively against `TERM_PROGRAM`, with `TERM` checked too
 * because kitty and ghostty are more reliably identified by their terminfo
 * entries (`xterm-kitty`, `xterm-ghostty`) than by `TERM_PROGRAM`, which a
 * multiplexer or an SSH hop can strip.
 */
const NERD_FONT_TERMINALS = ["ghostty", "wezterm", "kitty"];

/**
 * Whether the environment claims a UTF-8 locale.
 *
 * Only an **explicit** non-UTF-8 locale (`C`, `POSIX`, `en_US.iso88591`)
 * downgrades to ASCII. An entirely unset locale — routine inside containers and
 * systemd units whose terminal handles UTF-8 perfectly well — is treated as
 * capable, because assuming otherwise would hand ASCII to a large share of
 * users who can see the richer glyphs today.
 */
export function hasUtf8Locale(env: IconEnv): boolean {
	const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
	if (locale === undefined || locale === "") return true;
	return /utf-?8/i.test(locale);
}

/**
 * Whether there is positive evidence that the host terminal can draw Nerd Font
 * glyphs. See {@link NERD_FONT_TERMINALS} for what counts, and the module
 * comment for why the bar is "evidence" rather than "not disproven".
 */
export function hasNerdFont(env: IconEnv): boolean {
	// An explicit opt-in always wins — this is the escape hatch for a patched font
	// in a terminal we do not recognise.
	if (isTruthy(env.MCTL_NERD_FONT) || isTruthy(env.NERD_FONT)) return true;

	const candidates = [env.TERM_PROGRAM, env.TERM].filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
	return candidates.some((value) =>
		NERD_FONT_TERMINALS.some((name) => value.toLowerCase().includes(name)),
	);
}

/**
 * The set `auto` resolves to: the richest family the environment can be shown
 * to support. `nerd` on positive font evidence, `ascii` on an explicitly
 * non-UTF-8 locale, and `unicode` otherwise.
 */
export function detectIconSet(env: IconEnv): IconSet {
	if (!hasUtf8Locale(env)) return "ascii";
	return hasNerdFont(env) ? "nerd" : "unicode";
}

/**
 * Resolve the configured mode to the set to draw with.
 *
 * Precedence, highest first:
 * 1. `MCTL_ICONS` — env overrides config, matching how `secrets.json` works.
 * 2. The explicit `nerd` / `ascii` mode from `config.icons`.
 * 3. `auto` → {@link detectIconSet}.
 *
 * An explicit `nerd` is honoured even without font evidence and even in a
 * non-UTF-8 locale: the user asserting "my font has these glyphs" is better
 * information than any heuristic, and second-guessing it would make the setting
 * useless for exactly the people who need it.
 *
 * @param mode The value of `config.icons`.
 * @param env The environment to read overrides and heuristics from.
 */
export function resolveIconSet(mode: IconMode, env: IconEnv): IconSet {
	const override = parseIconSet(env[ICON_ENV_OVERRIDE]);
	if (override) return override;
	if (mode === "nerd") return "nerd";
	if (mode === "ascii") return "ascii";
	return detectIconSet(env);
}

/**
 * Parse an {@link IconSet} name, case- and whitespace-insensitively.
 *
 * @returns the set, or `undefined` when the value is absent or unrecognised —
 * an unknown value is ignored rather than throwing, since a typo in an env var
 * must not stop the TUI from starting.
 */
export function parseIconSet(value: string | undefined): IconSet | undefined {
	switch (value?.trim().toLowerCase()) {
		case "nerd":
			return "nerd";
		case "unicode":
			return "unicode";
		case "ascii":
			return "ascii";
		default:
			return undefined;
	}
}

/** Whether an env var is set to something meaning "yes". */
function isTruthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}
