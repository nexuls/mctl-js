/**
 * Tests for the installed-content listing and its one mutation.
 *
 * Every case drives a **real server directory** with real jars (built by
 * `lib/zip.fixture.ts`), because the two things worth proving are both about
 * disk: that a jar's own manifest is what names it, and that
 * {@link setContentEnabled} only ever renames — never overwrites, never leaves
 * the directory, never touches a world.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "../../lib/fs.ts";
import { buildZip } from "../../lib/zip.fixture.ts";
import type { ServerProvider } from "../../types/provider.ts";
import type { Server } from "../../types/server.ts";
import { ProviderRegistry } from "../registry/provider-registry.ts";
import {
	ContentError,
	nameFromFile,
	readServerContent,
	setContentEnabled,
	type ContentItem,
} from "./content.ts";

let dir: string;
let server: Server;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-content-"));
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

/** Write a jar holding the given manifest entries into `mods/` (or elsewhere). */
async function jar(
	relative: string,
	entries: Parameters<typeof buildZip>[0],
): Promise<void> {
	const path = join(dir, relative);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, buildZip(entries));
}

/** The one section of a listing, by id. */
async function section(id: "mods" | "plugins" | "datapacks") {
	const listing = await readServerContent(server);
	const found = listing.sections.find((s) => s.id === id);
	if (!found) throw new Error(`no ${id} section`);
	return found;
}

describe("readServerContent", () => {
	test("names each mod from its own manifest", async () => {
		await jar("mods/sodium-0.6.0.jar", [
			{
				name: "fabric.mod.json",
				data: JSON.stringify({
					id: "sodium",
					name: "Sodium",
					version: "0.6.0",
					description: "A rendering engine.",
					authors: ["jellysquid3"],
				}),
			},
		]);
		const mods = await section("mods");
		expect(mods.present).toBe(true);
		expect(mods.items).toHaveLength(1);
		expect(mods.items[0]).toMatchObject({
			name: "Sodium",
			version: "0.6.0",
			loader: "fabric",
			description: "A rendering engine.",
			authors: ["jellysquid3"],
			enabled: true,
			derivedName: false,
		});
		// The size comes off the file, so a listing can show it without a walk.
		expect(mods.items[0]?.sizeBytes).toBeGreaterThan(0);
	});

	test("a jar with no readable manifest still appears, named from its file", async () => {
		await writeFile(join(await modsDir(), "mystery-1.0.jar"), "not a zip");
		const mods = await section("mods");
		expect(mods.items[0]).toMatchObject({
			name: "mystery-1.0",
			derivedName: true,
			enabled: true,
		});
	});

	test("a parked jar is listed as disabled, in name order with the rest", async () => {
		await jar("mods/aaa-parked.jar.disabled", [
			{ name: "fabric.mod.json", data: '{"id":"aaa","name":"Aaa"}' },
		]);
		await jar("mods/zzz-live.jar", [
			{ name: "fabric.mod.json", data: '{"id":"zzz","name":"Zzz"}' },
		]);
		const mods = await section("mods");
		// Name order regardless of state: grouping the parked ones at the bottom
		// would make a row jump the moment its checkbox is clicked.
		expect(mods.items.map((item) => [item.name, item.enabled])).toEqual([
			["Aaa", false],
			["Zzz", true],
		]);
	});

	test("only jars are listed", async () => {
		const mods = await modsDir();
		await writeFile(join(mods, "README.txt"), "hello");
		await writeFile(join(mods, ".index"), "{}");
		await jar("mods/real.jar", [
			{ name: "fabric.mod.json", data: '{"id":"real","name":"Real"}' },
		]);
		expect((await section("mods")).items.map((item) => item.name)).toEqual([
			"Real",
		]);
	});

	test("an absent directory is not an empty one", async () => {
		// A Paper server has no `mods/`; reporting "0 mods" would imply it could.
		const listing = await readServerContent(server);
		expect(listing.sections.map((s) => [s.id, s.present])).toEqual([
			["mods", false],
			["plugins", false],
			["datapacks", false],
		]);

		await mkdir(join(dir, "mods"), { recursive: true });
		const mods = await section("mods");
		expect(mods.present).toBe(true);
		expect(mods.items).toHaveLength(0);
	});

	test("reads plugins from their plugin.yml", async () => {
		await jar("plugins/EssentialsX.jar", [
			{ name: "plugin.yml", data: "name: EssentialsX\nversion: 2.20.1\n" },
		]);
		expect((await section("plugins")).items[0]).toMatchObject({
			name: "EssentialsX",
			version: "2.20.1",
			loader: "bukkit",
		});
	});

	test("reads datapacks, zipped and unpacked, and never offers a switch", async () => {
		await jar("world/datapacks/tweaks.zip", [
			{
				name: "pack.mcmeta",
				data: '{"pack":{"pack_format":48,"description":"Vanilla Tweaks"}}',
			},
		]);
		const unpacked = join(dir, "world", "datapacks", "custom");
		await mkdir(unpacked, { recursive: true });
		await writeFile(
			join(unpacked, "pack.mcmeta"),
			'{"pack":{"pack_format":48,"description":"Custom rules"}}',
		);

		const datapacks = await section("datapacks");
		expect(datapacks.toggleable).toBe(false);
		expect(
			datapacks.items.map((item) => [
				item.name,
				item.description,
				item.directory,
			]),
		).toEqual([
			["custom", "Custom rules", true],
			["tweaks", "Vanilla Tweaks", false],
		]);
	});

	test("datapacks are read from the world that is actually configured", async () => {
		await jar("creative/datapacks/pack.zip", [
			{ name: "pack.mcmeta", data: '{"pack":{"pack_format":48}}' },
		]);
		const listing = await readServerContent(server, "creative");
		const datapacks = listing.sections.find((s) => s.id === "datapacks");
		expect(datapacks?.present).toBe(true);
		expect(datapacks?.items).toHaveLength(1);
	});

	test("an unavailable server lists nothing rather than throwing", async () => {
		const listing = await readServerContent({ ...server, available: false });
		expect(listing.sections).toEqual([]);
	});
});

