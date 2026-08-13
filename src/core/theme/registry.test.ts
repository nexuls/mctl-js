/**
 * ThemeRegistry — the catalogue's disk reads, and in particular `reload()`.
 *
 * `load()` only ever adds, which was fine while the catalogue was read once at
 * startup. Now that a themes-directory watcher re-reads it live, a *deleted*
 * theme file has to stop resolving too — otherwise editing themes appears to
 * work until the user removes one and it lingers for the rest of the session.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { themesDir } from "../../lib/paths.ts";
import { ThemeRegistry } from "./registry.ts";

let sandbox: string;
let savedConfigHome: string | undefined;

/** A minimal valid theme file, in the `{ default }` single-scheme shape. */
function themeFile(name: string, primary: string): string {
	return JSON.stringify({
		name,
		colors: {
			default: {
				background: "#000000",
				foreground: "#ffffff",
				surface: "#111111",
				border: "#222222",
				muted: "#888888",
				primary,
				secondary: "#b48ead",
				success: "#a3be8c",
				warning: "#ebcb8b",
				error: "#bf616a",
				info: "#88c0d0",
			},
		},
	});
}

/** Write `<themes>/<id>.json`. */
async function writeTheme(id: string, primary: string): Promise<void> {
	await mkdir(themesDir(), { recursive: true });
	await writeFile(join(themesDir(), `${id}.json`), themeFile(id, primary));
}

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "mctl-themes-"));
	savedConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(sandbox, "config");
});

afterEach(async () => {
	if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedConfigHome;
	await rm(sandbox, { recursive: true, force: true });
});

test("load folds a custom theme in beside the built-ins", async () => {
	await writeTheme("dracula", "#bd93f9");
	const registry = await new ThemeRegistry().load();
	expect(registry.get("dracula")?.colors).toMatchObject({
		default: { primary: "#bd93f9" },
	});
	expect(registry.has("nord")).toBe(true);
});

test("reload picks up an edit to a theme file", async () => {
	await writeTheme("dracula", "#bd93f9");
	const registry = await new ThemeRegistry().load();

	await writeTheme("dracula", "#ff79c6");
	await registry.reload();
	expect(registry.get("dracula")?.colors).toMatchObject({
		default: { primary: "#ff79c6" },
	});
});

test("reload drops a theme whose file was deleted", async () => {
	// The reason `reload` exists at all: `load` merges, so a second `load` would
	// leave the deleted theme resolvable until MCTL restarts.
	await writeTheme("dracula", "#bd93f9");
	const registry = await new ThemeRegistry().load();
	expect(registry.has("dracula")).toBe(true);

	await rm(join(themesDir(), "dracula.json"));
	await registry.reload();
	expect(registry.has("dracula")).toBe(false);
	expect(registry.list().some((t) => t.id === "dracula")).toBe(false);
});

test("reload keeps the built-ins and the terminal entry", async () => {
	const registry = await new ThemeRegistry().load();
	await registry.reload();
	expect(registry.has("nord")).toBe(true);
	expect(registry.has("github")).toBe(true);
	// "terminal" is dynamic — resolvable, but never a stored palette.
	expect(registry.has("terminal")).toBe(true);
	expect(registry.get("terminal")).toBeUndefined();
});

test("reload survives a theme file that became invalid", async () => {
	await writeTheme("dracula", "#bd93f9");
	const registry = await new ThemeRegistry().load();

	// Half-written, as an editor's save looks for an instant. One bad file must
	// not empty the catalogue — the watcher fires again when the write lands.
	await writeFile(join(themesDir(), "dracula.json"), "{ not json");
	await registry.reload();
	expect(registry.has("dracula")).toBe(false);
	expect(registry.has("nord")).toBe(true);
});

test("a custom theme may override a built-in, but never `terminal`", async () => {
	await writeTheme("nord", "#123456");
	await writeTheme("terminal", "#654321");
	const registry = await new ThemeRegistry().reload();
	expect(registry.get("nord")?.colors).toMatchObject({
		default: { primary: "#123456" },
	});
	expect(registry.get("terminal")).toBeUndefined();
});
