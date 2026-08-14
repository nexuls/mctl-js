/**
 * Tests for the manifest readers.
 *
 * Every fixture below is written in the shape the real ecosystem emits — Forge's
 * template with its `'''` description and `${file.jarVersion}` placeholder,
 * Quilt's contributors-as-object-keys, a `plugin.yml` with a block list of
 * authors — because these readers are deliberately narrow and the only thing
 * that makes "narrow" safe is that the shapes they narrow to are the real ones.
 */

import { describe, expect, test } from "bun:test";
import {
	manifestVersion,
	parseFabricMod,
	parseJarMeta,
	parseMcmodInfo,
	parseModsToml,
	parsePackMcmeta,
	parsePluginYml,
	parseQuiltMod,
} from "./content-meta.ts";

/**
 * Forge's own `mods.toml` template writes this literal placeholder and the
 * loader substitutes it from the jar manifest at runtime. Built as a template
 * literal with an escaped `$` so Biome does not read the fixtures as botched
 * interpolation — the string itself is exactly what the file on disk contains.
 */
const JAR_VERSION = `\${file.jarVersion}`;

describe("parseFabricMod", () => {
	test("reads the whole manifest", () => {
		const meta = parseFabricMod(
			JSON.stringify({
				schemaVersion: 1,
				id: "sodium",
				version: "0.6.0+mc1.21.4",
				name: "Sodium",
				description: "A modern\n  rendering engine.",
				authors: ["jellysquid3", { name: "IMS", contact: {} }],
				depends: { minecraft: ">=1.21.4", fabricloader: ">=0.16" },
			}),
		);
		expect(meta).toMatchObject({
			loader: "fabric",
			id: "sodium",
			name: "Sodium",
			version: "0.6.0+mc1.21.4",
			// Multi-line descriptions are collapsed: a manifest's newlines would
			// break a one-line row.
			description: "A modern rendering engine.",
			authors: ["jellysquid3", "IMS"],
			minecraftVersion: ">=1.21.4",
		});
	});

	test("rejects a file that is not a mod manifest", () => {
		expect(parseFabricMod("{}")).toBeUndefined();
		expect(parseFabricMod("not json at all")).toBeUndefined();
	});
});

describe("parseQuiltMod", () => {
	test("reads the nested quilt_loader block", () => {
		const meta = parseQuiltMod(
			JSON.stringify({
				schema_version: 1,
				quilt_loader: {
					id: "example",
					version: "1.0.0",
					metadata: {
						name: "Example Mod",
						description: "Does a thing.",
						// Quilt writes people as keys, roles as values.
						contributors: { Alice: "Owner", Bob: "Author" },
					},
				},
			}),
		);
		expect(meta).toMatchObject({
			loader: "quilt",
			id: "example",
			name: "Example Mod",
			version: "1.0.0",
			authors: ["Alice", "Bob"],
		});
	});

	test("a fabric manifest is not a quilt one", () => {
		expect(parseQuiltMod('{"id":"sodium"}')).toBeUndefined();
	});
});

describe("parseModsToml", () => {
	const TOML = `
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="jei"
version="\${file.jarVersion}"
displayName="Just Enough Items"
authors="mezz, someone else"
description='''
An item and recipe
viewing mod.
'''

[[mods]]
modId="jei-extras"
displayName="Should be ignored"

[[dependencies.jei]]
modId="minecraft"
`;

	test("reads the first [[mods]] block only", () => {
		const meta = parseModsToml(TOML, "forge");
		expect(meta).toMatchObject({
			loader: "forge",
			id: "jei",
			name: "Just Enough Items",
			version: JAR_VERSION,
			description: "An item and recipe viewing mod.",
			authors: ["mezz", "someone else"],
		});
	});

	test("keys outside the block do not leak in", () => {
		// `license` and `loaderVersion` are file-level, not mod-level; a reader that
		// ignored table headers would report the loader range as the mod's version.
		expect(parseModsToml(TOML, "forge")?.version).toBe(JAR_VERSION);
	});

	test("the declared loader is the caller's", () => {
		expect(parseModsToml(TOML, "neoforge")?.loader).toBe("neoforge");
	});

	test("a file with no [[mods]] block yields nothing", () => {
		expect(parseModsToml('modLoader="javafml"', "forge")).toBeUndefined();
	});
});

