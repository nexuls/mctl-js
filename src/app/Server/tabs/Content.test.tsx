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
let cache: string;
let server: Server;
let previousCacheHome: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-content-tab-"));
	// Icons are extracted into `cacheDir()`, which resolves XDG when it is called
	// — without this the suite writes into the developer's real `~/.cache/mctl`.
	cache = await mkdtemp(join(tmpdir(), "mctl-content-tab-cache-"));
	previousCacheHome = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = cache;
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
	await rm(cache, { recursive: true, force: true });
	if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCacheHome;
});

/**
 * A real 1×1 PNG. Real, rather than arbitrary bytes, because the row genuinely
 * hands this to an `<image>` renderable, which decodes what it is given.
 */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

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
	// parked one has empty space where it would be. (Both rows also lead with the
	// placeholder icon, which is why this reads the cells next to the name rather
	// than the whole line.)
	expect(row("Live")).toMatch(/x\s+Live/);
	expect(row("Parked")).not.toMatch(/x\s+Parked/);
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
	// panels' own top and bottom borders. It sits three lines under the name,
	// because a row is a name line plus the two rows reserved for a description.
	const isRule = (line: string | undefined) =>
		/^\s*│\s*─+\s*│\s*$/.test(line ?? "");
	expect(isRule(lines[row("Aaa") + 3])).toBe(true);
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

test("every row is three rows tall, however long its description", async () => {
	// A row is a name line plus a two-line description block, so the rules
	// between rows land four lines apart (three rows and the rule itself). Rows
	// that sized themselves to their own text would step between two and three
	// and make the list ragged.
	await jar("mods/alpha.jar", fabricMod("Alpha", "1.0", "Short."));
	await jar(
		"mods/beta.jar",
		fabricMod(
			"Beta",
			"1.0",
			"A description long enough that it has to wrap onto the second row the layout reserves for it.",
		),
	);
	const lines = (await mount()).split("\n");
	const alpha = lines.findIndex((line) => line.includes("Alpha"));
	const beta = lines.findIndex((line) => line.includes("Beta"));
	expect(alpha).toBeGreaterThan(-1);
	expect(beta - alpha).toBe(4);
	// The long one wraps onto the second reserved row rather than being cut off
	// at the end of the first.
	expect(lines[beta + 1]).toContain("A description long enough");
	expect(lines[beta + 2]).toContain("for it.");
});

test("the icon column is the same width whether or not a jar ships one", async () => {
	await jar("mods/plain.jar", fabricMod("Plain", "1.0"));
	await jar("mods/withicon.jar", [
		...fabricMod("Withicon", "1.0"),
		{ name: "icon.png", data: PNG },
	]);
	const lines = (await mount()).split("\n");

	/** The column the given name starts at. */
	const column = (name: string) =>
		lines.find((line) => line.includes(name))?.indexOf(name);

	// The names line up because the jar with no logo of its own draws the
	// placeholder in the same six cells, rather than leaving a hole that would
	// make the section's names step in and out by what each jar happened to ship.
	expect(column("Plain")).toBe(column("Withicon"));
});

test("a jar with no icon of its own still draws the placeholder", async () => {
	await jar("mods/plain.jar", fabricMod("Plain", "1.0"));
	const lines = (await mount()).split("\n");
	const row = lines.findIndex((line) => line.includes("Plain"));
	// The placeholder is a rounded outline, so its top row is a run of block
	// glyphs in the cells before the name — an empty column would be spaces.
	const before = (lines[row] ?? "").slice(
		0,
		(lines[row] ?? "").indexOf("Plain"),
	);
	expect(before).toMatch(/[▀▄█▌▐▘▝▖▗▛▜▙▟]/);
});

test("below the icon width the column is dropped again", async () => {
	await jar("mods/withicon.jar", [
		...fabricMod("Withicon", "1.0"),
		{ name: "icon.png", data: PNG },
	]);
	const narrow = (await mount(50)).split("\n");
	const wide = (await mount(100)).split("\n");
	const columnOf = (lines: string[]) =>
		lines.find((line) => line.includes("Withicon"))?.indexOf("Withicon");
	// Seven cells are worth more to the name than to the picture on a small
	// terminal, so the icon column is not reserved at all down there.
	expect((columnOf(wide) ?? 0) - (columnOf(narrow) ?? 0)).toBe(7);
});