describe("setContentEnabled", () => {
	test("disabling renames the jar and keeps the item's key", async () => {
		await jar("mods/sodium-0.6.0.jar", [
			{ name: "fabric.mod.json", data: '{"id":"sodium","name":"Sodium"}' },
		]);
		const before = (await section("mods")).items[0] as ContentItem;

		const renamed = await setContentEnabled(server, before, false);
		expect(renamed).toBe("sodium-0.6.0.jar.disabled");
		expect(await readdir(join(dir, "mods"))).toEqual([
			"sodium-0.6.0.jar.disabled",
		]);

		const after = (await section("mods")).items[0] as ContentItem;
		expect(after.enabled).toBe(false);
		// The key is the *enabled* filename, so a UI selection survives a toggle.
		expect(after.key).toBe(before.key);

		// And back again, byte-for-byte the same file — nothing is ever rewritten.
		await setContentEnabled(server, after, true);
		expect(await readdir(join(dir, "mods"))).toEqual(["sodium-0.6.0.jar"]);
	});

	test("refuses to overwrite an existing target", async () => {
		await jar("mods/thing.jar", [
			{ name: "fabric.mod.json", data: '{"id":"thing","name":"Thing"}' },
		]);
		// A stale parked copy of the same jar is exactly the case where a naive
		// rename destroys the user's other file.
		await writeFile(join(dir, "mods", "thing.jar.disabled"), "older copy");

		const item = (await section("mods")).items.find(
			(entry) => entry.file === "thing.jar",
		) as ContentItem;
		expect(setContentEnabled(server, item, false)).rejects.toThrow(
			ContentError,
		);
		// Both files still there, the old one untouched.
		expect(await Bun.file(join(dir, "mods", "thing.jar.disabled")).text()).toBe(
			"older copy",
		);
	});

	test("refuses a datapack", async () => {
		await jar("world/datapacks/tweaks.zip", [
			{ name: "pack.mcmeta", data: '{"pack":{"pack_format":48}}' },
		]);
		const item = (await section("datapacks")).items[0] as ContentItem;
		expect(setContentEnabled(server, item, false)).rejects.toThrow(
			ContentError,
		);
		expect(
			await pathExists(join(dir, "world", "datapacks", "tweaks.zip")),
		).toBe(true);
	});

	test("refuses a path outside the server directory", async () => {
		const outside = await mkdtemp(join(tmpdir(), "mctl-outside-"));
		await writeFile(join(outside, "elsewhere.jar"), "x");
		const item: ContentItem = {
			key: "mods:elsewhere.jar",
			section: "mods",
			file: "elsewhere.jar",
			path: join(outside, "elsewhere.jar"),
			name: "Elsewhere",
			derivedName: true,
			enabled: true,
			directory: false,
		};
		expect(setContentEnabled(server, item, false)).rejects.toThrow(
			ContentError,
		);
		expect(await pathExists(join(outside, "elsewhere.jar"))).toBe(true);
		await rm(outside, { recursive: true, force: true });
	});

	test("a no-op toggle changes nothing", async () => {
		await jar("mods/thing.jar", [
			{ name: "fabric.mod.json", data: '{"id":"thing","name":"Thing"}' },
		]);
		const item = (await section("mods")).items[0] as ContentItem;
		expect(await setContentEnabled(server, item, true)).toBe("thing.jar");
		expect(await readdir(join(dir, "mods"))).toEqual(["thing.jar"]);
	});
});

