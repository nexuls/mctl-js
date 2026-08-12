/**
 * The icon catalogue — MCTL's glyph table.
 *
 * One row per semantic {@link IconName}, one column per {@link IconSet}. This is
 * the **whole visual vocabulary of icons in the app**: adding an icon means
 * adding a row here and nothing else, and no component anywhere may hardcode a
 * glyph (the same rule that keeps colours in `core/theme/`).
 *
 * UI-free and I/O-free: pure data. `detect.ts` decides *which* column is in
 * force; `hooks/use-icons.tsx` hands the resolved row set to components.
 *
 * ## Reading the `nerd` column
 *
 * Nerd Font glyphs live in the Unicode Private Use Area, so they are written as
 * `\u{…}` escapes with the upstream glyph name in a comment rather than as
 * literal characters — a developer without a patched font can still read and
 * review this file, where literals would be a column of tofu boxes. Names and
 * codepoints come from the Nerd Fonts cheat sheet:
 * https://www.nerdfonts.com/cheat-sheet
 *
 * ## The single-cell rule
 *
 * Every value in every column must be **one terminal cell wide**, with two
 * documented exceptions in the ASCII column (`ellipsis`, `transition`) that no
 * column layout is measured against. A two-cell glyph in
 * one set would shift every column beside it when the user switched sets, so
 * East-Asian *Wide* characters (`☕`, `⚡`, most emoji) are barred outright, as
 * are the emoji-width Nerd Font ranges (weather, devicons) — the Font Awesome
 * range used here is single-width in the `Mono` patched variants. *Ambiguous*
 * width characters (`●`, `◉`, `—`) are accepted: they are what the app already
 * draws today and they render narrow in every terminal MCTL targets.
 */

import type { IconMap, IconName, IconSet } from "../../types/icons.ts";

/**
 * The glyph table. Exhaustive over {@link IconName} × {@link IconSet}, so a new
 * icon name fails to type-check until every set has a glyph for it — no set can
 * silently fall back to a blank.
 */
export const ICONS: Readonly<
	Record<IconName, Readonly<Record<IconSet, string>>>
