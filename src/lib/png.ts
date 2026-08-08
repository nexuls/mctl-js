/**
 * png — a minimal, read-only PNG decoder producing straight RGBA pixels.
 *
 * Leaf helper (`lib/`): it knows nothing about servers, players or skins — it
 * turns bytes into pixels. UI-free; no `Bun.spawn`, no filesystem.
 *
 * **Why hand-rolled rather than a dependency.** The only images MCTL decodes are
 * Minecraft skins, which are tiny (64×32 or 64×64, occasionally an HD multiple)
 * non-interlaced truecolour-with-alpha PNGs. A general image library would be
 * two orders of magnitude more code than the ~150 lines below for a format whose
 * whole specification here is "inflate, unfilter, expand".
 *
 * **What is supported:** bit depths 1/2/4/8/16 across every colour type
 * (greyscale, truecolour, indexed, greyscale+alpha, truecolour+alpha), `tRNS`
 * transparency for the indexed and non-alpha types, and multiple `IDAT` chunks.
 * 16-bit samples are truncated to their high byte — the caller quantises to a
 * terminal colour anyway, so the low byte cannot survive.
 *
 * **What is not:** Adam7 interlacing, which throws {@link PngError}. It is
 * legal PNG but essentially never used for a 64×64 texture, and supporting it
 * would double this file for output no skin source produces.
 *
 * Spec reference: https://www.w3.org/TR/png-3/ (§ 4 chunks, § 9 filtering).
 */

import { inflateSync } from "node:zlib";

/** The 8 bytes every PNG starts with (§ 5.2). */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Thrown when the input is not a PNG, is truncated, or uses an unsupported feature. */
export class PngError extends Error {
	constructor(message: string) {
		super(`invalid or unsupported PNG: ${message}`);
		this.name = "PngError";
	}
}

/** A decoded image: straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface PngImage {
	width: number;
	height: number;
	/** `width * height * 4` bytes: R, G, B, A per pixel, rows top to bottom. */
	pixels: Uint8Array;
}

/** Bytes per pixel of the *filtered* data, rounded up — the filter's `bpp` (§ 9.2). */
function filterStride(colourType: number, bitDepth: number): number {
	const samples =
		colourType === 0 || colourType === 3
			? 1
			: colourType === 2
				? 3
				: colourType === 4
					? 2
					: 4;
	return Math.max(1, Math.ceil((samples * bitDepth) / 8));
}

/** Samples per pixel for a colour type. */
function sampleCount(colourType: number): number {
	switch (colourType) {
		case 0:
			return 1;
		case 2:
			return 3;
		case 3:
			return 1;
		case 4:
			return 2;
		case 6:
			return 4;
		default:
			throw new PngError(`colour type ${colourType}`);
	}
}

/**
 * Reverse the per-scanline filters in place (§ 9.2). Each row in `raw` is one
 * filter-type byte followed by `rowBytes` of filtered data; the result is the
 * same rows with the filter bytes removed.
 */
function unfilter(
	raw: Uint8Array,
	rowBytes: number,
	height: number,
	bpp: number,
): Uint8Array {
	const out = new Uint8Array(rowBytes * height);
	let src = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = raw[src];
		src += 1;
		const row = y * rowBytes;
		const prior = row - rowBytes;
		for (let x = 0; x < rowBytes; x += 1) {
			const value = raw[src + x] as number;
			// `a` = the byte one pixel to the left, `b` = the byte above,
			// `c` = the byte above-left; each is 0 outside the image.
			const a = x >= bpp ? (out[row + x - bpp] as number) : 0;
			const b = y > 0 ? (out[prior + x] as number) : 0;
			const c = y > 0 && x >= bpp ? (out[prior + x - bpp] as number) : 0;
			let restored: number;
			switch (filter) {
				case 0:
					restored = value;
					break;
				case 1:
					restored = value + a;
					break;
				case 2:
					restored = value + b;
					break;
				case 3:
					restored = value + ((a + b) >> 1);
					break;
				case 4: {
					// Paeth predictor: pick whichever neighbour the gradient a+b-c is
					// closest to (§ 9.4).
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default:
					throw new PngError(`filter type ${filter} on row ${y}`);
			}
			out[row + x] = restored & 0xff;
		}
		src += rowBytes;
	}
	return out;
}

/**
 * Read the `index`-th sample of a row at an arbitrary bit depth, scaled up to
 * the 0–255 range the output uses.
 *
 * Sub-byte depths pack several samples per byte, most-significant first (§ 7.2);
 * a depth-1 sample of 1 must become 255, not 1, hence the scaling multipliers.
 */
function sampleAt(
	row: Uint8Array,
	offset: number,
	index: number,
	bitDepth: number,
): number {
	switch (bitDepth) {
		case 8:
			return row[offset + index] as number;
		case 16:
			// High byte only: the caller quantises to a terminal colour regardless.
			return row[offset + index * 2] as number;
		case 1:
		case 2:
		case 4: {
			const perByte = 8 / bitDepth;
			const byte = row[offset + Math.floor(index / perByte)] as number;
			const shift = 8 - bitDepth * ((index % perByte) + 1);
			const raw = (byte >> shift) & ((1 << bitDepth) - 1);
			return raw * (255 / ((1 << bitDepth) - 1));
		}
		default:
			throw new PngError(`bit depth ${bitDepth}`);
	}
}