describe("content support", () => {
	/** A registry holding one kind that takes plugins and datapacks, not mods. */
	function paperish(): ProviderRegistry {
		return new ProviderRegistry().registerServer({
			id: "paper",
			displayName: "Paper",
			description: "test double",
			content: { mods: false, plugins: true, datapacks: true },
			async minecraftVersions() {
				return [];
			},
			async loaderVersions() {
				return [];
			},
			async javaRequirement() {
				return null;
			},
			async resolveInstall() {
				throw new Error("not used");
			},
			launchSpec() {
				throw new Error("not used");
			},
		} as ServerProvider);
	}

	test("a section reports what the kind loads, not what is on disk", async () => {
		server.kind = "paper";
		await mkdir(join(dir, "plugins"), { recursive: true });
		const listing = await readServerContent(server, "world", paperish());
		const support = Object.fromEntries(
			listing.sections.map((s) => [s.id, s.supported]),
		);
		expect(support).toEqual({ mods: false, plugins: true, datapacks: true });
		// `supported` is about the kind and `present` about the directory: the two
		// disagree in both directions here, which is the whole point of the field.
		const plugins = listing.sections.find((s) => s.id === "plugins");
		expect(plugins?.present).toBe(true);
		expect(plugins?.items).toEqual([]);
	});

	test("files in an unsupported directory are still listed", async () => {
		server.kind = "paper";
		await jar("mods/stray.jar", [
			{ name: "fabric.mod.json", data: '{"id":"stray","name":"Stray"}' },
		]);
		const listing = await readServerContent(server, "world", paperish());
		const mods = listing.sections.find((s) => s.id === "mods");
		// Hiding it would leave the user no way to discover why their mod does
		// nothing; the section says "unsupported", it does not say "empty".
		expect(mods?.supported).toBe(false);
		expect(mods?.items.map((item) => item.name)).toEqual(["Stray"]);
	});

	test("an unknown kind, or no registry at all, supports everything", async () => {
		server.kind = "some-future-loader";
		const unknown = await readServerContent(server, "world", paperish());
		expect(unknown.sections.every((s) => s.supported)).toBe(true);
		const none = await readServerContent(server);
		expect(none.sections.every((s) => s.supported)).toBe(true);
	});
});

describe("nameFromFile", () => {
	test("strips the extension and the disabled suffix", () => {
		expect(nameFromFile("sodium-0.6.0.jar.disabled")).toBe("sodium-0.6.0");
		expect(nameFromFile("some_mod.jar")).toBe("some mod");
	});
});

/** Create and return `mods/`. */
async function modsDir(): Promise<string> {
	const path = join(dir, "mods");
	await mkdir(path, { recursive: true });
	return path;
}
