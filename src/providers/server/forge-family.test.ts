/**
 * Tests for the pure parts of the Forge family: the version comparison every
 * launch cutoff depends on, and NeoForge's two version-encoding schemes.
 *
 * No network — these are the decisions made *about* upstream data, which is
 * exactly the part worth pinning: the data itself is fetched and Zod-validated
 * at the boundary, but a wrong `1.9` vs `1.17` comparison would silently give a
 * modern server a pre-1.17 launch spec.
 */

import { describe, expect, test } from "bun:test";
import { argFileName, compareMinecraftVersions } from "./forge-common.ts";
import { decodeNeoVersion } from "./neoforge.ts";

describe("compareMinecraftVersions", () => {
	test("compares numerically, not as strings", () => {
		// The reason this function exists: "1.9" > "1.17" as strings, which would
		// put every 1.9 server on the modern argfile launch path.
		expect(compareMinecraftVersions("1.9", "1.17")).toBe(-1);
		expect(compareMinecraftVersions("1.17", "1.9")).toBe(1);
		expect(compareMinecraftVersions("1.21.4", "1.21.10")).toBe(-1);
	});

	test("treats a missing component as zero", () => {
		expect(compareMinecraftVersions("1.17", "1.17.0")).toBe(0);
		expect(compareMinecraftVersions("1.17.1", "1.17")).toBe(1);
	});

	test("equal versions compare equal", () => {
		expect(compareMinecraftVersions("1.20.4", "1.20.4")).toBe(0);
	});

	test("a pre-release compares as the release it precedes", () => {
		// `1.21.4-rc1` parses its final component as 4; good enough for an
		// "is this at least 1.17" question, which is all this is used for.
		expect(compareMinecraftVersions("1.21.4-rc1", "1.17")).toBe(1);
	});

	test("calendar versions order above the 1.x line", () => {
		expect(compareMinecraftVersions("26.1", "1.21.4")).toBe(1);
	});
});

describe("argFileName", () => {
	test("picks the argfile matching the running platform", () => {
		// The installer writes both; they differ in path and classpath separators,
		// so the wrong one yields a JVM that cannot find its modules.
		expect(argFileName("linux")).toBe("unix_args.txt");
		expect(argFileName("darwin")).toBe("unix_args.txt");
		expect(argFileName("win32")).toBe("win_args.txt");
	});
});

describe("decodeNeoVersion", () => {
	test("three-part versions map onto the 1.x line", () => {
		expect(decodeNeoVersion("21.1.248")).toEqual({
			version: "21.1.248",
			minecraft: "1.21.1",
			stable: true,
		});
	});

	test("a zero minor drops the trailing component (21.0.x is 1.21, not 1.21.0)", () => {
		expect(decodeNeoVersion("21.0.143")?.minecraft).toBe("1.21");
	});

	test("four-part versions are Minecraft's calendar versions", () => {
		expect(decodeNeoVersion("26.1.2.95")?.minecraft).toBe("26.1.2");
		expect(decodeNeoVersion("26.2.0.59")?.minecraft).toBe("26.2");
	});

	test("a suffix marks the build unstable and does not change the mapping", () => {
		expect(decodeNeoVersion("20.2.3-beta")).toEqual({
			version: "20.2.3-beta",
			minecraft: "1.20.2",
			stable: false,
		});
		expect(decodeNeoVersion("26.1.0.0-alpha.10+snapshot-6")?.minecraft).toBe(
			"26.1",
		);
	});

	test("unparseable versions are skipped rather than guessed at", () => {
		// The live list really does contain these (an April Fools' release).
		expect(decodeNeoVersion("0.25w14craftmine.3-beta")).toBeUndefined();
		expect(decodeNeoVersion("21.1")).toBeUndefined();
		expect(decodeNeoVersion("")).toBeUndefined();
	});
});
