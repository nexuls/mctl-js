/**
 * AnsiText — the claim that matters is about the *frame*: a coloured log line
 * must draw its text and nothing else. Asserting on the parser alone would not
 * catch the actual bug (escape bytes reaching the frame buffer as literal
 * `[32m`), so these mount the component and read the rendered characters.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { AnsiText, ansiColor } from "./AnsiText.tsx";
import { resolveColors } from "../types/theme.ts";

const ESC = "\u001b";

/** Mount one line and return the frame's rows, right-trimmed. */
async function render(text: string): Promise<string[]> {
	const registry = new ThemeRegistry();
	await registry.load();
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 80,
		height: 4,
	});
	createRoot(renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<AnsiText text={text} />
		</ThemeProvider>,
	);
	renderOnce();
	// React's commit reaches the renderer a frame later; one render is a blank tree.
	await Bun.sleep(80);
	renderOnce();
	return captureCharFrame()
		.split("\n")
		.map((line) => line.trimEnd());
}

test("a coloured log4j line draws its text with no escape residue", async () => {
	const frame = await render(
		`${ESC}[32m[03:21:16] [main/INFO] [FMLLoader/]: Game directory: /srv${ESC}[m`,
	);
	expect(frame[0]).toBe(
		"[03:21:16] [main/INFO] [FMLLoader/]: Game directory: /srv",
	);
	expect(frame.join("\n")).not.toContain("[32m");
});

test("a plain line is unchanged", async () => {
	const frame = await render("[21:50:52 INFO]: All chunks are saved");
	expect(frame[0]).toBe("[21:50:52 INFO]: All chunks are saved");
});

test("the CRLF the capture stores does not blank the line", async () => {
	const frame = await render(`${ESC}[m> stop\r\r`);
	expect(frame[0]).toBe("> stop");
});

test("ansiColor maps the 16 palette entries onto theme roles", async () => {
	const registry = new ThemeRegistry();
	await registry.load();
	const theme = registry.get("github");
	if (!theme) throw new Error("the github theme is a built-in");
	const colors = resolveColors(theme.colors, "dark");

	// log4j's default console pattern: green INFO, yellow WARN, red ERROR.
	expect(ansiColor({ kind: "index", index: 2 }, colors)).toBe(colors.success);
	expect(ansiColor({ kind: "index", index: 3 }, colors)).toBe(colors.warning);
	expect(ansiColor({ kind: "index", index: 1 }, colors)).toBe(colors.error);
	// Bright shares its base role; 16+ is the fixed xterm cube; rgb is literal.
	expect(ansiColor({ kind: "index", index: 9 }, colors)).toBe(colors.error);
	expect(ansiColor({ kind: "index", index: 196 }, colors)).toBe("#ff0000");
	expect(ansiColor({ kind: "rgb", hex: "#ff8000" }, colors)).toBe("#ff8000");
});