> = {
	// ---- Intent / status ---------------------------------------------------
	success: { nerd: "\u{f00c}" /* nf-fa-check */, unicode: "✔", ascii: "+" },
	warning: {
		nerd: "\u{f071}" /* nf-fa-warning */,
		unicode: "▲",
		ascii: "!",
	},
	error: { nerd: "\u{f00d}" /* nf-fa-close */, unicode: "✖", ascii: "x" },
	info: { nerd: "\u{f05a}" /* nf-fa-info_circle */, unicode: "ℹ", ascii: "i" },
	question: {
		nerd: "\u{f059}" /* nf-fa-question_circle */,
		unicode: "?",
		ascii: "?",
	},

	// ---- Server / job run state -------------------------------------------
	running: { nerd: "\u{f04b}" /* nf-fa-play */, unicode: "●", ascii: ">" },
	stopped: { nerd: "\u{f04d}" /* nf-fa-stop */, unicode: "○", ascii: "." },
	unavailable: {
		nerd: "\u{f127}" /* nf-fa-chain_broken */,
		unicode: "⊘",
		ascii: "!",
	},
	unknownState: {
		nerd: "\u{f059}" /* nf-fa-question_circle */,
		unicode: "?",
		ascii: "?",
	},

	// ---- Selection controls ------------------------------------------------
	radioOn: {
		nerd: "\u{f192}" /* nf-fa-dot_circle_o */,
		unicode: "◉",
		ascii: "*",
	},
	// NOT a space in ASCII: a radio group draws its options bare, so a blank
	// "off" glyph would leave the unselected rows with a ragged missing column.
	radioOff: { nerd: "\u{f10c}" /* nf-fa-circle_o */, unicode: "○", ascii: "o" },
	// `Checkbox` wraps these in its own `[…]`, which is why the "off" glyph may
	// be blank here — `[ ]` still reads as an empty box — and why the nerd set
	// uses a bare circle rather than nf-fa-square_o, whose own box would double
	// up with the brackets.
	checkOn: { nerd: "\u{f00c}" /* nf-fa-check */, unicode: "◉", ascii: "x" },
	checkOff: { nerd: "\u{f10c}" /* nf-fa-circle_o */, unicode: "○", ascii: " " },

	// ---- Wizard / stepper --------------------------------------------------
	stepDone: { nerd: "\u{f00c}" /* nf-fa-check */, unicode: "●", ascii: "*" },
	stepActive: {
		nerd: "\u{f111}" /* nf-fa-circle */,
		unicode: "●",
		ascii: "o",
	},
	stepTodo: { nerd: "\u{f10c}" /* nf-fa-circle_o */, unicode: "○", ascii: "-" },

	// ---- Chrome ------------------------------------------------------------
	close: { nerd: "\u{f00d}" /* nf-fa-close */, unicode: "✕", ascii: "x" },
	bullet: { nerd: "\u{f111}" /* nf-fa-circle */, unicode: "●", ascii: "*" },
	diamond: { nerd: "\u{f219}" /* nf-fa-diamond */, unicode: "◆", ascii: "+" },
	separator: { nerd: "·", unicode: "·", ascii: "|" },
	// Terminals render a real ellipsis in one cell; ASCII spends three, which is
	// why truncation maths must use the glyph's length, not a literal 1.
	ellipsis: { nerd: "…", unicode: "…", ascii: "..." },
	emptyValue: { nerd: "—", unicode: "—", ascii: "-" },

	// ---- Arrows ------------------------------------------------------------
	arrowLeft: {
		nerd: "\u{f060}" /* nf-fa-arrow_left */,
		unicode: "←",
		ascii: "<",
	},
	arrowRight: {
		nerd: "\u{f061}" /* nf-fa-arrow_right */,
		unicode: "→",
		ascii: ">",
	},
	arrowUp: { nerd: "\u{f062}" /* nf-fa-arrow_up */, unicode: "↑", ascii: "^" },
	arrowDown: {
		nerd: "\u{f063}" /* nf-fa-arrow_down */,
		unicode: "↓",
		ascii: "v",
	},
	// The only multi-cell ASCII value besides `ellipsis`: "->" reads far better
	// than a bare ">" in a sentence like `stopped -> running`, and nothing lays
	// out a column against it.
	transition: {
		nerd: "\u{f101}" /* nf-fa-angle_double_right */,
		unicode: "→",
		ascii: "->",
	},
	caret: { nerd: "\u{f105}" /* nf-fa-angle_right */, unicode: "▸", ascii: ">" },

	// ---- Rules -------------------------------------------------------------
	// Box-drawing, not icons in the ordinary sense, but they are glyphs a
	// non-UTF-8 terminal cannot draw, so they belong to the same switch. The
	// heavy/light pair is load-bearing: `Tabs` shows keyboard focus purely as
	// rule weight, so ASCII needs two distinguishable runs too (`=` vs `-`).
	ruleLine: { nerd: "━", unicode: "━", ascii: "=" },
	ruleQuiet: { nerd: "─", unicode: "─", ascii: "-" },
	ruleCapLeft: { nerd: "╺", unicode: "╺", ascii: "-" },
	ruleCapRight: { nerd: "╸", unicode: "╸", ascii: "-" },

	// ---- Domain ------------------------------------------------------------
	loader: { nerd: "\u{f1b2}" /* nf-fa-cube */, unicode: "◆", ascii: "#" },
	server: { nerd: "\u{f233}" /* nf-fa-server */, unicode: "▤", ascii: "=" },
	session: { nerd: "\u{f120}" /* nf-fa-terminal */, unicode: "▷", ascii: ">" },
	backup: { nerd: "\u{f187}" /* nf-fa-archive */, unicode: "◇", ascii: "~" },
	network: { nerd: "\u{f0e8}" /* nf-fa-sitemap */, unicode: "⇅", ascii: "@" },
	folder: { nerd: "\u{f07b}" /* nf-fa-folder */, unicode: "▸", ascii: "/" },
	// NOT "☕": U+2615 is East-Asian *Wide*, so it would occupy two cells and
	// shift the column beside it when the user switched away from `nerd`.
	java: { nerd: "\u{f0f4}" /* nf-fa-coffee */, unicode: "◈", ascii: "J" },
	settings: { nerd: "\u{f013}" /* nf-fa-cog */, unicode: "⚙", ascii: "%" },
	// The two player meters are drawn as ten discrete icons each, the way the
	// game's own HUD draws them, so full and empty need to differ at a glance in
	// every set — hence a filled/outline pair rather than one glyph in two
	// colours (a colour-blind terminal palette, or a monochrome one, would make
	// the meter unreadable).
	heartFull: { nerd: "\u{f004} " /* nf-fa-heart */, unicode: "♥", ascii: "#" },
	heartEmpty: {
		nerd: "\u{f08a} " /* nf-fa-heart_o */,
		unicode: "♡",
		ascii: "-",
	},
	// NOT a drumstick: every food emoji (🍖 U+1F356, 🍗) is East-Asian Wide and
	// would take two cells, so the unicode set uses a filled/outline block pair
	// and the nerd set the cutlery glyph's filled/outline pair.
	foodFull: { nerd: "\u{f141f} " /* nf-fa-cutlery */, unicode: "▰", ascii: "=" },
	foodEmpty: {
		nerd: "\u{f1420} " /* nf-fa-square_o */,
		unicode: "▱",
		ascii: "-",
	},
};

/**
 * Spinner frames per set, cycled by whoever owns a ticker (the toast provider).
 *
 * Braille needs UTF-8, so ASCII falls back to the classic four-frame bar. The
 * frame counts differ deliberately — callers must index with `frame % length`,
 * never assume ten.
 */
export const SPINNERS: Readonly<Record<IconSet, readonly string[]>> = {
	nerd: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	ascii: ["|", "/", "-", "\\"],
};

/** Cache of collapsed maps — the table is immutable, so one per set is enough. */
const resolved = new Map<IconSet, IconMap>();

/**
 * Collapse the two-dimensional table to the flat glyph map for one set.
 *
 * Memoized, and therefore **referentially stable** per set: the result is used
 * as a React context value and as an effect/memo dependency, where a fresh
 * object each call would re-render every consumer on every render.
 *
 * @param set The glyph family to resolve.
 * @returns The frozen `IconName → glyph` map for that set.
 */
export function iconsFor(set: IconSet): IconMap {
	const cached = resolved.get(set);
	if (cached) return cached;

	const map = {} as Record<IconName, string>;
	for (const [name, glyphs] of Object.entries(ICONS)) {
		map[name as IconName] = glyphs[set];
	}
	const frozen = Object.freeze(map) as IconMap;
	resolved.set(set, frozen);
	return frozen;
}

/**
 * The spinner frames for a set. Separate from {@link iconsFor} because an
 * animation is a sequence, not a single glyph, and only the handful of callers
 * that own a ticker need it.
 */
export function spinnerFor(set: IconSet): readonly string[] {
	return SPINNERS[set];
}