describe("parsePluginYml", () => {
	test("reads top-level keys and a block list of authors", () => {
		const meta = parsePluginYml(`
name: EssentialsX
version: '2.20.1'
main: com.earth2me.essentials.Essentials
api-version: 1.21
description: Provides an essential, core set of commands.
authors:
  - Zenexer
  - md678685
commands:
  # Nested blocks are deliberately skipped, including their own "name:" keys.
  gamemode:
    name: not-the-plugin
`);
		expect(meta).toMatchObject({
			loader: "bukkit",
			name: "EssentialsX",
			version: "2.20.1",
			description: "Provides an essential, core set of commands.",
			authors: ["Zenexer", "md678685"],
			minecraftVersion: "1.21",
		});
	});

	test("reads an inline author list", () => {
		const meta = parsePluginYml("name: Thing\nauthor: Someone\n");
		expect(meta?.authors).toEqual(["Someone"]);
	});

	test("a manifest with no name is not a plugin manifest", () => {
		expect(parsePluginYml("version: 1.0\n")).toBeUndefined();
	});
});

describe("parseMcmodInfo", () => {
	test("reads the first entry of the legacy array", () => {
		const meta = parseMcmodInfo(
			JSON.stringify([
				{
					modid: "oldmod",
					name: "Old Mod",
					version: "1.2",
					mcversion: "1.12.2",
					description: "From before mods.toml.",
					authorList: ["Someone"],
				},
			]),
		);
		expect(meta).toMatchObject({
			loader: "forge",
			id: "oldmod",
			name: "Old Mod",
			minecraftVersion: "1.12.2",
			authors: ["Someone"],
		});
	});

	test("reads the modList wrapper form", () => {
		expect(parseMcmodInfo('{"modList":[{"modid":"x","name":"X"}]}')?.name).toBe(
			"X",
		);
	});
});

describe("parsePackMcmeta", () => {
	test("reads a plain string description", () => {
		const meta = parsePackMcmeta(
			'{"pack":{"pack_format":48,"description":"Vanilla Tweaks"}}',
		);
		expect(meta).toMatchObject({
			loader: "pack",
			description: "Vanilla Tweaks",
			// The pack format is a schema number and is labelled as one — mapping it
			// to a Minecraft version is a table that rots every release.
			version: "format 48",
		});
	});

	test("flattens a raw text component description", () => {
		const meta = parsePackMcmeta(
			JSON.stringify({
				pack: {
					pack_format: 15,
					description: [
						{ text: "Better " },
						{ text: "Villages", color: "gold" },
					],
				},
			}),
		);
		expect(meta?.description).toBe("Better Villages");
	});

	test("a file without a pack block is not a pack manifest", () => {
		expect(parsePackMcmeta('{"other":1}')).toBeUndefined();
	});
});

describe("parseJarMeta", () => {
	test("prefers the loader manifest over a bundled plugin.yml", () => {
		const meta = parseJarMeta(
			new Map([
				["fabric.mod.json", '{"id":"sodium","name":"Sodium"}'],
				["plugin.yml", "name: NotThis"],
			]),
		);
		expect(meta?.name).toBe("Sodium");
	});

	test("prefers neoforge.mods.toml over the legacy mods.toml", () => {
		const meta = parseJarMeta(
			new Map([
				["META-INF/neoforge.mods.toml", '[[mods]]\nmodId="new"'],
				["META-INF/mods.toml", '[[mods]]\nmodId="old"'],
			]),
		);
		expect(meta).toMatchObject({ loader: "neoforge", id: "new" });
	});

	test(`resolves Forge's ${JAR_VERSION} from the jar manifest`, () => {
		const meta = parseJarMeta(
			new Map([
				[
					"META-INF/mods.toml",
					`[[mods]]\nmodId="jei"\nversion="${JAR_VERSION}"`,
				],
				[
					"META-INF/MANIFEST.MF",
					"Manifest-Version: 1.0\r\nImplementation-Version: 19.21.0.247\r\n",
				],
			]),
		);
		// Left unresolved, every Forge mod would show the literal placeholder.
		expect(meta?.version).toBe("19.21.0.247");
	});

	test("an unresolvable placeholder becomes no version at all", () => {
		const meta = parseJarMeta(
			new Map([
				[
					"META-INF/mods.toml",
					`[[mods]]\nmodId="jei"\nversion="${JAR_VERSION}"`,
				],
			]),
		);
		expect(meta?.version).toBeUndefined();
	});

	test("a jar with no manifest MCTL understands yields nothing", () => {
		expect(parseJarMeta(new Map([["README.md", "hello"]]))).toBeUndefined();
	});
});

describe("manifestVersion", () => {
	test("reads Implementation-Version from CRLF manifest text", () => {
		expect(
			manifestVersion(
				"Manifest-Version: 1.0\r\nImplementation-Version: 4.2\r\n",
			),
		).toBe("4.2");
	});

	test("absent when the manifest does not declare one", () => {
		expect(manifestVersion("Manifest-Version: 1.0\r\n")).toBeUndefined();
	});
});
