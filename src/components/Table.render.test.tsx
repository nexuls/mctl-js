/**
 * Table — the *rendered* geometry, as opposed to `Table.test.ts`, which covers
 * the pure column maths.
 *
 * What this pins is the seam between the two: a row draws inside a rounded
 * border with its own padding, so the cells it can paint are `ROW_CHROME` cells
 * narrower than the table's box, while the header draws outside that border and
 * pays for the same cells with padding of its own. When the two disagree by one
 * cell — as they did while the subtraction was a hand-tuned `- 3` — a flexible
 * column is laid out one cell too wide, the gap before it collapses, and the row
 * spills onto a second line. `layoutColumns` cannot see any of that: both halves
 * agree about the widths and disagree only about how much room there is.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { Table, type TableColumn } from "./Table.tsx";

interface Row {
	id: string;
	motd: string;
}

/** A fixed column beside a flexible one — the shape the Dashboard renders. */
const COLUMNS: TableColumn<Row>[] = [
	{ id: "id", header: "id", width: 6, required: true, render: (r) => r.id },
	{
		id: "motd",
		header: "motd",
		min: 4,
		flex: 1,
		required: true,
		render: (r) => r.motd,
	},
];

/** Text long enough that the flexible column is always filled to its width. */
const ROWS: Row[] = [{ id: "aaaaaa", motd: "M".repeat(80) }];

/** Mount a table of the given width and hand back the frame, line by line. */
async function frameOf(width: number, scrollRows = false): Promise<string[]> {
	const registry = await new ThemeRegistry().load();
	const harness = await createTestRenderer({ width: width + 10, height: 14 });
	createRoot(harness.renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<box width={width}>
				<Table
					columns={COLUMNS}
					rows={ROWS}
					keyOf={(r) => r.id}
					width={width}
					scrollRows={scrollRows}
				/>
			</box>
		</ThemeProvider>,
	);
	harness.renderOnce();
	// React's commit reaches the renderer a frame later; one render is a blank tree.
	await Bun.sleep(50);
	harness.renderOnce();
	return harness.captureCharFrame().split("\n");
}

/** Column at which `needle` starts on the first line that contains it. */
function columnOf(lines: string[], needle: string): number {
	for (const line of lines) {
		const at = line.indexOf(needle);
		if (at >= 0) return at;
	}
	throw new Error(`"${needle}" is not on screen`);
}

/** The single line holding the row's cells (the one between the border rows). */
function rowLine(lines: string[]): string {
	const line = lines.find((l) => l.includes("aaaaaa"));
	if (line === undefined) throw new Error("the row is not on screen");
	return line;
}

test("a header cell starts on the same column as the cells below it", async () => {
	const lines = await frameOf(40);
	expect(columnOf(lines, "ID")).toBe(columnOf(lines, "aaaaaa"));
	expect(columnOf(lines, "MOTD")).toBe(columnOf(lines, "MMM"));
});

test("the gap between columns survives a filled flexible column", async () => {
	// The one-cell overflow shows up here first: the flexible column eats the gap
	// and the row reads "aaaaaaMMMM…" with the two columns run together.
	expect(rowLine(await frameOf(30))).toContain("aaaaaa M");
});

test("a filled row still occupies exactly one line", async () => {
	// One cell too many wraps the row inside its own border, which silently
	// doubles the height of every row on the Dashboard.
	const lines = await frameOf(30);
	const cellLines = lines.filter((l) => l.includes("M".repeat(4)));
	expect(cellLines).toHaveLength(1);
});

test("the scrollbar reserve shifts header and rows together", async () => {
	// The rows lose the cell inside their own box; the header only loses it if it
	// is told to.
	const lines = await frameOf(40, true);
	expect(columnOf(lines, "ID")).toBe(columnOf(lines, "aaaaaa"));
	expect(rowLine(lines)).toContain("aaaaaa M");
});

test("nothing a row draws spills past the width it was given", async () => {
	const width = 24;
	const lines = await frameOf(width);
	for (const line of lines) {
		expect(line.trimEnd().length).toBeLessThanOrEqual(width);
	}
});

test("the geometry holds at every width the columns survive", async () => {
	// One width can agree by accident; the off-by-one moves with the terminal, so
	// sweep a range rather than picking a number.
	for (const width of [20, 24, 30, 36, 48, 64]) {
		const lines = await frameOf(width);
		expect([width, columnOf(lines, "ID")]).toEqual([
			width,
			columnOf(lines, "aaaaaa"),
		]);
		expect([width, rowLine(lines).includes("aaaaaa M")]).toEqual([width, true]);
	}
});
