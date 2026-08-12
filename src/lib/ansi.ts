/**
 * ANSI escape-sequence parsing — turning a raw captured console line into styled
 * spans a renderer can paint.
 *
 * Leaf helper: pure string work, no I/O, no UI, no knowledge of servers. It
 * yields *neutral* colour descriptions (a palette index or an explicit RGB
 * value); mapping an index onto the app's theme is a UI concern and lives in
 * `components/AnsiText.tsx`.
 *
 * **Why this exists.** Modded servers colour their output. NeoForge/Forge run
 * log4j with a console appender whose pattern emits SGR sequences, so a captured
 * line arrives as `\x1b[32m[03:21:16] [main/INFO] …\x1b[m` — vanilla and Paper
 * emit none. Rendered verbatim, the escapes appear as literal `[32m` garbage in
 * the middle of every line, because the console pane draws into a frame buffer
 * rather than writing bytes to the terminal.
 *
 * Only SGR (`CSI … m`) is interpreted. Cursor moves, erase, OSC titles and the
 * rest are *dropped*: they address a real terminal MCTL is not giving them, and
 * printing them literally is the bug being fixed.
 */

/** A colour named by an ANSI sequence. */
export type AnsiColor =
	/**
	 * A palette entry: 0–7 standard, 8–15 bright, 16–255 the xterm 256-colour
	 * cube and greyscale ramp. Left as an index on purpose — the caller decides
	 * what "red" looks like in the active theme.
	 */
	| { kind: "index"; index: number }
	/** An explicit 24-bit colour (`CSI 38;2;r;g;b m`), as `#rrggbb`. */
	| { kind: "rgb"; hex: string };

/** The SGR state in force for a run of characters. */
export interface AnsiStyle {
	fg?: AnsiColor;
	bg?: AnsiColor;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	blink?: boolean;
	/** `CSI 7 m` — swap foreground and background. */
	inverse?: boolean;
	strikethrough?: boolean;
}

/** A run of characters sharing one {@link AnsiStyle}. */
export interface AnsiSpan extends AnsiStyle {
	text: string;
}

/** ESC and BEL as escapes — a literal control byte in source is invisible. */
const ESC = "\u001b";
const BEL = "\u0007";

/**
 * Columns a tab advances to. Eight is what a terminal does, and Java stack
 * traces — the reason tabs reach a Minecraft console at all — are written
 * against that. Expanding here rather than passing the tab through is
 * deliberate: a frame buffer has no tab stops, so the renderer draws the
 * character at whatever width it likes (OpenTUI draws two) and the indentation
 * of a stack trace stops lining up with the line above it.
 */
const TAB_WIDTH = 8;

/**
 * Split `input` into styled spans.
 *
 * Adjacent runs with identical styling are merged, so an unstyled line yields
 * exactly one span (`[{text: input}]`) and the common case stays cheap. An empty
 * input — or one that is nothing but escapes — yields an empty array.
 *
 * Carriage returns are honoured roughly the way a terminal would: the *text that
 * follows* a `\r` overwrites the line from column 0, so a progress line
 * (`50%\r100%`) reads as its final state. A `\r` with nothing printable after it
 * discards nothing — the capture file stores CRLF line endings (tmux
 * `pipe-pane` records what the pty wrote) and the echo of a typed command ends
 * `\r\r`, so treating a bare return as an erase would blank those lines.
 *
 * Tabs are expanded to spaces at {@link TAB_WIDTH} stops, so a stack trace's
 * indentation survives into a frame buffer that has no tab stops of its own.
 *
 * The one deliberate simplification: a real terminal overwrites *column by
 * column*, leaving the tail of a longer previous line visible. Here the earlier
 * text is dropped whole. Nothing a server prints relies on the difference, and
 * the alternative is a column-addressed screen model for one edge case.
 */
