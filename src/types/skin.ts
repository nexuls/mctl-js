/**
 * Skin types — the 8×8 head face MCTL renders for a player.
 *
 * A **head skin** is deliberately not an image. `components/MinecraftHead.tsx`
 * paints one terminal cell per two vertically-stacked pixels, so all it ever
 * needs is 64 colours; storing a face as a palette plus a grid of single-char
 * codes makes it a few hundred bytes of JSON that is cheap to cache, trivial to
 * hand-write (every built-in skin is written this way) and readable in a diff.
 *
 * Types + Zod only, no logic. `core/skins/` produces these from real skin PNGs;
 * `components/MinecraftHead.tsx` renders them.
 */

import { z } from "zod";

/** Width and height, in pixels, of the head face MCTL renders. */
export const HEAD_SIZE = 8;

/**
 * A head face: a colour palette keyed by single-char pixel codes, plus a
 * {@link HEAD_SIZE}×{@link HEAD_SIZE} grid (top row first) whose characters
 * index that palette.
 *
 * Invariant: every character of every `face` row is a key of `palette`. The
 * schema below enforces it — a cached face referencing a missing colour would
 * otherwise paint `undefined` into the frame buffer.
 */
export interface HeadSkin {
	/** Pixel code → `#rrggbb`. */
	palette: Record<string, string>;
	/** {@link HEAD_SIZE} rows of {@link HEAD_SIZE} chars each. */
	face: string[];
}

/**
 * Validates a {@link HeadSkin} read off disk (the skin cache) or built from an
 * upstream PNG. Boundary validation per AGENTS.md § 3 — nothing off disk or
 * network is trusted.
 */
export const HeadSkinSchema = z
	.object({
		palette: z.record(
			z.string().length(1),
			z.string().regex(/^#[0-9a-fA-F]{6}$/),
		),
		face: z.array(z.string().length(HEAD_SIZE)).length(HEAD_SIZE),
	})
	.refine(
		(skin) =>
			skin.face.every((row) =>
				[...row].every((code) => skin.palette[code] !== undefined),
			),
		{ message: "face references a pixel code missing from the palette" },
	);
