/**
 * Colour manipulation: parse, convert, and transform RGB / hex colours.
 *
 * Leaf-level and pure (AGENTS.md § 3): no I/O, no `Bun.*`, no knowledge of
 * servers, providers, or themes. It only turns colour strings into numbers,
 * transforms them, and turns them back. Higher layers (the theme system, the
 * component library) build their semantic palettes on top of these primitives.
 *
 * Two representations flow through here:
 *
 *  1. **Hex strings** — the on-disk / on-theme form (`"#rrggbb"` or `"#rrggbbaa"`).
 *     This is what themes store and what OpenTUI consumes, so every function that
 *     returns a colour returns a hex string.
 *  2. **{@link Rgb} objects** — the working form for maths. Channels are `0–255`
 *     integers; `a` (alpha) is `0–1` and defaults to fully opaque.
 *
 * Hue/saturation/lightness transforms round-trip through HSL internally; because
 * RGB↔HSL is lossy at 8-bit precision, repeated transforms accumulate rounding
 * drift. Compose the transform you want in one call rather than chaining many.
 */

/** Clamp `n` into the inclusive `[min, max]` range. */
function clamp(n: number, min: number, max: number): number {
	return n < min ? min : n > max ? max : n;
}

/** An RGB(A) colour in working form: `r`/`g`/`b` are `0–255`, `a` is `0–1`. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
	/** Alpha, `0` (transparent) to `1` (opaque). Defaults to `1` when omitted. */
	a?: number;
}

/** An HSL(A) colour: `h` in degrees `0–360`, `s`/`l` as fractions `0–1`, `a` `0–1`. */
export interface Hsl {
	h: number;
	s: number;
	l: number;
	/** Alpha, `0`–`1`. Defaults to `1` when omitted. */
	a?: number;
}

/** Round and clamp a channel value into a valid `0–255` byte. */
function toByte(n: number): number {
	return clamp(Math.round(n), 0, 255);
}

/** Format one `0–255` byte as a two-digit lowercase hex pair. */
function byteToHex(n: number): string {
	return toByte(n).toString(16).padStart(2, "0");
}

/**
 * Parse a hex colour string into an {@link Rgb}. Accepts `#rgb`, `#rgba`,
 * `#rrggbb`, and `#rrggbbaa`, with or without the leading `#`. The 3/4-digit
 * shorthand expands each nibble (CSS rules: `#f00` → `#ff0000`).
 *
 * @throws {Error} when the string is not one of the four accepted lengths or
 *   contains non-hex characters — callers feeding untrusted colours should
 *   validate at the boundary rather than relying on a silent fallback.
 */
export function parseHex(hex: string): Rgb {
	const raw = hex.startsWith("#") ? hex.slice(1) : hex;
	if (!/^[0-9a-fA-F]+$/.test(raw)) {
		throw new Error(`Invalid hex colour: "${hex}"`);
	}

	let r: number;
	let g: number;
	let b: number;
	let a = 1;

	switch (raw.length) {
		case 3:
		case 4: {
			// Shorthand: each nibble is doubled, so "f" → "ff".
			const expanded = raw.replace(/./g, (ch) => ch + ch);
			r = parseInt(expanded.slice(0, 2), 16);
			g = parseInt(expanded.slice(2, 4), 16);
			b = parseInt(expanded.slice(4, 6), 16);
			if (raw.length === 4) a = parseInt(expanded.slice(6, 8), 16) / 255;
			break;
		}
		case 6:
		case 8:
			r = parseInt(raw.slice(0, 2), 16);
			g = parseInt(raw.slice(2, 4), 16);
			b = parseInt(raw.slice(4, 6), 16);
			if (raw.length === 8) a = parseInt(raw.slice(6, 8), 16) / 255;
			break;
		default:
			throw new Error(`Invalid hex colour length: "${hex}"`);
	}

	return { r, g, b, a };
}

/**
 * Format an {@link Rgb} as a hex string. Emits `#rrggbb` when the colour is
 * fully opaque (`a` is `1` or omitted) and `#rrggbbaa` otherwise, so opaque
 * colours stay in the compact form themes expect.
 */
export function toHex(c: Rgb): string {
	const base = `#${byteToHex(c.r)}${byteToHex(c.g)}${byteToHex(c.b)}`;
	const a = c.a ?? 1;
	if (a >= 1) return base;
	return base + byteToHex(a * 255);
}

/**
 * Set a colour's alpha to an absolute value in `[0, 1]`, replacing any existing
 * alpha. `1` is opaque, `0` fully transparent.
 */
export function alpha(color: string | Rgb, a: number): string {
	const c = typeof color === "string" ? parseHex(color) : color;
	return toHex({ ...c, a: clamp(a, 0, 1) });
}

/**
 * Multiply a colour's current alpha by `factor`, clamped to `[0, 1]`. Useful for
 * fading something relative to whatever opacity it already has (e.g. dimming an
 * already-translucent overlay) rather than to an absolute value.
 */
export function fade(color: string | Rgb, factor: number): string {
	const c = typeof color === "string" ? parseHex(color) : color;
	return toHex({ ...c, a: clamp((c.a ?? 1) * factor, 0, 1) });
}

// ── RGB ↔ HSL ─────────────────────────────────────────────────────────────────

/**
 * Convert an {@link Rgb} to {@link Hsl}. Alpha passes through unchanged. For a
 * greyscale input (r = g = b) hue and saturation are `0` by convention.
 * https://en.wikipedia.org/wiki/HSL_and_HSV#From_RGB
 */
