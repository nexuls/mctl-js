/**
 * Tests for the toast card's text layout. `wrapText` is the one piece of real
 * logic in a component that is otherwise pure rendering: terminal text does not
 * reflow, so a mistake here either clips a message silently or overflows the card
 * border. Everything else about a toast (timers, stacking) belongs to
 * `hooks/use-toast.tsx`.
 *
 * Must live inside `src/` — a test outside it resolves a different copy of
 * `@opentui/core` (see memory.md).
 */

import { describe, expect, test } from "bun:test";
import { wrapText } from "./Toast.tsx";

describe("wrapText", () => {
	test("keeps a short line as one line", () => {
		expect(wrapText("Settings saved", 20, 2)).toEqual(["Settings saved"]);
	});

	test("wraps on word boundaries within the width", () => {
		const lines = wrapText("the server stopped unexpectedly", 12, 4);
		expect(lines).toEqual(["the server", "stopped", "unexpectedly"]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
	});

	test("hard-breaks a word longer than the line", () => {
		expect(wrapText("/home/user/very-long-path", 10, 3)).toEqual([
			"/home/user",
			"/very-long",
			"-path",
		]);
	});

	test("marks truncation instead of dropping text silently", () => {
		const lines = wrapText("one two three four five six seven", 9, 2);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toEndWith("…");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(9);
	});

	test("never exceeds maxLines", () => {
		expect(wrapText("a b c d e f g h i j k", 3, 3)).toHaveLength(3);
	});

	test("degenerate sizes yield nothing rather than throwing", () => {
		expect(wrapText("anything", 0, 2)).toEqual([]);
		expect(wrapText("anything", 10, 0)).toEqual([]);
		expect(wrapText("   ", 10, 2)).toEqual([]);
	});
});