/** Raw (unscaled) sample value — what a palette index needs. */
function rawSampleAt(row: Uint8Array, index: number, bitDepth: number): number {
	if (bitDepth === 8) return row[index] as number;
	if (bitDepth === 16) return row[index * 2] as number;
	const perByte = 8 / bitDepth;
	const byte = row[Math.floor(index / perByte)] as number;
	const shift = 8 - bitDepth * ((index % perByte) + 1);
	return (byte >> shift) & ((1 << bitDepth) - 1);
}

/**
 * Decode a PNG into straight RGBA pixels.
 *
 * @throws {@link PngError} when the bytes are not a PNG, are truncated, or use
 *   Adam7 interlacing.
 */
export function decodePng(bytes: Uint8Array): PngImage {
	for (let i = 0; i < SIGNATURE.length; i += 1) {
		if (bytes[i] !== SIGNATURE[i]) throw new PngError("bad signature");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let width = 0;
	let height = 0;
	let bitDepth = 8;
	let colourType = 6;
	let palette: Uint8Array | undefined;
	let paletteAlpha: Uint8Array | undefined;
	/** `tRNS` for greyscale / truecolour: the single fully-transparent sample. */
	let transparent: number[] | undefined;
	const idat: Uint8Array[] = [];

	// Chunk layout: 4-byte length, 4-byte type, `length` bytes of data, 4-byte CRC.
	// The CRC is deliberately not verified — a corrupt skin fails at inflate or
	// renders wrong, and neither is worth a CRC table here.
	let at = 8;
	while (at + 8 <= bytes.length) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(
			bytes[at + 4] as number,
			bytes[at + 5] as number,
			bytes[at + 6] as number,
			bytes[at + 7] as number,
		);
		const start = at + 8;
		const end = start + length;
		if (end > bytes.length) throw new PngError(`truncated ${type} chunk`);

		switch (type) {
			case "IHDR": {
				width = view.getUint32(start);
				height = view.getUint32(start + 4);
				bitDepth = bytes[start + 8] as number;
				colourType = bytes[start + 9] as number;
				if (bytes[start + 12] !== 0) throw new PngError("Adam7 interlacing");
				break;
			}
			case "PLTE":
				palette = bytes.subarray(start, end);
				break;
			case "tRNS":
				if (colourType === 3) paletteAlpha = bytes.subarray(start, end);
				else if (colourType === 0) transparent = [view.getUint16(start)];
				else if (colourType === 2)
					transparent = [
						view.getUint16(start),
						view.getUint16(start + 2),
						view.getUint16(start + 4),
					];
				break;
			case "IDAT":
				idat.push(bytes.subarray(start, end));
				break;
			case "IEND":
				at = bytes.length;
				break;
		}
		if (at !== bytes.length) at = end + 4;
	}

	if (width <= 0 || height <= 0) throw new PngError("missing or empty IHDR");
	if (idat.length === 0) throw new PngError("no IDAT data");

	const compressed = Buffer.concat(idat.map((part) => Buffer.from(part)));
	let inflated: Uint8Array;
	try {
		inflated = new Uint8Array(inflateSync(compressed));
	} catch (err) {
		throw new PngError(`inflate failed: ${String(err)}`);
	}

	const samples = sampleCount(colourType);
	const rowBytes = Math.ceil((width * samples * bitDepth) / 8);
	if (inflated.length < (rowBytes + 1) * height) {
		throw new PngError("image data shorter than the declared dimensions");
	}
	const data = unfilter(
		inflated,
		rowBytes,
		height,
		filterStride(colourType, bitDepth),
	);

	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
		for (let x = 0; x < width; x += 1) {
			const out = (y * width + x) * 4;
			let r: number;
			let g: number;
			let b: number;
			let a = 255;
			switch (colourType) {
				case 0: {
					r = sampleAt(row, 0, x, bitDepth);
					g = r;
					b = r;
					if (transparent && rawSampleAt(row, x, bitDepth) === transparent[0])
						a = 0;
					break;
				}
				case 2: {
					r = sampleAt(row, 0, x * 3, bitDepth);
					g = sampleAt(row, 0, x * 3 + 1, bitDepth);
					b = sampleAt(row, 0, x * 3 + 2, bitDepth);
					if (
						transparent &&
						rawSampleAt(row, x * 3, bitDepth) === transparent[0] &&
						rawSampleAt(row, x * 3 + 1, bitDepth) === transparent[1] &&
						rawSampleAt(row, x * 3 + 2, bitDepth) === transparent[2]
					)
						a = 0;
					break;
				}
				case 3: {
					if (!palette) throw new PngError("indexed image with no PLTE");
					const index = rawSampleAt(row, x, bitDepth);
					r = palette[index * 3] ?? 0;
					g = palette[index * 3 + 1] ?? 0;
					b = palette[index * 3 + 2] ?? 0;
					a = paletteAlpha?.[index] ?? 255;
					break;
				}
				case 4: {
					r = sampleAt(row, 0, x * 2, bitDepth);
					g = r;
					b = r;
					a = sampleAt(row, 0, x * 2 + 1, bitDepth);
					break;
				}
				default: {
					r = sampleAt(row, 0, x * 4, bitDepth);
					g = sampleAt(row, 0, x * 4 + 1, bitDepth);
					b = sampleAt(row, 0, x * 4 + 2, bitDepth);
					a = sampleAt(row, 0, x * 4 + 3, bitDepth);
					break;
				}
			}
			pixels[out] = r;
			pixels[out + 1] = g;
			pixels[out + 2] = b;
			pixels[out + 3] = a;
		}
	}

	return { width, height, pixels };
}
