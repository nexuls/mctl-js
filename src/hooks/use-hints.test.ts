/**
 * Tests for the hint merge rules. `composeHints` is pure and exported for
 * exactly this reason: the interesting behaviour (scope order, key-signature
 * de-duplication, the typing filter) is decided here, so it needs no renderer.
 */

import { describe, expect, test } from "bun:test";
import { composeHints, type HintScope, type HintSpec } from "./use-hints.tsx";

const at = (scope: HintScope, ...items: HintSpec[]) => ({ scope, items });

describe("composeHints", () => {
	test("orders context before page before global", () => {
		const items = composeHints(
			[
				at("global", { keys: "q", label: "quit" }),
				at("page", { keys: "n", label: "new" }),
				at("context", { keys: "Enter", label: "send" }),
			],
			false,
		);
		expect(items.map((i) => i.label)).toEqual(["send", "new", "quit"]);
	});

	test("the most specific contribution owns a key", () => {
		// The page relabels Esc rather than adding a second Esc hint — this is what
		// lets a page override the shell's chrome without knowing what it says.
		const items = composeHints(
			[
				at("global", { keys: "Esc", label: "back" }),
				at("page", { keys: "Esc", label: "cancel" }),
			],
			false,
		);
		expect(items).toEqual([{ keys: "Esc", label: "cancel" }]);
	});

	test("de-duplication is by keys, not by label", () => {
		const items = composeHints(
			[
				at("page", { keys: ["Ctrl", "S"], label: "save" }),
				at("global", { keys: ["Ctrl", "S"], label: "write" }),
			],
			false,
		);
		expect(items).toEqual([{ keys: ["Ctrl", "S"], label: "save" }]);
	});

	test("a chord is the same key however it is capped", () => {
		// `["Ctrl","S"]` (two caps) and `"Ctrl+S"` (one) are the same chord, so the
		// signature joins multi-key hints — otherwise the strip shows it twice.
		const items = composeHints(
			[
				at("page", { keys: ["Ctrl", "S"], label: "save" }),
				at("global", { keys: "Ctrl+S", label: "save" }),
			],
			false,
		);
		expect(items).toHaveLength(1);
	});

	test("character shortcuts drop while a field is capturing", () => {
		const registrations = [
			at(
				"global",
				{ keys: "q", label: "quit", when: "idle" },
				{ keys: "Tab", label: "next field", when: "typing" },
				{ keys: "Esc", label: "back" },
			),
		];
		expect(composeHints(registrations, false).map((i) => i.label)).toEqual([
			"quit",
			"back",
		]);
		expect(composeHints(registrations, true).map((i) => i.label)).toEqual([
			"next field",
			"back",
		]);
	});

	test("a hint suppressed by typing frees its key for a lower scope", () => {
		// The page's idle-only Enter stands down, so the shell's typing Enter is
		// the one that renders — not blocked by a signature that never made it in.
		const registrations = [
			at("page", { keys: "Enter", label: "open", when: "idle" }),
			at("global", { keys: "Enter", label: "confirm", when: "typing" }),
		];
		expect(composeHints(registrations, true).map((i) => i.label)).toEqual([
			"confirm",
		]);
		expect(composeHints(registrations, false).map((i) => i.label)).toEqual([
			"open",
		]);
	});

	test("no registrations is an empty strip, not a crash", () => {
		expect(composeHints([], false)).toEqual([]);
	});
});
