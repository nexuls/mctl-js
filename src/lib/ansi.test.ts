/**
 * Tests for the ANSI parser. The fixtures are the shapes MCTL actually captures:
 * a NeoForge/log4j line, a plain vanilla line, and the CRLF endings tmux's
 * `pipe-pane` writes.
 */

import { describe, expect, test } from "bun:test";
import { needsParse, parseAnsi, stripAnsi, xterm256Hex } from "./ansi.ts";

const ESC = "\u001b";

describe("parseAnsi", () => {
	test("a line with no escapes is one span", () => {
		const spans = parseAnsi("[21:50:52 INFO]: All chunks are saved");
		expect(spans).toEqual([{ text: "[21:50:52 INFO]: All chunks are saved" }]);
	});

	test("a log4j line keeps its colour and drops the escapes", () => {
		const line = `${ESC}[32m[03:21:16] [main/INFO] [ne.ne.fm.st.Entrypoint/]: JVM Uptime${ESC}[m`;
		const spans = parseAnsi(line);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.text).toBe(
			"[03:21:16] [main/INFO] [ne.ne.fm.st.Entrypoint/]: JVM Uptime",
		);
		expect(spans[0]?.fg).toEqual({ kind: "index", index: 2 });
	});

	test("a bare CSI m resets — the style does not leak past it", () => {
		const spans = parseAnsi(`${ESC}[31mred${ESC}[mplain`);
		expect(spans.map((s) => [s.text, s.fg])).toEqual([
			["red", { kind: "index", index: 1 }],
			["plain", undefined],
		]);
	});

	test("attributes accumulate and are cleared individually", () => {
		const spans = parseAnsi(`${ESC}[1;4mboth${ESC}[24monly bold`);
		expect(spans[0]).toMatchObject({
			text: "both",
			bold: true,
			underline: true,
		});
		expect(spans[1]).toMatchObject({ text: "only bold", bold: true });
		expect(spans[1]?.underline).toBeUndefined();
	});

	test("bright codes are palette entries 8–15", () => {
		expect(parseAnsi(`${ESC}[93mx`)[0]?.fg).toEqual({
			kind: "index",
			index: 11,
		});
	});

	test("256-colour and truecolor selectors", () => {
		expect(parseAnsi(`${ESC}[38;5;208mx`)[0]?.fg).toEqual({
			kind: "index",
			index: 208,
		});
		expect(parseAnsi(`${ESC}[38;2;255;128;0mx`)[0]?.fg).toEqual({
			kind: "rgb",
			hex: "#ff8000",
		});
		expect(parseAnsi(`${ESC}[48;2;0;0;16mx`)[0]?.bg).toEqual({
			kind: "rgb",
			hex: "#000010",
		});
	});

	test("non-SGR sequences are dropped without eating text", () => {
		expect(stripAnsi(`${ESC}[2Kprogress${ESC}[1;1Hdone`)).toBe("progressdone");
		expect(stripAnsi(`${ESC}]0;a titletext`)).toBe("text");
	});

	test("a trailing CR is a line ending, not an overwrite", () => {
		// tmux pipe-pane records the pty's CRLF; splitting on \n leaves the CR.
		expect(stripAnsi("Starting server\r")).toBe("Starting server");
	});

	test("a mid-line CR overwrites what came before it", () => {
		expect(stripAnsi("50%\r100%")).toBe("100%");
	});

	test("a CR with nothing printable after it erases nothing", () => {
		// The echo of a typed command arrives as `\x1b[m> stop\r\r`.
		expect(stripAnsi(`${ESC}[m> stop\r\r`)).toBe("> stop");
		expect(stripAnsi(`done\r${ESC}[m`)).toBe("done");
	});

	test("tabs are expanded to eight-column stops", () => {
		// A Java stack trace's continuation lines, as a Minecraft log writes them.
		expect(stripAnsi("\t... 6 more")).toBe("        ... 6 more");
		expect(stripAnsi("ab\tc")).toBe("ab      c");
		expect(stripAnsi("12345678\tx")).toBe("12345678        x");
	});

	test("runs sharing a style are merged", () => {
		expect(parseAnsi(`${ESC}[32ma${ESC}[32mb`)).toEqual([
			{ text: "ab", fg: { kind: "index", index: 2 } },
		]);
	});

	test("a line of nothing but escapes yields no spans", () => {
		expect(parseAnsi(`${ESC}[m${ESC}[32m`)).toEqual([]);
		expect(parseAnsi("")).toEqual([]);
	});

	test("a truncated escape at end of line is consumed, not printed", () => {
		expect(stripAnsi(`text${ESC}[3`)).toBe("text");
		expect(stripAnsi(`text${ESC}`)).toBe("text");
	});
});

describe("needsParse", () => {
	test("a plain line needs nothing done to it", () => {
		expect(needsParse("[21:50:52 INFO]: saved")).toBe(false);
	});

	test("escapes, tabs and returns all need parsing", () => {
		expect(needsParse(`${ESC}[32mx`)).toBe(true);
		expect(needsParse("\tat java.base/…")).toBe(true);
		expect(needsParse("Starting server\r")).toBe(true);
	});
});

describe("xterm256Hex", () => {
	test("the 6×6×6 cube and the greyscale ramp", () => {
		expect(xterm256Hex(16)).toBe("#000000");
		expect(xterm256Hex(196)).toBe("#ff0000");
		expect(xterm256Hex(231)).toBe("#ffffff");
		expect(xterm256Hex(232)).toBe("#080808");
		expect(xterm256Hex(255)).toBe("#eeeeee");
	});

	test("0–15 have no fixed answer — they are the theme's", () => {
		expect(xterm256Hex(1)).toBeUndefined();
		expect(xterm256Hex(15)).toBeUndefined();
		expect(xterm256Hex(256)).toBeUndefined();
	});
});
