/**
 * png-to-skin — dev tool: convert a PNG of Minecraft head pixel art into the
 * `Skin` shape used by `src/components/MinecraftHead.tsx` (a palette of
 * single-char codes → hex, plus 8 rows of 8 chars).
 *
 * The PNG is treated as an 8×8 *grid of cells* of any resolution (e.g. a
 * 256×256 render is 32px cells); each cell's centre pixel is sampled.
 *
 * Not part of the app. Zero dependencies: decodes PNG with Bun's built-in zlib.
 * Supports 8-bit PNGs of colour type 2 (RGB), 6 (RGBA) and 3 (palette).
 *
 * Usage:
 *   bun scripts/png-to-skin.ts <path/to/head.png> [skinName] [threshold]
 *
 * The optional `threshold` is the RGB distance under which two colours are
 * treated as the same. Higher = fewer colours. ~40 handles typical anti-aliased
 * edges; tune per image.
 *
 * Fully-transparent pixels become the code `.` mapped to "transparent" — edit
 * that by hand, and rename the auto-assigned codes (A, B, C…) to meaningful
 * letters (H=hair, S=skin…) once pasted in.
 */
/** biome-ignore-all lint/style/noNonNullAssertion: xx */

import { inflateSync } from "node:zlib";

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

interface Pixels {
	width: number;
	height: number;
	/** RGBA, 4 bytes per pixel, row-major. */
	data: Uint8Array;
}

/** Minimal PNG decoder for 8-bit colour types 2/3/6. Throws on anything else. */
function decodePng(buf: Buffer): Pixels {
	const sig = [137, 80, 78, 71, 13, 10, 26, 10];
	for (let i = 0; i < 8; i++)
		if (buf[i] !== sig[i]) throw new Error("Not a PNG file");

	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const palette: number[][] = [];
	let trns: number[] = [];
	const idat: Buffer[] = [];

	let off = 8;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("ascii", off + 4, off + 8);
		const body = buf.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			bitDepth = body[8]!;
			colorType = body[9]!;
			if (body[12] !== 0) throw new Error("Interlaced PNGs are not supported");
		} else if (type === "PLTE") {
			for (let i = 0; i < body.length; i += 3)
				palette.push([body[i]!, body[i + 1]!, body[i + 2]!]);
		} else if (type === "tRNS") {
			trns = [...body];
		} else if (type === "IDAT") {
			idat.push(Buffer.from(body));
		} else if (type === "IEND") {
			break;
		}
		off += 12 + len; // 4 len + 4 type + len + 4 crc
	}

	if (bitDepth !== 8)
		throw new Error(`Unsupported bit depth ${bitDepth} (need 8)`);
	const channels =
		colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 3 ? 1 : 0;
	if (channels === 0) throw new Error(`Unsupported colour type ${colorType}`);

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	// Unfilter: each scanline is prefixed with a filter-type byte.
	const unfiltered = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? unfiltered[dst + x - channels] : 0;
			const b = y > 0 ? unfiltered[dst - stride + x] : 0;
			const c =
				y > 0 && x >= channels ? unfiltered[dst - stride + x - channels] : 0;
			const v = raw[src + x];
			let out: number;
			switch (filter) {
				case 0:
					out = v!;
					break;
				case 1:
					out = v! + a!;
					break;
				case 2:
					out = v! + b!;
					break;
				case 3:
					out = v! + ((a! + b!) >> 1);
					break;
				case 4:
					out = v! + paeth(a!, b!, c!);
					break;
				default:
					throw new Error(`Unknown filter ${filter}`);
			}
			unfiltered[dst + x] = out & 0xff;
		}
	}

	// Expand to RGBA.
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		let r: number, g: number, bl: number, al: number;
		if (colorType === 3) {
			const idx = unfiltered[i]!;
			[r, g, bl] = palette[idx]! as [number, number, number];
			al = trns[idx]! ?? 255;
		} else if (colorType === 2) {
			r = unfiltered[i * 3]!;
			g = unfiltered[i * 3 + 1]!;
			bl = unfiltered[i * 3 + 2]!;
			al = 255;
		} else {
			r = unfiltered[i * 4]!;
			g = unfiltered[i * 4 + 1]!;
			bl = unfiltered[i * 4 + 2]!;
			al = unfiltered[i * 4 + 3]!;
		}
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = bl;
		data[i * 4 + 3] = al;
	}
	return { width, height, data };
}

