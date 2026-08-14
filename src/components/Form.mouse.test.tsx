/**
 * `Select`'s mouse behaviour, driven through real mouse events.
 *
 * Neither `<select>` nor `<tab-select>` answers the mouse upstream, so all of
 * this lives in {@link Select}: a wheel over the dropdown walks its selection, a
 * click picks the tab under the pointer, and resting on a tab strip's end arrow
 * walks toward the options scrolled out of view. These tests mount the real
 * control and push real events at it, because the part that can silently rot is
 * the mapping from a screen cell to an option — geometry the renderable keeps
 * private and this component reconstructs.
 */

import { expect, test } from "bun:test";
import { useState } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { Select, type SelectItem } from "./Form.tsx";

const TABS: SelectItem[] = [
	{ label: "one", value: "one" },
	{ label: "two", value: "two" },
	{ label: "three", value: "three" },
];

/**
 * Six three-cell labels: short enough to be laid out as tabs in a 44-cell field
 * (the labels need 35 of the 40 interior cells), but wider than the strip once
 * `<tab-select>` gives each tab `label + 6` cells — 54 in 40, so only four are
 * visible and the end arrows appear. That gap between "fits as tabs" and "fits
 * in the strip" is the only place the arrows exist at all.
 */
const MANY: SelectItem[] = Array.from({ length: 6 }, (_, i) => ({
	label: `nr${i}`,
	value: `v${i}`,
}));

const LONG: SelectItem[] = Array.from({ length: 8 }, (_, i) => ({
	label: `option-number-${i}`,
	value: `v${i}`,
}));

/**
 * Mount one `Select` at a known screen position and hand back the harness plus
 * the values it reported. The field is placed at the origin, so the control's
 * own row is `y = 1` (under the top border) and its first interior cell is
 * `x = 2` (border + padding).
 */
async function mount(options: SelectItem[], value: string, width = 44) {
	const registry = await new ThemeRegistry().load();
	const harness = await createTestRenderer({ width: width + 4, height: 12 });
	const picked: string[] = [];

	// The selection is fed back through React state inside the tree, not by
	// re-rendering the root: `createRoot(renderer).render()` a second time
	// *remounts* the component, which would throw away the hover state a repeat
	// depends on (memory.md § player heads records the same trap).
	function Host() {
		const [current, setCurrent] = useState(value);
		return (
			<Select
				label="Kind"
				options={options}
				value={current}
				width={width}
				focused
				onChange={(v) => {
					picked.push(v);
					setCurrent(v);
				}}
			/>
		);
	}

	createRoot(harness.renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<Host />
		</ThemeProvider>,
	);
	harness.renderOnce();
	// React's commit reaches the renderer a frame later; one render is a blank tree.
	await Bun.sleep(50);
	harness.renderOnce();
	return { harness, picked };
}

test("a click picks the tab under the pointer", async () => {
	const { harness, picked } = await mount(TABS, "one");
	// tabWidth is the longest label + 6 = 11, so the third tab starts 22 cells in.
	await harness.mockMouse.click(2 + 22, 1);
	expect(picked).toEqual(["three"]);
});

test("a click on empty space past the last tab changes nothing", async () => {
	const { harness, picked } = await mount(TABS, "one");
	await harness.mockMouse.click(2 + 35, 1);
	expect(picked).toEqual([]);
});

test("resting on the trailing arrow walks toward the hidden options", async () => {
	const { harness, picked } = await mount(MANY, "v0");
	const lastCell = 2 + 44 - 5; // interior right edge: outer width - borders - padding
	await harness.mockMouse.moveTo(lastCell, 1);
	// The first step is fired by the move itself; the rest by the repeat.
	await Bun.sleep(400);
	harness.renderOnce();
	expect(picked.length).toBeGreaterThan(1);
	expect(picked[0]).toBe("v1");
	expect(picked[1]).toBe("v2");

	// Moving off the arrow stops it.
	await harness.mockMouse.moveTo(4, 1);
	const settled = picked.length;
	await Bun.sleep(400);
	expect(picked.length).toBe(settled);
});

test("the wheel walks a dropdown's selection and stops at the ends", async () => {
	const { harness, picked } = await mount(LONG, "v0", 24);
	await harness.mockMouse.scroll(6, 1, "down");
	await Bun.sleep(20);
	await harness.mockMouse.scroll(6, 1, "down");
	await Bun.sleep(20);
	expect(picked).toEqual(["v1", "v2"]);

	await harness.mockMouse.scroll(6, 1, "up");
	await Bun.sleep(20);
	expect(picked).toEqual(["v1", "v2", "v1"]);

	// Scrolling up at the top reports nothing rather than wrapping to the end.
	await harness.mockMouse.scroll(6, 1, "up");
	await Bun.sleep(20);
	await harness.mockMouse.scroll(6, 1, "up");
	await Bun.sleep(20);
	expect(picked).toEqual(["v1", "v2", "v1", "v0"]);
});