export function rgbToHsl(c: Rgb): Hsl {
	const r = c.r / 255;
	const g = c.g / 255;
	const b = c.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;

	const l = (max + min) / 2;
	let h = 0;
	let s = 0;

	if (delta !== 0) {
		s = delta / (1 - Math.abs(2 * l - 1));
		switch (max) {
			case r:
				h = ((g - b) / delta) % 6;
				break;
			case g:
				h = (b - r) / delta + 2;
				break;
			default:
				h = (r - g) / delta + 4;
				break;
		}
		h *= 60;
		if (h < 0) h += 360;
	}

	return { h, s, l, a: c.a ?? 1 };
}

/**
 * Convert an {@link Hsl} back to {@link Rgb}. Alpha passes through unchanged.
 * `h` is taken modulo 360; `s` and `l` are clamped to `[0, 1]`.
 * https://en.wikipedia.org/wiki/HSL_and_HSV#HSL_to_RGB_alternative
 */
export function hslToRgb(c: Hsl): Rgb {
	const h = ((c.h % 360) + 360) % 360;
	const s = clamp(c.s, 0, 1);
	const l = clamp(c.l, 0, 1);

	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - chroma / 2;

	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [chroma, x, 0];
	else if (h < 120) [r, g, b] = [x, chroma, 0];
	else if (h < 180) [r, g, b] = [0, chroma, x];
	else if (h < 240) [r, g, b] = [0, x, chroma];
	else if (h < 300) [r, g, b] = [x, 0, chroma];
	else [r, g, b] = [chroma, 0, x];

	return {
		r: toByte((r + m) * 255),
		g: toByte((g + m) * 255),
		b: toByte((b + m) * 255),
		a: c.a ?? 1,
	};
}

/**
 * Apply an HSL-space transform to a colour: parse → HSL → `fn` → RGB → hex.
 * Alpha is preserved unless `fn` changes it. This is the shared engine behind
 * {@link rotateHue}, {@link saturate}, {@link lighten}, and friends.
 */
function mapHsl(color: string | Rgb, fn: (hsl: Hsl) => Hsl): string {
	const rgb = typeof color === "string" ? parseHex(color) : color;
	return toHex(hslToRgb(fn(rgbToHsl(rgb))));
}

/** Rotate the hue by `degrees` (may be negative); wraps around the 360° wheel. */
export function rotateHue(color: string | Rgb, degrees: number): string {
	return mapHsl(color, (hsl) => ({ ...hsl, h: hsl.h + degrees }));
}

/** Set the hue to an absolute `degrees` value on the colour wheel. */
export function setHue(color: string | Rgb, degrees: number): string {
	return mapHsl(color, (hsl) => ({ ...hsl, h: degrees }));
}

/**
 * Shift saturation by `amount` (a fraction, e.g. `0.1` = +10 percentage points).
 * Positive values intensify the colour, negative values wash it out toward grey.
 */
export function saturate(color: string | Rgb, amount: number): string {
	return mapHsl(color, (hsl) => ({ ...hsl, s: clamp(hsl.s + amount, 0, 1) }));
}

/** Shift saturation *down* by `amount`; the inverse of {@link saturate}. */
export function desaturate(color: string | Rgb, amount: number): string {
	return saturate(color, -amount);
}

/** Drop all saturation, yielding the colour's equivalent grey. */
export function grayscale(color: string | Rgb): string {
	return mapHsl(color, (hsl) => ({ ...hsl, s: 0 }));
}

/**
 * Shift lightness by `amount` (a fraction, e.g. `0.1` = +10 percentage points).
 * Positive brightens toward white, negative darkens toward black.
 */
export function lighten(color: string | Rgb, amount: number): string {
	return mapHsl(color, (hsl) => ({ ...hsl, l: clamp(hsl.l + amount, 0, 1) }));
}

/** Shift lightness *down* by `amount`; the inverse of {@link lighten}. */
export function darken(color: string | Rgb, amount: number): string {
	return lighten(color, -amount);
}

// ── Blending & readability ──────────────────────────────────────────────────

/**
 * Linearly blend two colours in RGB space. `weight` is `from`'s share: `0`
 * returns `to`, `1` returns `from`, `0.5` is the midpoint. Alpha is mixed too.
 */
export function mix(
	from: string | Rgb,
	to: string | Rgb,
	weight = 0.5,
): string {
	const a = typeof from === "string" ? parseHex(from) : from;
	const b = typeof to === "string" ? parseHex(to) : to;
	const w = clamp(weight, 0, 1);
	const lerp = (x: number, y: number) => x * w + y * (1 - w);
	return toHex({
		r: lerp(a.r, b.r),
		g: lerp(a.g, b.g),
		b: lerp(a.b, b.b),
		a: lerp(a.a ?? 1, b.a ?? 1),
	});
}

/**
 * Relative luminance of a colour, `0` (black) to `1` (white), per the WCAG 2.x
 * definition (sRGB gamma-expanded, Rec. 709 weights). Alpha is ignored — it
 * measures the colour itself, not what it composites onto.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function luminance(color: string | Rgb): number {
	const c = typeof color === "string" ? parseHex(color) : color;
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/**
 * WCAG contrast ratio between two colours, from `1` (identical) to `21`
 * (black-on-white). AA body text wants ≥ 4.5; large text and UI ≥ 3.
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
	const la = luminance(a);
	const lb = luminance(b);
	const lighter = Math.max(la, lb);
	const darker = Math.min(la, lb);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick whichever of `dark`/`light` reads more legibly on `background`, by
 * contrast ratio. Defaults to black/white ink — the common "readable text on an
 * arbitrary swatch" case (e.g. a coloured badge or keycap).
 */
export function readableOn(
	background: string | Rgb,
	dark = "#000000",
	light = "#ffffff",
): string {
	return contrastRatio(background, dark) >= contrastRatio(background, light)
		? dark
		: light;
}
