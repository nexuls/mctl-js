/**
 * Tests for the pure layout helpers behind the form controls.
 *
 * `tabSelectHit` reconstructs geometry that `@opentui/core` keeps private, so
 * these cases are the guard against that reconstruction drifting from what the
 * renderable actually paints.
 */

import { describe, expect, test } from "bun:test";
import { optionsFitAsTabs, tabSelectHit } from "./support.ts";

/** A strip 40 cells wide with 10-cell tabs ⇒ 4 tabs visible at a time. */
const strip = (count: number, selectedIndex: number, offsetX: number) =>
	tabSelectHit({
		offsetX,
		offsetY: 0,
		width: 40,
		tabWidth: 10,
		count,
		selectedIndex,
	});

describe("tabSelectHit", () => {
	test("maps a column to the tab drawn there when nothing is scrolled", () => {
		expect(strip(4, 0, 0)).toEqual({ kind: "tab", index: 0 });
		expect(strip(4, 0, 9)).toEqual({ kind: "tab", index: 0 });
		expect(strip(4, 0, 10)).toEqual({ kind: "tab", index: 1 });
		expect(strip(4, 0, 35)).toEqual({ kind: "tab", index: 3 });
	});

	test("accounts for the scroll offset the selection forces", () => {
		// 8 options, 4 visible, selection at 5 ⇒ offset = 5 - 2 = 3.
		expect(strip(8, 5, 5)).toEqual({ kind: "tab", index: 3 });
		expect(strip(8, 5, 15)).toEqual({ kind: "tab", index: 4 });
		// The offset is capped so the strip never scrolls past the last option.
		expect(strip(8, 7, 5)).toEqual({ kind: "tab", index: 4 });
		expect(strip(8, 7, 35)).toEqual({ kind: "tab", index: 7 });
	});

	test("reports the end arrows, which are painted over the tabs beneath", () => {
		// Scrolled to the start: only the right arrow is drawn.
		expect(strip(8, 0, 0)).toEqual({ kind: "tab", index: 0 });
		expect(strip(8, 0, 39)).toEqual({ kind: "scroll", direction: 1 });
		// Scrolled into the middle: both arrows.
		expect(strip(8, 5, 0)).toEqual({ kind: "scroll", direction: -1 });
		expect(strip(8, 5, 39)).toEqual({ kind: "scroll", direction: 1 });
		// Scrolled to the end: no right arrow, so the last cell is still a tab.
		expect(strip(8, 7, 39)).toEqual({ kind: "tab", index: 7 });
	});

	test("draws no arrows at all when every option fits", () => {
		expect(strip(4, 2, 0)).toEqual({ kind: "tab", index: 0 });
		expect(strip(4, 2, 39)).toEqual({ kind: "tab", index: 3 });
	});

	test("ignores empty space, other rows, and out-of-bounds columns", () => {
		// 3 options in a 4-tab strip: the fourth slot is empty.
		expect(strip(3, 0, 35)).toEqual({ kind: "none" });
		expect(strip(4, 0, 40)).toEqual({ kind: "none" });
		expect(strip(4, 0, -1)).toEqual({ kind: "none" });
		expect(
			tabSelectHit({
				offsetX: 5,
				offsetY: 1,
				width: 40,
				tabWidth: 10,
				count: 4,
				selectedIndex: 0,
			}),
		).toEqual({ kind: "none" });
		expect(strip(0, 0, 0)).toEqual({ kind: "none" });
	});

	test("survives a strip narrower than one tab", () => {
		const hit = tabSelectHit({
			offsetX: 3,
			offsetY: 0,
			width: 6,
			tabWidth: 10,
			count: 4,
			selectedIndex: 2,
		});
		// One tab fits, so the offset is the selection itself.
		expect(hit).toEqual({ kind: "tab", index: 2 });
	});
});

describe("optionsFitAsTabs", () => {
	test("fits when the padded labels plus dividers stay inside the width", () => {
		expect(optionsFitAsTabs(["a", "b"], 7)).toBe(true);
		expect(optionsFitAsTabs(["a", "b"], 6)).toBe(false);
		expect(optionsFitAsTabs([], 0)).toBe(true);
	});
});
