/**
 * `FormGrid` — the packing maths, and the reflow it produces in a real frame.
 *
 * The pure half (`columnsFor`, `packRows`) is where the rules live; the rendered
 * half is what proves the rules reach the screen, because the column count comes
 * from a *measured* width and a component that never measures would pass every
 * pure test while rendering one column forever.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { Input } from "./Form.tsx";
import { columnsFor, FormGrid, FormGridItem, packRows } from "./FormGrid.tsx";

test("columnsFor counts the gaps between columns, not after them", () => {
	// Two 46-wide columns plus one 2-cell gap need 94, not 96.
	expect(columnsFor(94, 46, 2, 2)).toBe(2);
	expect(columnsFor(93, 46, 2, 2)).toBe(1);
	expect(columnsFor(200, 46, 2, 2)).toBe(2); // maxColumns wins
	expect(columnsFor(200, 46, 3, 2)).toBe(3);
});

test("an unmeasured width is one column", () => {
	// Before yoga's first pass the width reads 0. Guessing wide would truncate
	// every field for a frame; guessing narrow only under-uses the terminal.
	expect(columnsFor(0, 46, 2, 2)).toBe(1);
});

test("packRows fills row-major and never reorders", () => {
	expect(packRows([1, 1, 1, 1, 1], 2)).toEqual([[0, 1], [2, 3], [4]]);
	expect(packRows([1, 1, 1], 3)).toEqual([[0, 1, 2]]);
});

test("an item that does not fit starts a new row rather than jumping ahead", () => {
	// The full-width item at index 1 cannot share row 0, and the item after it
	// must not be pulled up into the space it left — declaration order is what
	// keeps the layout matching the page's Tab ring.
	expect(packRows([1, 2, 1, 1], 2)).toEqual([[0], [1], [2, 3]]);
});

test("a span wider than the grid is clamped, not dropped", () => {
	expect(packRows([3, 1], 2)).toEqual([[0], [1]]);
});

/** Mount a grid of two labelled fields at `width` and return the frame's lines. */
async function mount(width: number, extra?: React.ReactNode) {
	const registry = await new ThemeRegistry().load();
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width,
		height: 16,
	});
	createRoot(renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<FormGrid minColumnWidth={30}>
				<Input label="Alpha" value="a" width="100%" />
				<Input label="Bravo" value="b" width="100%" />
				{extra}
			</FormGrid>
		</ThemeProvider>,
	);
	renderOnce();
	// React commits a frame later, and the width the grid lays out against is only
	// known after yoga has run — so two settles, not one.
	await Bun.sleep(60);
	renderOnce();
	await Bun.sleep(60);
	renderOnce();
	return captureCharFrame().split("\n");
}

test("two fields share a row once the terminal is wide enough", async () => {
	const lines = await mount(90);
	const together = lines.filter(
		(line) => line.includes("Alpha") && line.includes("Bravo"),
	);
	expect(together.length).toBe(1);
});

test("the same two fields stack when there is only room for one column", async () => {
	const lines = await mount(40);
	expect(lines.some((l) => l.includes("Alpha"))).toBe(true);
	expect(lines.some((l) => l.includes("Bravo"))).toBe(true);
	expect(
		lines.some((line) => line.includes("Alpha") && line.includes("Bravo")),
	).toBe(false);
});

test("a full-span item keeps the whole row to itself", async () => {
	const lines = await mount(
		90,
		<FormGridItem span="full">
			<Input label="Charlie" value="c" width="100%" />
		</FormGridItem>,
	);
	expect(
		lines.some((line) => line.includes("Charlie") && line.includes("Alpha")),
	).toBe(false);
	// And it really is full width: its frame reaches close to the right edge,
	// unlike the half-width fields above it.
	const top = lines.find((line) => line.includes("Charlie")) ?? "";
	expect(top.trimEnd().length).toBeGreaterThan(80);
});
