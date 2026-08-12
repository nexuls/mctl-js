/**
 * Tests for the page focus ring, driven through a real (in-memory) OpenTUI
 * renderer because Tab handling lives in a `useKeyboard` subscription — state
 * asserted without a keypress would not prove the ring is actually wired.
 *
 * What is pinned here is everything a page relies on and cannot see from the
 * outside: Tab and Shift-Tab cycle, a disabled member is skipped rather than
 * focused, focus does not sit on a member that becomes disabled, `setFocus`
 * refuses a disabled id, and a ring with `enabled: false` ignores the keyboard
 * entirely (which is what stops a page ring moving behind an open modal).
 *
 * Must live inside `src/` — a test outside it resolves a different copy of
 * `@opentui/core` (see memory.md).
 */

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
	useFocusRing,
	type FocusItem,
	type FocusRingOptions,
} from "./use-focus-ring.ts";

/**
 * Mount a ring and expose it to the test.
 *
 * The component writes the live ring into a box's text so the assertion reads a
 * rendered frame, and also hands the ring object out through a mutable holder so
 * a test can call `setFocus`/`next` directly.
 */
async function mount(items: FocusItem[], options?: FocusRingOptions) {
	const harness = await createTestRenderer({ width: 40, height: 4 });
	const holder: { ring?: ReturnType<typeof useFocusRing> } = {};

	/** Render, let React commit, render again — one frame is not enough. */
	const settle = async () => {
		await harness.renderOnce();
		await Bun.sleep(5);
		await harness.renderOnce();
	};

	function Probe() {
		const ring = useFocusRing(items, options);
		holder.ring = ring;
		return <text>{`focus=${ring.focus ?? "none"}`}</text>;
	}

	createRoot(harness.renderer).render(<Probe />);
	// React's commit does not reach the renderer within one frame, so every read
	// below settles first (see memory.md § rendered-frame previews).
	await settle();

	return {
		/** The id the ring currently reports, read back from the rendered frame. */
		async focus(): Promise<string> {
			await settle();
			const frame = harness.captureCharFrame();
			return frame.match(/focus=(\S+)/)?.[1] ?? "";
		},
		/** Press Tab and let the resulting render land. */
		async tab() {
			harness.mockInput.pressTab();
			await settle();
		},
		/**
		 * Press Shift-Tab. Terminals send it as CSI Z ("backtab"), not as Tab with
		 * a shift flag — which is exactly why the hook handles both spellings.
		 */
		async backTab() {
			harness.mockInput.pressKey("\x1b[Z");
			await settle();
		},
		holder,
	};
}

describe("useFocusRing", () => {
	test("Tab and Shift-Tab cycle, wrapping at both ends", async () => {
		const ring = await mount(["a", "b", "c"]);

		expect(await ring.focus()).toBe("a");
		await ring.tab();
		expect(await ring.focus()).toBe("b");
		await ring.tab();
		await ring.tab();
		expect(await ring.focus()).toBe("a");
		await ring.backTab();
		expect(await ring.focus()).toBe("c");
	});

	test("Tab steps over a disabled member", async () => {
		const ring = await mount(["a", { id: "b", disabled: true }, "c"]);

		expect(await ring.focus()).toBe("a");
		await ring.tab();
		expect(await ring.focus()).toBe("c");
		await ring.tab();
		expect(await ring.focus()).toBe("a");
	});

	test("a disabled first member never takes the opening focus", async () => {
		const ring = await mount([{ id: "a", disabled: true }, "b"]);
		expect(await ring.focus()).toBe("b");
	});

	test("no member can hold focus when every one is disabled", async () => {
		const ring = await mount([
			{ id: "a", disabled: true },
			{ id: "b", disabled: true },
		]);
		expect(await ring.focus()).toBe("none");
		await ring.tab();
		expect(await ring.focus()).toBe("none");
	});

	test("setFocus refuses a disabled id and accepts an enabled one", async () => {
		const ring = await mount(["a", { id: "b", disabled: true }, "c"]);

		ring.holder.ring?.setFocus("b");
		expect(await ring.focus()).toBe("a");
		ring.holder.ring?.setFocus("c");
		expect(await ring.focus()).toBe("c");
	});

	test("a disabled ring ignores Tab but keeps its focused id", async () => {
		const ring = await mount(["a", "b"], { enabled: false });

		expect(await ring.focus()).toBe("a");
		await ring.tab();
		expect(await ring.focus()).toBe("a");
	});
});
