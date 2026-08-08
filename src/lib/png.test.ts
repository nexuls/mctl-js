/**
 * Tests for the PNG decoder.
 *
 * `lib/png.ts` has no encoder (MCTL only ever reads images), so these tests
 * carry a minimal one — which also keeps every fixture readable in the test
 * rather than being an opaque binary blob checked into the repo.
 *
 * The encoder writes filter type 0 (`None`) rows, so the filter cases are
 * exercised by a separate hand-built fixture that uses all five filter types on
 * consecutive rows.
 */

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, PngError } from "./png.ts";

// ---------------------------------------------------------------------------
// A tiny encoder: unfiltered scanlines, one IDAT.
// ---------------------------------------------------------------------------

/** CRC-32 over a buffer, as PNG chunks require (§ 5.3). */
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(
		crc32(Buffer.concat([head.subarray(4), Buffer.from(data)])),
	);
	return Buffer.concat([head, Buffer.from(data), crc]);
}

interface EncodeOptions {
	width: number;
	height: number;
	colourType: number;
	bitDepth: number;
	/** Already-filtered scanlines including their leading filter byte. */
	scanlines: Uint8Array;
	palette?: number[];
	transparency?: Uint8Array;
}

function encodePng(options: EncodeOptions): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(options.width, 0);
	ihdr.writeUInt32BE(options.height, 4);
	ihdr[8] = options.bitDepth;
	ihdr[9] = options.colourType;
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace

	const parts = [
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
	];
	if (options.palette)
		parts.push(chunk("PLTE", Uint8Array.from(options.palette)));
	if (options.transparency) parts.push(chunk("tRNS", options.transparency));
	parts.push(chunk("IDAT", deflateSync(Buffer.from(options.scanlines))));
	parts.push(chunk("IEND", new Uint8Array(0)));
	return new Uint8Array(Buffer.concat(parts));
}

/** Prefix each row of `rows` with a `None` filter byte. */
function unfiltered(rows: number[][]): Uint8Array {
	return Uint8Array.from(rows.flatMap((row) => [0, ...row]));
}

/** The RGBA quadruple at (x, y). */
function pixel(
	image: ReturnType<typeof decodePng>,
	x: number,
	y: number,
): number[] {
	const at = (y * image.width + x) * 4;
	return [...image.pixels.subarray(at, at + 4)];
}

// ---------------------------------------------------------------------------