export function parseAnsi(input: string): AnsiSpan[] {
	const spans: AnsiSpan[] = [];
	let style: AnsiStyle = {};
	let text = "";
	let pendingReturn = false;
	// Column of the next character, so a tab can advance to its next stop.
	let column = 0;

	const flush = () => {
		if (text === "") return;
		const last = spans.at(-1);
		if (last && sameStyle(last, style)) last.text += text;
		else spans.push({ ...style, text });
		text = "";
	};

	let i = 0;
	while (i < input.length) {
		const char = input[i] as string;

		if (char === ESC) {
			const consumed = readEscape(input, i);
			if (consumed.sgr !== undefined) {
				flush();
				style = applySgr(style, consumed.sgr);
			}
			i = consumed.next;
			continue;
		}

		if (char === "\r") {
			// Armed, not applied: what a return erases is decided by whether any
			// printable character follows it.
			pendingReturn = true;
			i += 1;
			continue;
		}

		// Other C0 controls (BEL, NUL, a stray backspace) have no glyph; drawing
		// them into a frame buffer produces a stray box.
		if (char < " " && char !== "\t") {
			i += 1;
			continue;
		}

		if (pendingReturn) {
			pendingReturn = false;
			text = "";
			spans.length = 0;
			column = 0;
		}

		if (char === "\t") {
			const width = TAB_WIDTH - (column % TAB_WIDTH);
			text += " ".repeat(width);
			column += width;
			i += 1;
			continue;
		}

		text += char;
		column += 1;
		i += 1;
	}

	flush();
	return spans;
}

/**
 * The plain text of `input` with every escape sequence removed — what the line
 * *says*, for matching, measuring or logging.
 */
export function stripAnsi(input: string): string {
	let out = "";
	for (const span of parseAnsi(input)) out += span.text;
	return out;
}

/**
 * Whether `input` contains anything {@link parseAnsi} would change — an escape
 * sequence, a tab or a carriage return.
 *
 * The fast-path test for a renderer: a vanilla or Paper server's line is plain
 * text and can be drawn as the string it already is, and a console holds
 * thousands of them.
 */
export function needsParse(input: string): boolean {
	return input.includes(ESC) || input.includes("\t") || input.includes("\r");
}

/**
 * Consume one escape sequence starting at `start` (which must be an ESC).
 *
 * @returns the index just past the sequence, plus the SGR parameter string when
 *   the sequence was `CSI … m` (`""` for a bare `CSI m`, which means reset).
 */
function readEscape(
	input: string,
	start: number,
): { next: number; sgr?: string } {
	const introducer = input[start + 1];

	// CSI: ESC [ params intermediates final. Parameter bytes are 0x30–0x3F,
	// intermediates 0x20–0x2F, and the first byte outside those ranges ends it.
	if (introducer === "[") {
		let i = start + 2;
		while (i < input.length) {
			const code = input.charCodeAt(i);
			if (code >= 0x30 && code <= 0x3f) i += 1;
			else if (code >= 0x20 && code <= 0x2f) i += 1;
			else break;
		}
		if (i >= input.length) return { next: input.length };
		const final = input[i];
		const params = input.slice(start + 2, i);
		return final === "m" ? { next: i + 1, sgr: params } : { next: i + 1 };
	}

	// OSC (and the other string-introducers): runs until BEL or ST (ESC \).
	if (
		introducer === "]" ||
		introducer === "P" ||
		introducer === "^" ||
		introducer === "_"
	) {
		let i = start + 2;
		while (i < input.length) {
			if (input[i] === BEL) return { next: i + 1 };
			if (input[i] === ESC && input[i + 1] === "\\") return { next: i + 2 };
			i += 1;
		}
		return { next: input.length };
	}

	// A two-character escape (ESC c, ESC =, …), or a dangling ESC at end of line.
	return { next: introducer === undefined ? start + 1 : start + 2 };
}

/**
 * Apply one SGR parameter list to `style`, returning the new style.
 *
 * An empty or absent parameter is `0` (reset) — `CSI m` is how log4j's console
 * appender ends a coloured line, and reading it as "no change" leaves every
 * subsequent line stuck in the previous colour.
 */
