/**
 * Tests for head extraction — the crop, the hat overlay, and HD scaling.
 *
 * Fixtures are synthetic skin *images* rather than PNG bytes: `lib/png.test.ts`
 * already pins decoding, and building a `PngImage` directly keeps each case
 * about the skin layout instead of about the file format.
 */

import { describe, expect, test } from "bun:test";
import type { PngImage } from "../../lib/png.ts";
import { HeadSkinSchema } from "../../types/skin.ts";
import { headSkinFromImage, SkinFormatError } from "./head.ts";

/**
 * A blank skin texture: opaque black everywhere, except a **transparent hat
 * layer**, which is how a real skin with no helmet detail is drawn. Leaving the
 * overlay opaque would make every fixture render as a black square.
 */
function blankSkin(width = 64, height = 64): PngImage {
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
	const image: PngImage = { width, height, pixels };
	const scale = width / 64;
	for (let y = 8 * scale; y < 16 * scale; y += 1) {
		for (let x = 40 * scale; x < 48 * scale; x += 1) {
			pixels[(y * width + x) * 4 + 3] = 0;
		}
	}
	return image;
}

function setPixel(
	image: PngImage,
	x: number,
	y: number,
	rgba: [number, number, number, number],
): void {
	const at = (y * image.width + x) * 4;
	image.pixels.set(rgba, at);
}

/** The `#rrggbb` a face position resolves to, through the palette. */
function colourAt(
	skin: { palette: Record<string, string>; face: string[] },
	x: number,
	y: number,
): string {
	const code = (skin.face[y] as string)[x] as string;
	return skin.palette[code] as string;
}

describe("headSkinFromImage", () => {
	test("crops the 8x8 face from (8,8) with no resampling", () => {
		const image = blankSkin();
		// A distinct colour per face pixel, encoded as its coordinates.
		for (let y = 0; y < 8; y += 1) {
			for (let x = 0; x < 8; x += 1) {
				setPixel(image, 8 + x, 8 + y, [x * 16 + 1, y * 16 + 1, 200, 255]);
			}
		}
		const skin = headSkinFromImage(image);
		expect(skin.face).toHaveLength(8);
		for (let y = 0; y < 8; y += 1) {
			for (let x = 0; x < 8; x += 1) {
				const expected = `#${(x * 16 + 1).toString(16).padStart(2, "0")}${(y * 16 + 1).toString(16).padStart(2, "0")}c8`;
				expect(colourAt(skin, x, y)).toBe(expected);
			}
		}
	});

	test("composites an opaque hat pixel over the face beneath it", () => {
		const image = blankSkin();
		setPixel(image, 8, 8, [10, 10, 10, 255]);
		setPixel(image, 40, 8, [255, 0, 0, 255]);
		expect(colourAt(headSkinFromImage(image), 0, 0)).toBe("#ff0000");
	});

	test("ignores a transparent hat pixel", () => {
		const image = blankSkin();
		setPixel(image, 8, 8, [10, 20, 30, 255]);
		setPixel(image, 40, 8, [255, 0, 0, 0]);
		expect(colourAt(headSkinFromImage(image), 0, 0)).toBe("#0a141e");
	});

	test("treats the hat layer as a mask, not a blend", () => {
		// A hat pixel just over the threshold paints its own colour outright — a
		// blend would produce a mixture and no skin would render as its author drew
		// it, since real skins use values like 254 for "opaque".
		const image = blankSkin();
		setPixel(image, 8, 8, [0, 0, 0, 255]);
		setPixel(image, 40, 8, [200, 100, 50, 128]);
		expect(colourAt(headSkinFromImage(image), 0, 0)).toBe("#c86432");

		// One below the threshold is dropped entirely.
		setPixel(image, 40, 8, [200, 100, 50, 127]);
		expect(colourAt(headSkinFromImage(image), 0, 0)).toBe("#000000");
	});

	test("reads a legacy 64x32 skin, whose head is in the same place", () => {
		const image = blankSkin(64, 32);
		setPixel(image, 12, 11, [1, 2, 3, 255]);
		expect(colourAt(headSkinFromImage(image), 4, 3)).toBe("#010203");
	});

	test("samples the block centre on an HD skin rather than its corner", () => {
		// 128x128 = scale 2. The face pixel at (0,0) covers source (16,16)-(18,18);
		// the corner and the centre are given different colours, and only the
		// centre may win — a corner sample sits on the seam between two pixels.
		const image = blankSkin(128, 128);
		setPixel(image, 16, 16, [255, 255, 255, 255]);
		setPixel(image, 17, 17, [12, 34, 56, 255]);
		expect(colourAt(headSkinFromImage(image), 0, 0)).toBe("#0c2238");
	});

	test("produces a face the HeadSkin schema accepts", () => {
		const image = blankSkin();
		for (let y = 0; y < 8; y += 1) {
			for (let x = 0; x < 8; x += 1) {
				setPixel(image, 8 + x, 8 + y, [x * 30, y * 30, 0, 255]);
			}
		}
		const parsed = HeadSkinSchema.safeParse(headSkinFromImage(image));
		expect(parsed.success).toBe(true);
	});

	test("a 64-colour face still fits the palette alphabet", () => {
		// The worst case: every one of the 64 pixels a different colour. One code
		// short and the face would carry `undefined`.
		const image = blankSkin();
		for (let index = 0; index < 64; index += 1) {
			setPixel(image, 8 + (index % 8), 8 + Math.floor(index / 8), [
				index * 4,
				255 - index * 3,
				index,
				255,
			]);
		}
		const skin = headSkinFromImage(image);
		expect(Object.keys(skin.palette)).toHaveLength(64);
		expect(HeadSkinSchema.safeParse(skin).success).toBe(true);
	});

	test("collapses repeated colours to one palette entry", () => {
		const skin = headSkinFromImage(blankSkin());
		expect(Object.keys(skin.palette)).toEqual(["A"]);
		expect(skin.face.every((row) => row === "AAAAAAAA")).toBe(true);
	});

	test("rejects an image that is not a multiple of the 64-wide layout", () => {
		expect(() => headSkinFromImage(blankSkin(100, 100))).toThrow(
			SkinFormatError,
		);
	});

	test("rejects an image too short to hold a head", () => {
		expect(() => headSkinFromImage(blankSkin(64, 8))).toThrow(SkinFormatError);
	});
});
