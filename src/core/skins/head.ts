/**
 * head — turn a Minecraft skin PNG into the 8×8 {@link HeadSkin} MCTL renders.
 *
 * Core service, UI-free and network-free: it is handed bytes and returns a view
 * model. Fetching lives in `sources.ts`, rendering in
 * `components/MinecraftHead.tsx`.
 *
 * **Skin texture layout.** Every Minecraft skin, in both the legacy 64×32 and
 * the modern 64×64 layout, puts the head's *front* face at (8,8)–(16,16) and the
 * matching hat/helmet overlay at (40,8)–(48,16). That is already exactly the
 * 8×8 grid we want, so the common case is a crop with no resampling at all —
 * which is what "prefer 8×8" means here: we take the source's own 8×8 head
 * pixels rather than downscaling a rendered avatar.
 * https://minecraft.wiki/w/Skin#Format
 *
 * **HD skins** (128×128, 256×256, …) are the same layout at an integer scale, so
 * each output pixel samples the centre of its scale×scale block. That is nearest
 * neighbour, not an average, and it is the right choice: Minecraft art is flat
 * blocks of colour, and averaging would smear the eye and mouth outlines into
 * mud at 8×8.
 */

import { decodePng, type PngImage } from "../../lib/png.ts";
import { HEAD_SIZE, type HeadSkin } from "../../types/skin.ts";

/** The reference skin width every offset below is expressed against. */
const REFERENCE_WIDTH = 64;

/** Top-left of the front of the head, in reference-scale pixels. */
const FACE_ORIGIN = { x: 8, y: 8 };

/** Top-left of the hat/helmet overlay layer, in reference-scale pixels. */
const HAT_ORIGIN = { x: 40, y: 8 };

/**
 * Alpha at or above which an overlay pixel is drawn. Minecraft treats the hat
 * layer as a binary mask rather than blending it, and skins in the wild use
 * values like 254 for "opaque", so a threshold is more faithful than an
 * alpha blend.
 */
const HAT_ALPHA_THRESHOLD = 128;

/**
 * Codes used to key a {@link HeadSkin} palette, one char per distinct colour.
 * An 8×8 face has at most 64 distinct colours, which is exactly this many.
 */
const PALETTE_CODES =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-";

/** Thrown when a fetched image is not usable as a Minecraft skin. */
export class SkinFormatError extends Error {
	constructor(message: string) {
		super(`not a usable Minecraft skin: ${message}`);
		this.name = "SkinFormatError";
	}
}

/** `#rrggbb` for one byte triple. */
function hex(r: number, g: number, b: number): string {
	const part = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${part(r)}${part(g)}${part(b)}`;
}

/** Read one RGBA pixel, or `undefined` when the coordinate is out of bounds. */
function pixelAt(
	image: PngImage,
	x: number,
	y: number,
): [number, number, number, number] | undefined {
	if (x < 0 || y < 0 || x >= image.width || y >= image.height) return undefined;
	const at = (y * image.width + x) * 4;
	return [
		image.pixels[at] as number,
		image.pixels[at + 1] as number,
		image.pixels[at + 2] as number,
		image.pixels[at + 3] as number,
	];
}

/**
 * Extract the 8×8 head face — base layer with the hat overlay composited on top
 * — from a decoded skin texture.
 *
 * @throws {@link SkinFormatError} when the image is not a whole multiple of the
 *   64-wide reference layout, or is too short to contain a head.
 */
export function headSkinFromImage(image: PngImage): HeadSkin {
	const scale = image.width / REFERENCE_WIDTH;
	if (!Number.isInteger(scale) || scale < 1) {
		throw new SkinFormatError(
			`width ${image.width} is not a multiple of ${REFERENCE_WIDTH}`,
		);
	}
	// 64×32 (legacy) and 64×64 (modern) are the two real heights; both carry the
	// head in their top half, so the check is only that the head fits at all.
	if (image.height < (FACE_ORIGIN.y + HEAD_SIZE) * scale) {
		throw new SkinFormatError(`height ${image.height} has no head region`);
	}

	// Sample the centre of each scale×scale block rather than its corner: on an
	// HD skin the corner sits on the seam between two source pixels.
	const offset = Math.floor(scale / 2);

	const palette: Record<string, string> = {};
	const codeOf = new Map<string, string>();
	const face: string[] = [];

	for (let y = 0; y < HEAD_SIZE; y += 1) {
		let row = "";
		for (let x = 0; x < HEAD_SIZE; x += 1) {
			const sx = (FACE_ORIGIN.x + x) * scale + offset;
			const sy = (FACE_ORIGIN.y + y) * scale + offset;
			const base = pixelAt(image, sx, sy);
			if (!base) throw new SkinFormatError("head region is out of bounds");
			let [r, g, b] = base;

			const hat = pixelAt(
				image,
				(HAT_ORIGIN.x + x) * scale + offset,
				(HAT_ORIGIN.y + y) * scale + offset,
			);
			if (hat && hat[3] >= HAT_ALPHA_THRESHOLD) {
				r = hat[0];
				g = hat[1];
				b = hat[2];
			}

			const colour = hex(r, g, b);
			let code = codeOf.get(colour);
			if (code === undefined) {
				// Cannot overflow: 64 pixels, 64 codes. Guarded anyway so a future
				// larger face fails loudly instead of writing `undefined` into a row.
				code = PALETTE_CODES[codeOf.size];
				if (code === undefined)
					throw new SkinFormatError("more distinct colours than palette codes");
				codeOf.set(colour, code);
				palette[code] = colour;
			}
			row += code;
		}
		face.push(row);
	}

	return { palette, face };
}

/**
 * Decode skin PNG bytes and extract the head face.
 *
 * @throws {@link import("../../lib/png").PngError} for undecodable bytes and
 *   {@link SkinFormatError} for an image that decodes but is not a skin.
 */
export function headSkinFromPng(bytes: Uint8Array): HeadSkin {
	return headSkinFromImage(decodePng(bytes));
}
