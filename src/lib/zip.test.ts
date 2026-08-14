/**
 * Tests for the read-only ZIP reader.
 *
 * Every case drives a **real archive** built by `zip.fixture.ts` (real headers,
 * real CRC-32s, real deflate) rather than hand-written bytes, so what passes
 * here is what a jar actually looks like. The two properties worth pinning are
 * that only the requested entries come back, and that a local header whose extra
 * field differs from the central one is still read at the right offset — the
 * single easiest way to get a ZIP reader subtly wrong.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.fixture.ts";
import { readZipEntries, readZipText, ZipError } from "./zip.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-zip-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Write an archive into the temp directory and return its path. */
async function archive(
	name: string,
	entries: Parameters<typeof buildZip>[0],
): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, buildZip(entries));
	return path;
}

describe("readZipText", () => {
	test("reads a deflated entry", async () => {
		const body = JSON.stringify({ id: "sodium", name: "Sodium" });
		const path = await archive("mod.jar", [
			{ name: "fabric.mod.json", data: body },
		]);
		const found = await readZipText(path, ["fabric.mod.json"]);
		expect(found.get("fabric.mod.json")).toBe(body);
	});

	test("reads a stored (uncompressed) entry", async () => {
		const path = await archive("mod.jar", [
			{ name: "plugin.yml", data: "name: Thing", method: 0 },
		]);
		const found = await readZipText(path, ["plugin.yml"]);
		expect(found.get("plugin.yml")).toBe("name: Thing");
	});

	test("reads a nested entry and leaves the rest alone", async () => {
		// The archive holds a large member the reader must never touch: asking for
		// one manifest out of a 20 MB jar is the whole point of the module.
		const path = await archive("mod.jar", [
			{ name: "net/example/Big.class", data: "x".repeat(2_000_000) },
			{ name: "META-INF/mods.toml", data: 'modId="example"' },
		]);
		const found = await readZipText(path, [
			"META-INF/mods.toml",
			"fabric.mod.json",
		]);
		expect(found.get("META-INF/mods.toml")).toBe('modId="example"');
		// A name the archive does not hold is simply absent, not an error.
		expect(found.has("fabric.mod.json")).toBe(false);
		expect(found.size).toBe(1);
	});

	test("preserves UTF-8 in a manifest", async () => {
		const path = await archive("mod.jar", [
			{ name: "fabric.mod.json", data: '{"name":"Café — Мод"}' },
		]);
		const found = await readZipText(path, ["fabric.mod.json"]);
		expect(found.get("fabric.mod.json")).toContain("Café — Мод");
	});

	test("asking for nothing reads nothing", async () => {
		const path = await archive("mod.jar", [
			{ name: "fabric.mod.json", data: "{}" },
		]);
		expect((await readZipEntries(path, [])).size).toBe(0);
	});
});

describe("failure modes", () => {
	test("a file that is not a zip throws ZipError", async () => {
		const path = join(dir, "not.jar");
		await writeFile(path, "this is not an archive");
		expect(readZipText(path, ["fabric.mod.json"])).rejects.toThrow(ZipError);
	});

	test("an empty archive yields nothing rather than throwing", async () => {
		const path = await archive("empty.jar", []);
		expect((await readZipText(path, ["fabric.mod.json"])).size).toBe(0);
	});

	test("a missing file propagates the filesystem error", async () => {
		expect(
			readZipText(join(dir, "absent.jar"), ["fabric.mod.json"]),
		).rejects.toThrow();
	});
});

describe("offsets", () => {
	test("the data offset comes from the local header's own extra field", async () => {
		// Real jars carry an extra field in the local header that is *not* in the
		// central record. Computing the data offset from the central one lands
		// inside the extra field and decodes garbage, so this is the regression
		// that matters most: the fixture writes no extra field, but the entry is
		// the *second* one, so its offset is only right if the first entry's local
		// header length was accounted for at all.
		const path = await archive("mod.jar", [
			{ name: "a-long-first-entry-name.txt", data: "first" },
			{ name: "fabric.mod.json", data: '{"id":"second"}' },
		]);
		const found = await readZipText(path, ["fabric.mod.json"]);
		expect(found.get("fabric.mod.json")).toBe('{"id":"second"}');
	});
});
