/**
 * Tests for the version-listing service's pure half — the channel rules both
 * front-ends filter with. No network: `listMinecraftVersions` is one delegation
 * to a provider, and the rules that could actually be wrong are these.
 */

import { describe, expect, test } from "bun:test";
import type { VersionInfo } from "../../types/install.ts";
import {
	availableChannels,
	DEFAULT_CHANNELS,
	filterVersions,
	listMinecraftVersions,
	VERSION_CHANNELS,
	type VersionChannel,
} from "./versions.ts";
import { ProviderRegistry } from "../registry/provider-registry.ts";
import type { ServerProvider } from "../../types/provider.ts";

/** A version list shaped like Mojang's manifest: all four channels, newest first. */
const MANIFEST: VersionInfo[] = [
	{ id: "1.21.4", type: "release", releaseTime: "2024-12-03T10:12:57+00:00" },
	{ id: "24w46a", type: "snapshot", releaseTime: "2024-11-13T12:00:00+00:00" },
	{ id: "1.21.3", type: "release" },
	{ id: "b1.8.1", type: "beta" },
	{ id: "a1.2.6", type: "alpha" },
];

describe("availableChannels", () => {
	test("reports only the channels present, most stable first", () => {
		expect(availableChannels(MANIFEST)).toEqual([
			"release",
			"snapshot",
			"beta",
			"alpha",
		]);
	});

	test("a single-channel provider offers nothing to toggle", () => {
		const purpurish: VersionInfo[] = [
			{ id: "1.21.4", type: "release" },
			{ id: "1.21.3", type: "release" },
		];
		expect(availableChannels(purpurish)).toEqual(["release"]);
	});

	test("an empty list has no channels", () => {
		expect(availableChannels([])).toEqual([]);
	});

	test("never invents a channel the list does not contain", () => {
		for (const channel of availableChannels(MANIFEST)) {
			expect(VERSION_CHANNELS).toContain(channel);
			expect(MANIFEST.some((v) => v.type === channel)).toBe(true);
		}
	});
});

describe("filterVersions", () => {
	test("the default is releases only — the picker never opens on a snapshot", () => {
		expect(filterVersions(MANIFEST, DEFAULT_CHANNELS).map((v) => v.id)).toEqual(
			["1.21.4", "1.21.3"],
		);
	});

	test("keeps upstream's order when several channels are shown", () => {
		const shown: VersionChannel[] = ["release", "snapshot"];
		expect(filterVersions(MANIFEST, shown).map((v) => v.id)).toEqual([
			"1.21.4",
			"24w46a",
			"1.21.3",
		]);
	});

	test("beta and alpha are separately selectable, not one 'other' lump", () => {
		expect(filterVersions(MANIFEST, ["beta"]).map((v) => v.id)).toEqual([
			"b1.8.1",
		]);
		expect(filterVersions(MANIFEST, ["alpha"]).map((v) => v.id)).toEqual([
			"a1.2.6",
		]);
	});

	test("no channels selected shows nothing, rather than everything", () => {
		// The opposite reading — "no filter means no filtering" — would contradict
		// the checkboxes the user just cleared.
		expect(filterVersions(MANIFEST, [])).toEqual([]);
	});
});

describe("listMinecraftVersions", () => {
	test("delegates to the provider registered for the kind", async () => {
		const registry = new ProviderRegistry().registerServer(
			stubProvider("paper", MANIFEST),
		);
		expect(await listMinecraftVersions(registry, "paper")).toEqual(MANIFEST);
	});

	test("an unknown kind is a typed error naming what is available", async () => {
		const registry = new ProviderRegistry().registerServer(
			stubProvider("paper", MANIFEST),
		);
		expect(listMinecraftVersions(registry, "spigot")).rejects.toThrow(
			/unknown server provider "spigot".*paper/,
		);
	});
});

/** A server provider that answers `minecraftVersions()` and nothing else. */
function stubProvider(id: string, versions: VersionInfo[]): ServerProvider {
	return {
		id,
		displayName: id,
		description: "test double",
		async minecraftVersions() {
			return versions;
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
			return { kind: "jar", jar: "server.jar" };
		},
	};
}