function applySgr(style: AnsiStyle, params: string): AnsiStyle {
	// Private-parameter sequences (`CSI ? … m`) are not SGR; ignore them whole.
	if (
		params.startsWith("?") ||
		params.startsWith(">") ||
		params.startsWith("<")
	) {
		return style;
	}
	const codes =
		params === ""
			? [0]
			: params.split(";").map((p) => (p === "" ? 0 : Number(p)));
	let next: AnsiStyle = { ...style };

	for (let i = 0; i < codes.length; i += 1) {
		const code = codes[i] as number;
		if (!Number.isFinite(code)) continue;

		if (code === 0) next = {};
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 5 || code === 6) next.blink = true;
		else if (code === 7) next.inverse = true;
		else if (code === 9) next.strikethrough = true;
		else if (code === 21 || code === 22) {
			next.bold = undefined;
			next.dim = undefined;
		} else if (code === 23) next.italic = undefined;
		else if (code === 24) next.underline = undefined;
		else if (code === 25) next.blink = undefined;
		else if (code === 27) next.inverse = undefined;
		else if (code === 29) next.strikethrough = undefined;
		else if (code >= 30 && code <= 37)
			next.fg = { kind: "index", index: code - 30 };
		else if (code === 39) next.fg = undefined;
		else if (code >= 40 && code <= 47)
			next.bg = { kind: "index", index: code - 40 };
		else if (code === 49) next.bg = undefined;
		else if (code >= 90 && code <= 97)
			next.fg = { kind: "index", index: code - 90 + 8 };
		else if (code >= 100 && code <= 107)
			next.bg = { kind: "index", index: code - 100 + 8 };
		else if (code === 38 || code === 48) {
			const extended = readExtendedColor(codes, i);
			if (extended.color) {
				if (code === 38) next.fg = extended.color;
				else next.bg = extended.color;
			}
			i = extended.next;
		}
		// Anything else (fonts, framing, ideogram attributes) has no meaning here.
	}

	return next;
}

/**
 * Read the argument of a `38`/`48` extended-colour selector.
 *
 * `5;n` is a palette index, `2;r;g;b` a 24-bit colour. The colon-separated form
 * (`38:2::r:g:b`) never reaches here — a colon is a parameter byte, so it stays
 * inside one `split(";")` element and parses as `NaN`, which is skipped.
 *
 * @param at index of the `38`/`48` code itself.
 * @returns the colour (when well-formed) and the index of the last code consumed.
 */
function readExtendedColor(
	codes: number[],
	at: number,
): { color?: AnsiColor; next: number } {
	const mode = codes[at + 1];
	if (mode === 5) {
		const index = codes[at + 2];
		if (index === undefined || !Number.isFinite(index)) return { next: at + 1 };
		return { color: { kind: "index", index }, next: at + 2 };
	}
	if (mode === 2) {
		const [r, g, b] = [codes[at + 2], codes[at + 3], codes[at + 4]];
		if (r === undefined || g === undefined || b === undefined)
			return { next: at + 1 };
		return { color: { kind: "rgb", hex: toHex(r, g, b) }, next: at + 4 };
	}
	return { next: at + 1 };
}

/**
 * Resolve a 256-colour palette index to `#rrggbb` — the standard xterm layout:
 * 16–231 are a 6×6×6 RGB cube with the well-known non-linear level steps, and
 * 232–255 a 24-step greyscale ramp. Indices 0–15 have **no** fixed answer (they
 * are the terminal's/theme's own colours) and return `undefined`.
 *
 * https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit
 */
export function xterm256Hex(index: number): string | undefined {
	if (!Number.isInteger(index) || index < 16 || index > 255) return undefined;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return toHex(level, level, level);
	}
	const CUBE = [0, 95, 135, 175, 215, 255];
	const n = index - 16;
	return toHex(
		CUBE[Math.floor(n / 36)] as number,
		CUBE[Math.floor(n / 6) % 6] as number,
		CUBE[n % 6] as number,
	);
}

/** `#rrggbb` from three 0–255 channels, clamped. */
function toHex(r: number, g: number, b: number): string {
	const byte = (v: number) =>
		Math.max(0, Math.min(255, Math.round(v)))
			.toString(16)
			.padStart(2, "0");
	return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Whether two styles paint identically (so their spans can be merged). */
function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
	return (
		sameColor(a.fg, b.fg) &&
		sameColor(a.bg, b.bg) &&
		!a.bold === !b.bold &&
		!a.dim === !b.dim &&
		!a.italic === !b.italic &&
		!a.underline === !b.underline &&
		!a.blink === !b.blink &&
		!a.inverse === !b.inverse &&
		!a.strikethrough === !b.strikethrough
	);
}

/** Whether two optional colours are the same colour. */
function sameColor(a?: AnsiColor, b?: AnsiColor): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.kind === "index" && b.kind === "index") return a.index === b.index;
	if (a.kind === "rgb" && b.kind === "rgb") return a.hex === b.hex;
	return false;
}
