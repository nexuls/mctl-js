/**
 * Tests for icon set resolution.
 *
 * Everything under test is pure over an environment record, so these run with
 * no renderer, no filesystem, and — importantly — **no mutation of
 * `process.env`**, which would leak between test files under `bun test`'s
 * shared process.
 */

import { describe, expect, test } from "bun:test";
import { iconsFor, spinnerFor } from "./catalogue.ts";
import {
	detectIconSet,
	hasNerdFont,
	hasUtf8Locale,
	parseIconSet,
	resolveIconSet,
	type IconEnv,
} from "./detect.ts";
import { ICON_SETS, type IconName, type IconSet } from "../../types/icons.ts";

/** A UTF-8, non-Nerd-Font environment — the baseline the tests vary from. */
const PLAIN: IconEnv = { LANG: "en_US.UTF-8", TERM: "xterm-256color" };

describe("hasUtf8Locale", () => {
	test("accepts an explicit UTF-8 locale in any spelling", () => {
		expect(hasUtf8Locale({ LANG: "en_US.UTF-8" })).toBe(true);
		expect(hasUtf8Locale({ LANG: "C.utf8" })).toBe(true);
	});

	test("rejects an explicit non-UTF-8 locale", () => {
		expect(hasUtf8Locale({ LANG: "C" })).toBe(false);
		expect(hasUtf8Locale({ LC_ALL: "POSIX" })).toBe(false);
		expect(hasUtf8Locale({ LC_CTYPE: "en_US.iso88591" })).toBe(false);
	});

	test("treats an entirely unset locale as capable", () => {
		// Routine in containers and systemd units whose terminal is fine with
		// UTF-8; assuming otherwise would hand ASCII to a large share of users.
		expect(hasUtf8Locale({})).toBe(true);
	});

	test("honours the LC_ALL > LC_CTYPE > LANG precedence", () => {
		expect(hasUtf8Locale({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(false);
		expect(hasUtf8Locale({ LC_CTYPE: "C", LANG: "en_US.UTF-8" })).toBe(false);
	});
});

describe("hasNerdFont", () => {
	test("recognises terminals that bundle Nerd Font coverage", () => {
		expect(hasNerdFont({ TERM_PROGRAM: "ghostty" })).toBe(true);
		expect(hasNerdFont({ TERM_PROGRAM: "WezTerm" })).toBe(true);
		expect(hasNerdFont({ TERM: "xterm-kitty" })).toBe(true);
	});

	test("does not claim a Nerd Font for an ordinary terminal", () => {
		expect(hasNerdFont(PLAIN)).toBe(false);
		expect(hasNerdFont({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
		expect(hasNerdFont({})).toBe(false);
	});

	test("an explicit opt-in wins for unrecognised terminals", () => {
		expect(hasNerdFont({ ...PLAIN, MCTL_NERD_FONT: "1" })).toBe(true);
		expect(hasNerdFont({ ...PLAIN, NERD_FONT: "yes" })).toBe(true);
	});

	test("treats 0/false/empty as an opt-out, not an opt-in", () => {
		expect(hasNerdFont({ ...PLAIN, MCTL_NERD_FONT: "0" })).toBe(false);
		expect(hasNerdFont({ ...PLAIN, MCTL_NERD_FONT: "false" })).toBe(false);
		expect(hasNerdFont({ ...PLAIN, MCTL_NERD_FONT: "" })).toBe(false);
	});
});

describe("detectIconSet", () => {
	test("prefers nerd when there is font evidence", () => {
		expect(detectIconSet({ ...PLAIN, TERM: "xterm-ghostty" })).toBe("nerd");
	});

	test("settles on unicode without evidence", () => {
		// The conservative default: a missing Nerd Font glyph is tofu, so `auto`
		// never guesses `nerd`.
		expect(detectIconSet(PLAIN)).toBe("unicode");
	});

	test("falls to ascii on an explicitly non-UTF-8 locale", () => {
		expect(detectIconSet({ LANG: "C", TERM: "xterm-kitty" })).toBe("ascii");
	});
});

describe("resolveIconSet", () => {
	test("honours an explicit mode over detection", () => {
		expect(resolveIconSet("nerd", PLAIN)).toBe("nerd");
		expect(resolveIconSet("ascii", { ...PLAIN, TERM: "xterm-kitty" })).toBe(
			"ascii",
		);
	});

	test("an explicit nerd survives a non-UTF-8 locale", () => {
		// The user asserting "my font has these glyphs" beats any heuristic;
		// second-guessing would make the setting useless to whoever needs it.
		expect(resolveIconSet("nerd", { LANG: "C" })).toBe("nerd");
	});

	test("auto defers to detection", () => {
		expect(resolveIconSet("auto", PLAIN)).toBe("unicode");
		expect(resolveIconSet("auto", { ...PLAIN, TERM_PROGRAM: "ghostty" })).toBe(
			"nerd",
		);
	});

	test("MCTL_ICONS overrides the configured mode", () => {
		expect(resolveIconSet("nerd", { ...PLAIN, MCTL_ICONS: "ascii" })).toBe(
			"ascii",
		);
		expect(resolveIconSet("auto", { ...PLAIN, MCTL_ICONS: "NERD" })).toBe(
			"nerd",
		);
		// `unicode` is reachable only through the env var — it is not a config mode.
		expect(resolveIconSet("ascii", { ...PLAIN, MCTL_ICONS: "unicode" })).toBe(
			"unicode",
		);
	});

	test("a typo in MCTL_ICONS is ignored rather than fatal", () => {
		expect(resolveIconSet("auto", { ...PLAIN, MCTL_ICONS: "nerdfont" })).toBe(
			"unicode",
		);
	});
});

describe("parseIconSet", () => {
	test("is case- and whitespace-insensitive", () => {
		expect(parseIconSet("  Ascii ")).toBe("ascii");
	});

	test("returns undefined for anything unrecognised", () => {
		expect(parseIconSet(undefined)).toBeUndefined();
		expect(parseIconSet("emoji")).toBeUndefined();
	});
});

describe("the catalogue", () => {
	test("every set defines a non-empty glyph for every icon", () => {
		const names = Object.keys(iconsFor("unicode")) as IconName[];
		expect(names.length).toBeGreaterThan(0);
		for (const set of ICON_SETS) {
			const map = iconsFor(set);
			for (const name of names) {
				expect(map[name], `${set}.${name}`).toBeTruthy();
			}
		}
	});

	test("the sets differ — switching actually changes what is drawn", () => {
		expect(iconsFor("ascii").success).not.toBe(iconsFor("unicode").success);
		expect(iconsFor("nerd").success).not.toBe(iconsFor("unicode").success);
	});

	test("ascii glyphs are 7-bit, which is the whole point of the set", () => {
		for (const glyph of Object.values(iconsFor("ascii"))) {
			// eslint-disable-next-line no-control-regex
			expect(glyph, glyph).toMatch(/^[\x20-\x7e]+$/);
		}
		for (const frame of spinnerFor("ascii")) {
			expect(frame, frame).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	test("glyphs are single-cell, bar the documented exceptions", () => {
		// A wider glyph in one set would shift every column beside it when the user
		// switched sets. Two sets carry deliberate exceptions:
		//
		//  - ASCII `ellipsis` / `transition` — no fixed-width column is measured
		//    against them.
		//  - The nerd meter glyphs — a patched font draws these Font Awesome /
		//    Material icons wider than one cell, so the catalogue pads each with a
		//    trailing space to claim the second cell it already occupies. Without
		//    the pad the ten icons of a health meter overlap their neighbours.
		//    They are only ever drawn as a run of identical glyphs, so the extra
		//    cell shifts nothing else.
		const exempt: Readonly<Record<IconSet, ReadonlySet<IconName>>> = {
			ascii: new Set<IconName>(["ellipsis", "transition"]),
			nerd: new Set<IconName>([
				"heartFull",
				"heartEmpty",
				"foodFull",
				"foodEmpty",
			]),
			unicode: new Set<IconName>(),
		};
		for (const set of ICON_SETS) {
			const map = iconsFor(set);
			for (const [name, glyph] of Object.entries(map)) {
				if (exempt[set].has(name as IconName)) continue;
				expect([...glyph], `${set}.${name}`).toHaveLength(1);
			}
		}
	});

	test("the nerd meter glyphs are exactly two cells — pad, not padding drift", () => {
		// Pins the deliberate exception above: a stray double space (or a lost one)
		// in the catalogue would misalign every player meter, and the test that
		// checks the rest of the table would no longer catch it.
		const map = iconsFor("nerd");
		for (const name of [
			"heartFull",
			"heartEmpty",
			"foodFull",
			"foodEmpty",
		] as const) {
			expect([...map[name]], `nerd.${name}`).toHaveLength(2);
			expect(map[name].endsWith(" "), `nerd.${name}`).toBe(true);
		}
	});

	test("no glyph is East-Asian Wide", () => {
		// The ranges that render two cells wide in a terminal. `☕` (U+2615) was an
		// early pick for `java` and is exactly why this test exists.
		const wide =
			/[ᄀ-ᅟ〈〉⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦⌚⌛⏩-⏬◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅✅❌❓-❕➕-➗➰➿⬛⬜⭐⭕]/;
		for (const set of ICON_SETS) {
			for (const [name, glyph] of Object.entries(iconsFor(set))) {
				expect(wide.test(glyph), `${set}.${name} = ${glyph}`).toBe(false);
			}
		}
	});

	test("iconsFor is memoized, so it is safe as a context value", () => {
		// A fresh object per call would re-render every consumer on every render.
		expect(iconsFor("unicode")).toBe(iconsFor("unicode"));
	});

	test("spinner frame counts differ, so callers must not assume ten", () => {
		expect(spinnerFor("ascii").length).not.toBe(spinnerFor("unicode").length);
	});
});
