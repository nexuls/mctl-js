/**
 * Regression tests for {@link installBoxClipPatch}.
 *
 * Two things must hold:
 *  1. **Fidelity** — with nothing clipping it, a patched box renders exactly what
 *     the unpatched native path renders, glyphs *and* colours. The patch is only
 *     allowed to change *where* drawing stops, never how it looks.
 *  2. **Clipping** — a bordered box inside a scrollbox must not paint outside the
 *     scrollbox viewport, at any scroll offset.
 *
 * Note both must run in the same process as the code under test: `@opentui/core`
 * resolves to a different copy for files outside the project, and patching one
 * copy's prototype does nothing to the other. Keep these tests inside `src/`.
 */

import { describe, expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { installBoxClipPatch } from "./box-clip-patch.ts";

/** Box configurations that exercise every branch of the native box drawing. */
const BOX_CASES = [
	{ label: "title left", border: true, title: "Ttl", borderColor: "#7aa2f7", titleColor: "#ff0000" },
	{ label: "title centered", border: true, title: "Ttl", titleAlignment: "center" as const },
	{ label: "title right", border: true, title: "Ttl", titleAlignment: "right" as const },
	{ label: "bottom title", border: true, bottomTitle: "Bt", bottomTitleAlignment: "center" as const },
	{ label: "bottom side only", border: ["bottom"] as const },
	{ label: "top and left sides", border: ["top", "left"] as const },
	{ label: "rounded", border: true, borderStyle: "rounded" as const, title: "R" },
	{ label: "double with background", border: true, borderStyle: "double" as const, backgroundColor: "#203040" },
	{ label: "translucent background", border: true, backgroundColor: "#20304080" },
	{ label: "no border, background only", border: false, backgroundColor: "#402030" },
];

/** Render one box unclipped and return its styled spans (glyphs + colours). */
async function renderBox(options: Record<string, unknown>): Promise<string> {
	const { renderer, renderOnce, flush, captureSpans } = await createTestRenderer({ width: 16, height: 6 });
	const box = new BoxRenderable(renderer, {
		id: "b",
		width: 12,
		height: 4,
		position: "absolute",
		left: 1,
		top: 1,
		...options,
	});
	box.add(new TextRenderable(renderer, { id: "t", content: "inner" }));
	renderer.root.add(box);
	await renderOnce();
	await flush();
	const spans = JSON.stringify(captureSpans());
	renderer.destroy();
	return spans;
}

/**
 * Render bordered boxes inside a scrollbox that sits between a header and a
 * footer, scrolled to `scrollTop`, and return the frame as text.
 */
async function renderScrolled(scrollTop: number): Promise<string[]> {
	const { renderer, renderOnce, flush, captureCharFrame } = await createTestRenderer({ width: 34, height: 14 });

	const column = new BoxRenderable(renderer, { id: "col", flexDirection: "column", flexGrow: 1 });
	const header = new BoxRenderable(renderer, { id: "hdr", flexShrink: 0, border: ["bottom"] });
	header.add(new TextRenderable(renderer, { id: "ht", content: "HEADER" }));
	column.add(header);

	const scrollbox = new ScrollBoxRenderable(renderer, { id: "sb", flexGrow: 1, padding: 1 });
	for (let i = 0; i < 5; i++) {
		const section = new BoxRenderable(renderer, {
			id: `b${i}`,
			border: true,
			title: `sec ${i}`,
			padding: 1,
			marginBottom: 1,
			flexShrink: 0,
		});
		section.add(new TextRenderable(renderer, { id: `r${i}`, content: `row ${i}` }));
		scrollbox.add(section);
	}
	column.add(scrollbox);

	const footer = new BoxRenderable(renderer, { id: "ftr", flexShrink: 0, border: ["top"] });
	footer.add(new TextRenderable(renderer, { id: "ft", content: "FOOTER" }));
	column.add(footer);
	renderer.root.add(column);

	await renderOnce();
	await flush();
	scrollbox.scrollTo(scrollTop);
	await renderOnce();
	await flush();
	const lines = captureCharFrame().split("\n");
	renderer.destroy();
	return lines;
}

describe("box clip patch", () => {
	test("unclipped boxes render identically before and after patching", async () => {
		const before: string[] = [];
		for (const { label: _label, ...options } of BOX_CASES) {
			before.push(await renderBox(options));
		}

		installBoxClipPatch();

		for (const [index, { label, ...options }] of BOX_CASES.entries()) {
			expect(`${label}: ${await renderBox(options)}`).toBe(`${label}: ${before[index]}`);
		}
	});

	test("bordered boxes in a scrollbox never paint over the header or footer", async () => {
		installBoxClipPatch();

		// Frame rows 0/1 are the header, row 12 is its own border and row 13 the
		// footer; only the scrollbox viewport lies between. Border glyphs leaking
		// out of the viewport land on exactly those rows.
		for (const scrollTop of [0, 2, 5, 9, 14]) {
			const lines = await renderScrolled(scrollTop);
			const outside = [lines[0], lines[1], lines[12], lines[13]].join("\n");
			expect(`scrollTop ${scrollTop}: ${outside}`).not.toMatch(/[│┌┐└┘]/);
		}
	});
});
