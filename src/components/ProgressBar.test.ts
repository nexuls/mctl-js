/**
 * Unit tests for {@link "./ProgressBar"}'s pure layout helpers.
 *
 * These are the parts that decide what a bar actually looks like, so they are
 * tested without a renderer: glyph runs must always total the track width (a
 * short run would let the surrounding layout shift), and the sweep must stay
 * inside the track for every frame.
 */

import { describe, expect, test } from "bun:test";
import {
	PROGRESS_STYLES,
	fillGlyphs,
	indeterminateGlyphs,
	thresholdVariant,
	type ProgressBarStyle,
} from "./ProgressBar.tsx";

const STYLES = Object.keys(PROGRESS_STYLES) as ProgressBarStyle[];

describe("fillGlyphs", () => {
	test("empty and full tracks are exactly the track width", () => {
		for (const style of STYLES) {
			const glyphs = PROGRESS_STYLES[style];
			const empty = fillGlyphs(0, 10, glyphs);
			expect(empty.filled).toBe("");
			expect([...empty.empty]).toHaveLength(10);

			const full = fillGlyphs(1, 10, glyphs);
			expect([...full.filled]).toHaveLength(10);
			expect(full.empty).toBe("");
		}
	});

	test("runs always total the track width, at every fraction", () => {
		for (const style of STYLES) {
			const glyphs = PROGRESS_STYLES[style];
			for (let i = 0; i <= 40; i++) {
				const { filled, empty } = fillGlyphs(i / 40, 13, glyphs);
				expect([...filled].length + [...empty].length).toBe(13);
			}
		}
	});

	test("a started bar always inks a cell, and an unfinished one never looks finished", () => {
		for (const style of STYLES) {
			const glyphs = PROGRESS_STYLES[style];
			expect(fillGlyphs(0.001, 20, glyphs).filled.length).toBeGreaterThan(0);

			const nearlyDone = fillGlyphs(0.999, 20, glyphs);
			if (glyphs.partials) {
				// A sub-cell style can occupy every cell and still read as unfinished,
				// because its leading cell is a partial glyph rather than a full block.
				expect(nearlyDone.filled.endsWith(glyphs.fill)).toBe(false);
			} else {
				expect(nearlyDone.empty.length).toBeGreaterThan(0);
			}
		}
	});

	test("smooth style renders sub-cell steps in the leading cell", () => {
		const glyphs = PROGRESS_STYLES.smooth;
		// Half of one cell in an 8-cell track = 4 full cells and nothing partial.
		expect(fillGlyphs(0.5, 8, glyphs).filled).toBe("████");
		// 4/8 of a cell past four full cells → the half-block partial.
		expect(fillGlyphs(4.5 / 8, 8, glyphs).filled).toBe("████▌");
		// Whole-cell styles cannot express that and round instead.
		expect(fillGlyphs(4.5 / 8, 8, PROGRESS_STYLES.blocks).filled).toBe("█████");
	});

	test("smooth-line steps in halves, the only sub-cell step a rule has", () => {
		const glyphs = PROGRESS_STYLES["smooth-line"];
		expect(fillGlyphs(4 / 8, 8, glyphs).filled).toBe("━━━━");
		// A further half-cell shows the heavy-left rule rather than rounding up.
		expect(fillGlyphs(4.5 / 8, 8, glyphs).filled).toBe("━━━━╸");
		// Under half a cell past a whole one still rounds down to nothing extra.
		expect(fillGlyphs(4.2 / 8, 8, glyphs).filled).toBe("━━━━");
		expect(fillGlyphs(4.6 / 8, 8, glyphs).filled).toBe("━━━━╸");
		// Whereas the whole-cell `line` style rounds both of those to five cells.
		expect(fillGlyphs(4.6 / 8, 8, PROGRESS_STYLES.line).filled).toBe("━━━━━");
	});

	test("a zero-width track renders nothing", () => {
		expect(fillGlyphs(0.5, 0, PROGRESS_STYLES.blocks)).toEqual({
			filled: "",
			empty: "",
		});
	});

	test("out-of-range values are clamped", () => {
		const glyphs = PROGRESS_STYLES.blocks;
		expect(fillGlyphs(-2, 6, glyphs)).toEqual(fillGlyphs(0, 6, glyphs));
		expect(fillGlyphs(7, 6, glyphs)).toEqual(fillGlyphs(1, 6, glyphs));
	});
});

describe("indeterminateGlyphs", () => {
	test("the three runs total the track width on every frame", () => {
		const glyphs = PROGRESS_STYLES.blocks;
		for (let frame = 0; frame < 100; frame++) {
			const { lead, lit, trail } = indeterminateGlyphs(frame, 16, glyphs);
			expect(lead.length + lit.length + trail.length).toBe(16);
			expect(lit.length).toBeGreaterThan(0);
		}
	});

	test("the window bounces rather than wrapping", () => {
		const glyphs = PROGRESS_STYLES.blocks;
		const offsets: number[] = [];
		for (let frame = 0; frame <= 24; frame++) {
			offsets.push(indeterminateGlyphs(frame, 16, glyphs).lead.length);
		}
		// 16 cells → a 4-cell window with 12 cells of travel: out to the far end by
		// frame 12, then back to the start by frame 24.
		expect(offsets[0]).toBe(0);
		expect(offsets[12]).toBe(12);
		expect(offsets[24]).toBe(0);
		// No frame-to-frame jump larger than one cell (a wrap would jump 12).
		for (let i = 1; i < offsets.length; i++) {
			expect(Math.abs((offsets[i] ?? 0) - (offsets[i - 1] ?? 0))).toBe(1);
		}
	});

	test("a track no wider than the window is fully lit", () => {
		const { lead, lit, trail } = indeterminateGlyphs(
			5,
			2,
			PROGRESS_STYLES.blocks,
		);
		expect(lit).toBe("██");
		expect(lead + trail).toBe("");
	});
});

describe("thresholdVariant", () => {
	const thresholds = [
		{ at: 0, variant: "success" as const },
		{ at: 0.75, variant: "warning" as const },
		{ at: 0.9, variant: "error" as const },
	];

	test("the highest threshold at or below the fraction wins", () => {
		expect(thresholdVariant(0, "primary", thresholds)).toBe("success");
		expect(thresholdVariant(0.74, "primary", thresholds)).toBe("success");
		expect(thresholdVariant(0.75, "primary", thresholds)).toBe("warning");
		expect(thresholdVariant(1, "primary", thresholds)).toBe("error");
	});

	test("order does not matter", () => {
		const shuffled = [...thresholds].reverse();
		expect(thresholdVariant(0.8, "primary", shuffled)).toBe("warning");
	});

	test("the base variant stands when nothing matches", () => {
		expect(thresholdVariant(0.5, "info")).toBe("info");
		expect(thresholdVariant(0.5, "info", [])).toBe("info");
		expect(thresholdVariant(0.1, "info", [{ at: 0.5, variant: "error" }])).toBe(
			"info",
		);
	});
});