const toHex = (r: number, g: number, b: number): string =>
	`#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;

/** Squared Euclidean distance between two RGB triples. */
const dist2 = (a: RGB, b: RGB): number =>
	(a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

type RGB = [number, number, number];

// Codes assigned in frequency order. Skips '.' (reserved for transparent).
const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Reduce a list of per-cell colours to a small palette by merging colours that
 * sit within `threshold` (Euclidean RGB distance) of a heavier colour. Greedy
 * by frequency: the most common colours become cluster anchors, near-duplicates
 * from anti-aliasing collapse onto them. Returns a map from original hex → the
 * representative hex it was quantised to.
 */
function quantise(
	cells: (RGB | null)[],
	threshold: number,
): Map<string, string> {
	const counts = new Map<string, { rgb: RGB; n: number }>();
	for (const c of cells) {
		if (!c) continue;
		const hex = toHex(...c);
		const e = counts.get(hex) ?? { rgb: c, n: 0 };
		e.n++;
		counts.set(hex, e);
	}
	// Heaviest first, so anchors are the dominant flat colours.
	const sorted = [...counts.values()].sort((a, b) => b.n - a.n);
	const anchors: RGB[] = [];
	const map = new Map<string, string>();
	const t2 = threshold * threshold;
	for (const { rgb } of sorted) {
		let best: RGB | null = null;
		let bestD = t2;
		for (const anchor of anchors) {
			const d = dist2(rgb, anchor);
			if (d <= bestD) {
				bestD = d;
				best = anchor;
			}
		}
		if (best) {
			map.set(toHex(...rgb), toHex(...best));
		} else {
			anchors.push(rgb);
			map.set(toHex(...rgb), toHex(...rgb));
		}
	}
	return map;
}

function main() {
	const [path, name = "skin", thresholdArg] = process.argv.slice(2);
	if (!path) {
		console.error(
			"Usage: bun scripts/png-to-skin.ts <head.png> [skinName] [threshold]",
		);
		process.exit(1);
	}
	// RGB distance under which two cell colours are treated as the same. Higher =
	// fewer colours. ~40 handles typical anti-aliased edges; tune per image.
	const threshold = thresholdArg ? Number(thresholdArg) : 40;
	const { width, height, data } = decodePng(
		Buffer.from(require("node:fs").readFileSync(path)),
	);

	// The image is an 8×8 *grid of cells*, not 8×8 pixels. Split into 8 columns
	// and 8 rows and average the central 50% of each cell — skipping the cell's
	// border avoids the anti-aliased seams between cells.
	const GRID = 8;
	if (width % GRID !== 0 || height % GRID !== 0)
		console.error(
			`⚠ ${width}×${height} is not evenly divisible into an ${GRID}×${GRID} grid — sampling may drift.`,
		);
	const cellW = width / GRID;
	const cellH = height / GRID;

	/** Average the inner half of one cell; null if it's mostly transparent. */
	function sampleCell(gx: number, gy: number): RGB | null {
		const x0 = Math.floor(gx * cellW + cellW * 0.25);
		const x1 = Math.ceil(gx * cellW + cellW * 0.75);
		const y0 = Math.floor(gy * cellH + cellH * 0.25);
		const y1 = Math.ceil(gy * cellH + cellH * 0.75);
		let r = 0;
		let g = 0;
		let b = 0;
		let opaque = 0;
		let total = 0;
		for (let py = y0; py < y1; py++) {
			for (let px = x0; px < x1; px++) {
				const i = (py * width + px) * 4;
				total++;
				if (data[i + 3]! < 128) continue;
				r += data[i]!;
				g += data[i + 1]!;
				b += data[i + 2]!;
				opaque++;
			}
		}
		if (opaque < total / 2) return null; // cell is predominantly transparent
		return [r / opaque, g / opaque, b / opaque];
	}

	const cells: (RGB | null)[] = [];
	for (let gy = 0; gy < GRID; gy++)
		for (let gx = 0; gx < GRID; gx++) cells.push(sampleCell(gx, gy));

	const quant = quantise(cells, threshold); // raw hex → representative hex

	// Assign codes to representatives in frequency order for stable, tidy output.
	const repCounts = new Map<string, number>();
	for (const c of cells) {
		if (!c) continue;
		const rep = quant.get(toHex(...c))!;
		repCounts.set(rep, (repCounts.get(rep) ?? 0) + 1);
	}
	const codeFor = new Map<string, string>(); // representative hex → code
	let next = 0;
	for (const [rep] of [...repCounts.entries()].sort((a, b) => b[1] - a[1]))
		codeFor.set(rep, CODES[next++] ?? "?");

	const rows: string[] = [];
	for (let gy = 0; gy < GRID; gy++) {
		let row = "";
		for (let gx = 0; gx < GRID; gx++) {
			const c = cells[gy * GRID + gx];
			row += c ? codeFor.get(quant.get(toHex(...c))!)! : ".";
		}
		rows.push(row);
	}

	const paletteLines = [...codeFor.entries()]
		.map(([hex, code]) => `\t\t\t${code}: "${hex}",`)
		.join("\n");
	const usesTransparent = rows.some((r) => r.includes("."));
	const transLine = usesTransparent
		? '\n\t\t\t".": "transparent", // TODO: handle transparency'
		: "";
	const faceLines = rows.map((r) => `\t\t\t\t"${r}",`).join("\n");

	console.error(`ℹ ${codeFor.size} colours (threshold ${threshold})`);
	console.log(`\t${name}: {
\t\tpalette: {
${paletteLines}${transLine}
\t\t},
\t\tface: [
${faceLines}
\t\t],
\t},`);
}

main();