describe("decodePng", () => {
	test("decodes 8-bit truecolour with alpha", () => {
		const png = encodePng({
			width: 2,
			height: 2,
			colourType: 6,
			bitDepth: 8,
			scanlines: unfiltered([
				[255, 0, 0, 255, 0, 255, 0, 128],
				[0, 0, 255, 255, 9, 8, 7, 0],
			]),
		});
		const image = decodePng(png);
		expect(image.width).toBe(2);
		expect(image.height).toBe(2);
		expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([0, 255, 0, 128]);
		expect(pixel(image, 0, 1)).toEqual([0, 0, 255, 255]);
		expect(pixel(image, 1, 1)).toEqual([9, 8, 7, 0]);
	});

	test("decodes 8-bit truecolour without alpha as fully opaque", () => {
		const png = encodePng({
			width: 2,
			height: 1,
			colourType: 2,
			bitDepth: 8,
			scanlines: unfiltered([[1, 2, 3, 4, 5, 6]]),
		});
		const image = decodePng(png);
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 0)).toEqual([4, 5, 6, 255]);
	});

	test("honours tRNS on a truecolour image", () => {
		const png = encodePng({
			width: 2,
			height: 1,
			colourType: 2,
			bitDepth: 8,
			scanlines: unfiltered([[1, 2, 3, 9, 9, 9]]),
			// tRNS for colour type 2 is three 16-bit samples.
			transparency: Uint8Array.from([0, 9, 0, 9, 0, 9]),
		});
		const image = decodePng(png);
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 0)).toEqual([9, 9, 9, 0]);
	});

	test("decodes an indexed image, including its palette alpha", () => {
		const png = encodePng({
			width: 3,
			height: 1,
			colourType: 3,
			bitDepth: 8,
			scanlines: unfiltered([[0, 1, 2]]),
			palette: [10, 20, 30, 40, 50, 60, 70, 80, 90],
			transparency: Uint8Array.from([255, 0]),
		});
		const image = decodePng(png);
		expect(pixel(image, 0, 0)).toEqual([10, 20, 30, 255]);
		expect(pixel(image, 1, 0)).toEqual([40, 50, 60, 0]);
		// A palette index past the end of tRNS is opaque, per the spec.
		expect(pixel(image, 2, 0)).toEqual([70, 80, 90, 255]);
	});

	test("decodes sub-byte indexed samples, packed high bits first", () => {
		// Four 2-bit samples in one byte: indices 0, 1, 2, 3.
		const png = encodePng({
			width: 4,
			height: 1,
			colourType: 3,
			bitDepth: 2,
			scanlines: unfiltered([[0b00_01_10_11]]),
			palette: [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3],
		});
		const image = decodePng(png);
		expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([1, 1, 1, 255]);
		expect(pixel(image, 2, 0)).toEqual([2, 2, 2, 255]);
		expect(pixel(image, 3, 0)).toEqual([3, 3, 3, 255]);
	});

	test("scales greyscale sub-byte samples to the full 0-255 range", () => {
		// Depth 1: a sample of 1 is white, not 1.
		const png = encodePng({
			width: 2,
			height: 1,
			colourType: 0,
			bitDepth: 1,
			scanlines: unfiltered([[0b01_000000]]),
		});
		const image = decodePng(png);
		expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([255, 255, 255, 255]);
	});

	test("truncates 16-bit samples to their high byte", () => {
		const png = encodePng({
			width: 1,
			height: 1,
			colourType: 2,
			bitDepth: 16,
			scanlines: unfiltered([[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]]),
		});
		expect(pixel(decodePng(png), 0, 0)).toEqual([0x12, 0x56, 0x9a, 255]);
	});

	test("reverses all five scanline filters", () => {
		// Five rows of one RGBA pixel each, one row per filter type. Every row is
		// encoded so that it decodes back to the same colour, which makes a wrong
		// predictor visible as a colour change rather than as noise.
		const target = [40, 80, 120, 255];
		const rows: number[][] = [];
		let previous = [0, 0, 0, 0];
		for (const filter of [0, 1, 2, 3, 4]) {
			const encoded: number[] = [filter];
			for (let i = 0; i < 4; i += 1) {
				const a = 0; // one pixel per row, so the left neighbour is always absent
				const b = previous[i] as number;
				const c = 0;
				const predictor =
					filter === 0
						? 0
						: filter === 1
							? a
							: filter === 2
								? b
								: filter === 3
									? (a + b) >> 1
									: // Paeth with a = c = 0 always selects b.
										b;
				encoded.push(((target[i] as number) - predictor) & 0xff);
			}
			rows.push(encoded);
			previous = target;
		}
		const png = encodePng({
			width: 1,
			height: 5,
			colourType: 6,
			bitDepth: 8,
			scanlines: Uint8Array.from(rows.flat()),
		});
		const image = decodePng(png);
		for (let y = 0; y < 5; y += 1) expect(pixel(image, 0, y)).toEqual(target);
	});

	test("carries filter state across rows (a real Up-filtered gradient)", () => {
		// Row n = row n-1 + 1 in every channel, encoded entirely as `Up`.
		const rows: number[][] = [[0, 5, 5, 5, 255]];
		for (let y = 1; y < 4; y += 1) rows.push([2, 1, 1, 1, 0]);
		const image = decodePng(
			encodePng({
				width: 1,
				height: 4,
				colourType: 6,
				bitDepth: 8,
				scanlines: Uint8Array.from(rows.flat()),
			}),
		);
		expect(pixel(image, 0, 0)).toEqual([5, 5, 5, 255]);
		expect(pixel(image, 0, 3)).toEqual([8, 8, 8, 255]);
	});

	test("concatenates multiple IDAT chunks", () => {
		// Real encoders split IDAT at a fixed size; the zlib stream spans them.
		const scanlines = unfiltered([
			[1, 2, 3, 255],
			[4, 5, 6, 255],
		]);
		const compressed = deflateSync(Buffer.from(scanlines));
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(1, 0);
		ihdr.writeUInt32BE(2, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", compressed.subarray(0, 3)),
			chunk("IDAT", compressed.subarray(3)),
			chunk("IEND", new Uint8Array(0)),
		]);
		const image = decodePng(new Uint8Array(png));
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 0, 1)).toEqual([4, 5, 6, 255]);
	});

	test("skips ancillary chunks it does not understand", () => {
		// Ely.by's PNGs carry sBIT/pHYs/tEXt before the pixel data.
		const scanlines = unfiltered([[7, 8, 9, 255]]);
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(1, 0);
		ihdr.writeUInt32BE(1, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("sBIT", Uint8Array.from([8, 8, 8, 8])),
			chunk("tEXt", Buffer.from("Software\0mctl test", "latin1")),
			chunk("IDAT", deflateSync(Buffer.from(scanlines))),
			chunk("IEND", new Uint8Array(0)),
		]);
		expect(pixel(decodePng(new Uint8Array(png)), 0, 0)).toEqual([7, 8, 9, 255]);
	});

	test("rejects non-PNG bytes", () => {
		expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
			PngError,
		);
	});

	test("rejects Adam7 interlacing rather than decoding it wrongly", () => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(1, 0);
		ihdr.writeUInt32BE(1, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		ihdr[12] = 1; // Adam7
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(Buffer.from(unfiltered([[1, 2, 3, 255]])))),
			chunk("IEND", new Uint8Array(0)),
		]);
		expect(() => decodePng(new Uint8Array(png))).toThrow(/interlac/i);
	});

	test("rejects image data shorter than the declared dimensions", () => {
		const png = encodePng({
			width: 4,
			height: 4,
			colourType: 6,
			bitDepth: 8,
			scanlines: unfiltered([[1, 2, 3, 255]]),
		});
		expect(() => decodePng(png)).toThrow(PngError);
	});
});
