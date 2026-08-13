/**
 * Tests for `lib/colors.ts`.
 *
 * Every theme, every `alpha()` wash and every focus tint in the app goes through
 * this module, and it was the last pure module in `lib/` with no coverage. It is
 * dependency-free maths, so the tests are exact-value assertions rather than
 * fixtures — except where RGB↔HSL rounding makes an exact round-trip impossible,
 * which is itself asserted (it is the reason the module's doc comment tells
 * callers to compose one transform instead of chaining several).
 */

import { describe, expect, test } from "bun:test";
import {
	alpha,
	contrastRatio,
	darken,
	desaturate,
	fade,
	grayscale,
	hslToRgb,
	lighten,
	luminance,
	mix,
	parseHex,
	readableOn,
	rgbToHsl,
	rotateHue,
	saturate,
	setHue,
	toHex,
} from "./colors.ts";

describe("parseHex", () => {
	test("reads all four accepted lengths, with or without the hash", () => {
		expect(parseHex("#ff8000")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
		expect(parseHex("ff8000")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
		// Shorthand doubles each nibble, per CSS: #f80 → #ff8800.
		expect(parseHex("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
		expect(parseHex("#f80c")).toEqual({
			r: 255,
			g: 136,
			b: 0,
			a: 204 / 255,
		});
		expect(parseHex("#ff800080")).toEqual({
			r: 255,
			g: 128,
			b: 0,
			a: 128 / 255,
		});
	});

	test("is case-insensitive", () => {
		expect(parseHex("#AbCdEf")).toEqual(parseHex("#abcdef"));
	});

	test("throws on a bad length or a non-hex character", () => {
		// The module documents throwing rather than falling back silently, so a
		// theme file with a typo fails loudly at its Zod boundary instead of
		// painting an arbitrary colour.
		expect(() => parseHex("#ff800")).toThrow(/Invalid hex colour length/);
		expect(() => parseHex("#gg0000")).toThrow(/Invalid hex colour/);
		expect(() => parseHex("")).toThrow();
		expect(() => parseHex("#")).toThrow();
	});
});

describe("toHex", () => {
	test("emits the compact form when opaque and the 8-digit form otherwise", () => {
		expect(toHex({ r: 255, g: 128, b: 0 })).toBe("#ff8000");
		expect(toHex({ r: 255, g: 128, b: 0, a: 1 })).toBe("#ff8000");
		expect(toHex({ r: 255, g: 128, b: 0, a: 0.5 })).toBe("#ff800080");
		expect(toHex({ r: 0, g: 0, b: 0, a: 0 })).toBe("#00000000");
	});

	test("round-trips every opaque hex string it is given", () => {
		for (const hex of [
			"#000000",
			"#ffffff",
			"#88c0d0",
			"#3b4252",
			"#708abd",
			"#0a0b0c",
		]) {
			expect(toHex(parseHex(hex))).toBe(hex);
		}
	});
});

describe("alpha and fade", () => {
	test("alpha replaces the existing alpha; fade multiplies it", () => {
		expect(alpha("#112233", 0.5)).toBe("#11223380");
		// Already half-transparent: alpha() ignores that, fade() compounds it.
		expect(alpha("#11223380", 1)).toBe("#112233");
		expect(fade("#11223380", 0.5)).toBe("#11223340");
	});

	test("both clamp instead of producing an out-of-range channel", () => {
		expect(alpha("#112233", 5)).toBe("#112233");
		expect(alpha("#112233", -1)).toBe("#11223300");
		expect(fade("#112233", 4)).toBe("#112233");
	});

	test("accepts an Rgb as well as a string", () => {
		expect(alpha({ r: 17, g: 34, b: 51 }, 0.5)).toBe("#11223380");
	});
});

describe("rgbToHsl / hslToRgb", () => {
	test("the primaries land on their textbook hues", () => {
		expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toMatchObject({ h: 0, s: 1 });
		expect(rgbToHsl({ r: 0, g: 255, b: 0 })).toMatchObject({ h: 120, s: 1 });
		expect(rgbToHsl({ r: 0, g: 0, b: 255 })).toMatchObject({ h: 240, s: 1 });
	});

	test("grey has no hue and no saturation, by convention", () => {
		const hsl = rgbToHsl({ r: 128, g: 128, b: 128 });
		expect(hsl.h).toBe(0);
		expect(hsl.s).toBe(0);
		expect(hsl.l).toBeCloseTo(128 / 255, 5);
	});

	test("hue wraps and s/l clamp on the way back", () => {
		expect(hslToRgb({ h: 360 + 120, s: 1, l: 0.5 })).toEqual({
			r: 0,
			g: 255,
			b: 0,
			a: 1,
		});
		expect(hslToRgb({ h: 0, s: 5, l: 5 })).toEqual({
			r: 255,
			g: 255,
			b: 255,
			a: 1,
		});
	});

	test("alpha passes through both directions untouched", () => {
		expect(rgbToHsl({ r: 1, g: 2, b: 3, a: 0.25 }).a).toBe(0.25);
		expect(hslToRgb({ h: 10, s: 0.5, l: 0.5, a: 0.25 }).a).toBe(0.25);
	});

	test("one round trip is lossless to within a channel step", () => {
		// The module warns that chained transforms accumulate drift; this pins how
		// much a *single* trip costs, which is what a caller is entitled to assume.
		for (const hex of ["#88c0d0", "#b48ead", "#a3be8c", "#5e81ac", "#2e3440"]) {
			const rgb = parseHex(hex);
			const back = hslToRgb(rgbToHsl(rgb));
			expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
			expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
			expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
		}
	});
});

describe("hue, saturation and lightness transforms", () => {
	test("rotateHue wraps the wheel in both directions", () => {
		expect(rotateHue("#ff0000", 120)).toBe("#00ff00");
		expect(rotateHue("#ff0000", 360)).toBe("#ff0000");
		expect(rotateHue("#00ff00", -120)).toBe("#ff0000");
	});

	test("setHue is absolute, not relative", () => {
		expect(setHue("#00ff00", 0)).toBe("#ff0000");
		expect(setHue(setHue("#00ff00", 240), 240)).toBe(setHue("#00ff00", 240));
	});

	test("saturate and desaturate move in opposite directions and clamp", () => {
		const base = "#7f8f9f";
		expect(rgbToHsl(parseHex(saturate(base, 0.2))).s).toBeGreaterThan(
			rgbToHsl(parseHex(base)).s,
		);
		expect(rgbToHsl(parseHex(desaturate(base, 0.2))).s).toBeLessThan(
			rgbToHsl(parseHex(base)).s,
		);
		// Fully saturated already: more saturation is a no-op, not an overflow.
		expect(saturate("#ff0000", 0.5)).toBe("#ff0000");
		expect(desaturate("#ff0000", 5)).toBe(grayscale("#ff0000"));
	});

	test("grayscale keeps lightness, drops the colour", () => {
		const grey = grayscale("#88c0d0");
		const { r, g, b } = parseHex(grey);
		expect(r).toBe(g);
		expect(g).toBe(b);
		expect(rgbToHsl(parseHex(grey)).l).toBeCloseTo(
			rgbToHsl(parseHex("#88c0d0")).l,
			2,
		);
	});

	test("lighten and darken bottom and top out at white and black", () => {
		expect(lighten("#808080", 1)).toBe("#ffffff");
		expect(darken("#808080", 1)).toBe("#000000");
		expect(luminance(lighten("#3b4252", 0.2))).toBeGreaterThan(
			luminance("#3b4252"),
		);
		expect(luminance(darken("#3b4252", 0.2))).toBeLessThan(
			luminance("#3b4252"),
		);
	});
});

describe("mix", () => {
	test("the endpoints are exact and the default is the midpoint", () => {
		expect(mix("#000000", "#ffffff", 1)).toBe("#000000");
		expect(mix("#000000", "#ffffff", 0)).toBe("#ffffff");
		expect(mix("#000000", "#ffffff")).toBe("#808080");
	});

	test("weight is the *first* colour's share", () => {
		// The trap this pins: reading `weight` as "how much of `to`" inverts every
		// blended border in the UI, and the result still looks plausible.
		// 0.25 black + 0.75 white = 191.25 per channel, which `toHex` rounds down
		// to 0xbf rather than to 0xc0 — the exact value, not an approximation.
		expect(mix("#000000", "#ffffff", 0.25)).toBe("#bfbfbf");
	});

	test("alpha is mixed alongside the channels, and weight clamps", () => {
		expect(mix("#00000000", "#ffffffff", 0.5)).toBe("#80808080");
		expect(mix("#000000", "#ffffff", 9)).toBe("#000000");
		expect(mix("#000000", "#ffffff", -9)).toBe("#ffffff");
	});
});

describe("luminance, contrastRatio and readableOn", () => {
	test("luminance spans black to white", () => {
		expect(luminance("#000000")).toBe(0);
		expect(luminance("#ffffff")).toBeCloseTo(1, 10);
	});

	test("the WCAG reference pairs come out at their documented ratios", () => {
		// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio — 21:1 is the maximum,
		// and a colour against itself is always 1:1.
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrastRatio("#88c0d0", "#88c0d0")).toBeCloseTo(1, 10);
		// Nord's polar night against snow storm: comfortably above the 4.5 body-text
		// floor, which is why the built-in theme pairs them.
		expect(contrastRatio("#2e3440", "#eceff4")).toBeGreaterThan(4.5);
	});

	test("readableOn picks the ink a terminal user can actually read", () => {
		expect(readableOn("#ffffff")).toBe("#000000");
		expect(readableOn("#000000")).toBe("#ffffff");
		// A mid accent: whichever it picks must beat the alternative, which is the
		// property callers rely on rather than the specific answer.
		for (const bg of ["#88c0d0", "#5e81ac", "#b48ead", "#3b4252"]) {
			const ink = readableOn(bg);
			const other = ink === "#000000" ? "#ffffff" : "#000000";
			expect(contrastRatio(bg, ink)).toBeGreaterThanOrEqual(
				contrastRatio(bg, other),
			);
		}
	});

	test("honours custom ink pairs", () => {
		expect(readableOn("#2e3440", "#4c566a", "#eceff4")).toBe("#eceff4");
	});
});
