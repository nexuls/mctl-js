/**
 * `Spinner` — that it draws a caption, that a caller's frame counter selects the
 * glyph, and that with no counter it animates on its own.
 *
 * The last one is the whole point of the component: a static glyph would satisfy
 * every other assertion here while telling the user nothing about whether the
 * work is still alive.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { IconProvider } from "../hooks/use-icons.tsx";
import { SPINNERS } from "../core/icons/catalogue.ts";
import { Spinner } from "./Spinner.tsx";

const ASCII = SPINNERS.ascii;

/** The `ascii` glyph at `index`, wrapped the way the component wraps it. */
function glyph(index: number): string {
	return ASCII[index % ASCII.length] ?? "";
}

/**
 * Mount one spinner in the `ascii` icon set — its four frames are plain
 * characters, so a captured frame can be asserted on without depending on the
 * runner's terminal font.
 */
async function mount(props: { label?: string; frame?: number } = {}) {
	const registry = await new ThemeRegistry().load();
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 40,
		height: 4,
	});
	createRoot(renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<IconProvider initialMode="ascii">
				<Spinner {...props} />
			</IconProvider>
		</ThemeProvider>,
	);
	renderOnce();
	await Bun.sleep(50);
	renderOnce();
	return {
		frame: () => captureCharFrame(),
		settle: async (ms: number) => {
			await Bun.sleep(ms);
			renderOnce();
		},
	};
}

test("the caption rides beside the glyph", async () => {
	const view = await mount({ label: "loading versions", frame: 0 });
	const text = view.frame();
	expect(text).toContain("loading versions");
	expect(text).toContain(glyph(0));
});

test("a caller's frame counter picks the glyph, modulo the set's length", async () => {
	const first = await mount({ frame: 1 });
	expect(first.frame()).toContain(glyph(1));
	// Four ASCII frames, so 5 is frame 1 again — callers must never assume ten.
	const wrapped = await mount({ frame: ASCII.length + 1 });
	expect(wrapped.frame()).toContain(glyph(1));
});

test("with no frame supplied it animates itself", async () => {
	const view = await mount({});
	const before = view.frame();
	// Several ticks at 10fps, so this cannot pass by landing on the same glyph.
	await view.settle(260);
	expect(view.frame()).not.toBe(before);
});
