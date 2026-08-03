/**
 * Tests for the Table's pure layout maths — which columns survive a given width
 * and how wide each one ends up.
 *
 * The invariant every case leans on: **the resolved widths plus the gaps never
 * exceed the available width**. A row that overflows by one cell wraps in a
 * terminal and destroys the alignment the component exists to provide, and it
 * does so only at particular widths — exactly the kind of bug a renderer test
 * would miss.
 */

import { describe, expect, test } from "bun:test";
import { fitCell, layoutColumns, type TableColumn } from "./Table.tsx";

/** A column set shaped like the Dashboard's: two required, the rest droppable. */
function columns(): TableColumn<unknown>[] {
	return [
		{ id: "caret", header: " ", width: 1, required: true, render: () => "" },
		{ id: "id", header: "id", min: 10, flex: 3, required: true, render: () => "" },
		{ id: "state", header: "state", width: 12, required: true, render: () => "" },
		{ id: "players", header: "players", width: 7, priority: 90, render: () => "" },
		{ id: "cpu", header: "cpu", width: 5, priority: 85, render: () => "" },
		{ id: "kind", header: "kind", width: 8, priority: 70, render: () => "" },
		{ id: "runtime", header: "runtime", width: 10, priority: 30, render: () => "" },
		{ id: "java", header: "java", width: 4, priority: 20, render: () => "" },
	];
}

/** Total cells a resolved layout occupies, gaps included. */
function occupied(
	resolved: ReturnType<typeof layoutColumns>,
	gap = 1,
): number {
	return (
		resolved.reduce((sum, c) => sum + c.width, 0) +
		gap * Math.max(0, resolved.length - 1)
	);
}

describe("layoutColumns", () => {
	test("never exceeds the available width, at any width", () => {
		for (let width = 1; width <= 200; width += 1) {
			const resolved = layoutColumns(columns(), width);
			expect(occupied(resolved)).toBeLessThanOrEqual(width);
		}
	});

	test("fills the available width exactly once a flexible column fits", () => {
		// Below the natural total there is nothing to distribute; above it, the
		// flexible column absorbs the remainder and the row ends on the edge.
		for (let width = 80; width <= 200; width += 1) {
			expect(occupied(layoutColumns(columns(), width))).toBe(width);
		}
	});

	test("drops the lowest-priority columns first", () => {
		const ids = (width: number) =>
			layoutColumns(columns(), width).map((c) => c.column.id);

		expect(ids(200)).toContain("java");
		// The natural total is 64 cells with gaps. At 60 only `java` (priority 20)
		// need go; at 50 `runtime` (30) follows, while `kind` (70) survives both.
		expect(ids(60)).not.toContain("java");
		expect(ids(60)).toContain("runtime");
		const at50 = ids(50);
		expect(at50).not.toContain("runtime");
		expect(at50).toContain("kind");
		expect(at50).toContain("state");
	});

	test("keeps required columns however narrow it gets", () => {
		const ids = layoutColumns(columns(), 8).map((c) => c.column.id);
		expect(ids).toContain("id");
		expect(ids.length).toBeGreaterThanOrEqual(1);
	});

	test("gives every column at least one cell", () => {
		for (const width of [1, 2, 5, 10, 20]) {
			for (const resolved of layoutColumns(columns(), width)) {
				expect(resolved.width).toBeGreaterThanOrEqual(1);
			}
		}
	});

	test("hands the whole leftover to the single flexible column", () => {
		const resolved = layoutColumns(columns(), 120);
		const id = resolved.find((c) => c.column.id === "id");
		// Everything else is fixed, so `id` absorbs all of the slack.
		const fixed = resolved
			.filter((c) => c.column.id !== "id")
			.reduce((sum, c) => sum + c.width, 0);
		expect(id?.width).toBe(120 - fixed - (resolved.length - 1));
	});

	test("splits the leftover between flexible columns by weight", () => {
		const twoFlex: TableColumn<unknown>[] = [
			{ id: "a", header: "a", min: 4, flex: 1, render: () => "" },
			{ id: "b", header: "b", min: 4, flex: 3, render: () => "" },
		];
		const [a, b] = layoutColumns(twoFlex, 41);
		// 41 - 1 gap - 8 natural = 32 spare, split 1:3.
		expect(a?.width).toBe(4 + 8);
		expect(b?.width).toBe(4 + 24);
	});

	test("caps a flexible column at its max and re-hands the rest", () => {
		const capped: TableColumn<unknown>[] = [
			{ id: "a", header: "a", min: 4, flex: 1, max: 10, render: () => "" },
			{ id: "b", header: "b", min: 4, flex: 1, render: () => "" },
		];
		const [a, b] = layoutColumns(capped, 61);
		expect(a?.width).toBe(10);
		// `b` is uncapped, so it absorbs everything `a` could not take and the row
		// still ends exactly on the available width.
		expect(b?.width).toBe(50);
	});

	test("leaves a gap only when every flexible column is capped", () => {
		const capped: TableColumn<unknown>[] = [
			{ id: "a", header: "a", min: 4, flex: 1, max: 6, render: () => "" },
			{ id: "b", header: "b", min: 4, flex: 1, max: 6, render: () => "" },
		];
		expect(occupied(layoutColumns(capped, 100))).toBe(13);
	});

	test("returns nothing for an empty column set or no space", () => {
		expect(layoutColumns([], 100)).toEqual([]);
		expect(layoutColumns(columns(), 0)).toEqual([]);
	});
});

describe("fitCell", () => {
	test("pads a short value to exactly the column width", () => {
		expect(fitCell("ok", 6, "…")).toBe("ok    ");
		expect(fitCell("ok", 6, "…", "right")).toBe("    ok");
	});

	test("truncates with the marker and still occupies exactly the width", () => {
		expect(fitCell("survival-world", 8, "…")).toBe("surviva…");
		expect(fitCell("survival-world", 8, "…")).toHaveLength(8);
	});

	test("subtracts the marker's own length, not one cell", () => {
		// The ASCII icon set spells the ellipsis "...", which is the case that
		// broke alignment when the marker length was assumed to be 1.
		const cell = fitCell("survival-world", 8, "...");
		expect(cell).toBe("survi...");
		expect(cell).toHaveLength(8);
	});

	test("never overflows even when the marker is wider than the column", () => {
		expect(fitCell("abcdef", 2, "...")).toHaveLength(2);
	});
});
