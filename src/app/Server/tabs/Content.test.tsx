/**
 * The Content tab, rendered against a **real server directory**.
 *
 * The tab's promises are claims about a frame — that a mod is listed under the
 * name its own manifest gives it, that a parked jar is still shown (and shown as
 * parked), that a directory a server does not have reads differently from one
 * that is empty, and that each section offers the marketplace placeholder. None
 * of those can be checked without drawing them, so every case here mounts the
 * component over real jars written to a temp directory and reads the frame.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../../../core/theme/registry.ts";
import { ThemeProvider } from "../../../hooks/use-theme.tsx";
import { IconProvider } from "../../../hooks/use-icons.tsx";
import { ToastProvider } from "../../../hooks/use-toast.tsx";
import { buildZip } from "../../../lib/zip.fixture.ts";
import type { Server } from "../../../types/server.ts";
import { ContentTab } from "./Content.tsx";

let dir: string;
let server: Server;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-content-tab-"));
	server = {
		id: "survival",
		name: "Survival",
		kind: "fabric",
		minecraftVersion: "1.21.4",
		memory: "2G",
		runtime: "tmux",
		network: "direct",
		path: dir,
		state: "stopped",
		available: true,
	};
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Write a jar holding the given entries at `relative`. */
async function jar(
	relative: string,
	entries: Parameters<typeof buildZip>[0],
): Promise<void> {
	await mkdir(join(dir, relative, ".."), { recursive: true });
	await writeFile(join(dir, relative), buildZip(entries));
}

/** A fabric mod jar named `name`, at `mods/<file>`. */
function fabricMod(name: string, version: string, description?: string) {
	return [
		{
			name: "fabric.mod.json",
			data: JSON.stringify({
				id: name.toLowerCase(),
				name,
				version,
				description,
			}),
		},
	];
}

/** Mount the tab and hand back the harness, settled on its first listing. */
async function mountTab(width = 100, height = 40) {
	const registry = await new ThemeRegistry().load();
	const harness = await createTestRenderer({ width, height });
	createRoot(harness.renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			{/* Pinned to `ascii`, like every other rendered test here: `useIcons`
			    without a set resolves off the *runner's* environment, and a Nerd Font
			    checkbox is invisible in a captured frame. */}
			<IconProvider initialMode="ascii">
				<ToastProvider>
					<ContentTab server={server} />
				</ToastProvider>
			</IconProvider>
		</ThemeProvider>,
	);
	harness.renderOnce();
	// The listing is read from disk after mount, so the frame needs a beat: one
	// render is a blank tree, and the first round has to land before the rows do.
	await Bun.sleep(120);
	harness.renderOnce();
	return harness;
}

/** Mount the tab and return the frame as one string. */
async function mount(width = 100, height = 40): Promise<string> {
	return (await mountTab(width, height)).captureCharFrame();
}

test("a mod is listed under the name its manifest gives it", async () => {
	await jar(
		"mods/sodium-0.6.0+mc1.21.4.jar",
		fabricMod("Sodium", "0.6.0", "A modern rendering engine."),
	);
	const frame = await mount();
	expect(frame).toContain("Sodium");
	expect(frame).toContain("0.6.0");
	expect(frame).toContain("A modern rendering engine.");
	// The filename is not what a list of mods is about; it appears only for a jar
	// whose manifest could not be read.
	expect(frame).not.toContain("sodium-0.6.0+mc1.21.4.jar");
});

test("a parked jar is listed, unticked", async () => {
	await jar("mods/live.jar", fabricMod("Live", "1.0"));
	await jar("mods/parked.jar.disabled", fabricMod("Parked", "1.0"));
	const lines = (await mount()).split("\n");
	const row = (name: string) => lines.find((line) => line.includes(name)) ?? "";
	// The `ascii` set's checkbox is `x` when ticked and a blank when not, so the
	// assertion is about the glyph *before the name*: the loaded mod has one, the
	// parked one has empty space where it would be.
	expect(row("Live")).toMatch(/x\s+Live/);
	expect(row("Parked")).toMatch(/│\s+Parked/);
	expect(lines.join("\n")).toContain("1 enabled, 1 disabled");
});

test("rows are in name order whatever their state, separated by a rule", async () => {
	await jar("mods/zzz.jar", fabricMod("Zzz", "1.0"));
	await jar("mods/aaa.jar.disabled", fabricMod("Aaa", "1.0"));
	const lines = (await mount()).split("\n");
	const row = (name: string) => lines.findIndex((line) => line.includes(name));
	// "Aaa" is parked and still comes first: grouping by state would move a row
	// out from under the pointer the moment its checkbox was clicked.
	expect(row("Aaa")).toBeLessThan(row("Zzz"));
	// One rule between the two rows, and none under the last one. A row rule is a
	// run of ─ *inside* a panel's sides, which is what tells it apart from the
	// panels' own top and bottom borders.
	const isRule = (line: string | undefined) =>
		/^\s*│\s*─+\s*│\s*$/.test(line ?? "");
	expect(isRule(lines[row("Aaa") + 1])).toBe(true);
	expect(lines.filter(isRule).length).toBe(1);
});

test("clicking a row's checkbox parks the jar", async () => {
	await jar("mods/sodium.jar", fabricMod("Sodium", "0.6.0"));
	const harness = await mountTab();
	const lines = harness.captureCharFrame().split("\n");
	// The checkbox is the row's only control, so this is the whole enable/disable
	// gesture in the TUI — there is no caret and no Space to press. The click lands
	// on the name because the glyph and the caption share one box, and that box
	// carries the handler.
	const y = lines.findIndex((line) => line.includes("Sodium"));
	const x = (lines[y] as string).indexOf("Sodium");
	await harness.mockMouse.click(x, y);
	await Bun.sleep(200);
	expect(existsSync(join(dir, "mods", "sodium.jar.disabled"))).toBe(true);
	expect(existsSync(join(dir, "mods", "sodium.jar"))).toBe(false);
});

test("a jar with no readable manifest shows its filename and says why", async () => {
	await mkdir(join(dir, "mods"), { recursive: true });
	await writeFile(join(dir, "mods", "mystery-1.0.jar"), "not a zip at all");
	const frame = await mount();
	expect(frame).toContain("mystery-1.0");
	expect(frame).toContain("no readable manifest");
});

test("an absent directory reads differently from an empty one", async () => {
	const absent = await mount();
	expect(absent).toContain("no mods/ directory");

	await mkdir(join(dir, "mods"), { recursive: true });
	const empty = await mount();
	expect(empty).toContain("mods/ is empty");
});

test("every section offers the marketplace placeholder", async () => {
	const frame = await mount();
	// Mods, plugins, datapacks and the resource pack — four sections, four
	// buttons. They are placeholders (Phase 5), but a section without one would
	// be the odd one out.
	expect(frame.split("Browse marketplace").length - 1).toBe(4);
});

test("datapacks are listed but say they cannot be switched here", async () => {
	await jar("world/datapacks/tweaks.zip", [
		{
			name: "pack.mcmeta",
			data: '{"pack":{"pack_format":48,"description":"Vanilla Tweaks"}}',
		},
	]);
	const frame = await mount();
	expect(frame).toContain("Vanilla Tweaks");
	expect(frame).toContain("/datapack");
});
