/**
 * Tests for {@link dirSize}, the walk behind the dashboard's "on disk" column.
 *
 * The behaviours worth pinning down are the ones that make it safe to run
 * against a user's world directory: it must not follow symlinks (a link loop
 * would hang the UI), must not throw on anything it meets, and must report when
 * it gave up rather than silently under-reporting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSize } from "./fs.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mctl-dirsize-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Write a file of `size` bytes at `path`, creating parents. */
async function file(path: string, size: number): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, "x".repeat(size));
}

describe("dirSize", () => {
	test("totals files across nested directories", async () => {
		await file(join(root, "server.jar"), 100);
		await file(join(root, "world", "level.dat"), 50);
		await file(join(root, "world", "region", "r.0.0.mca"), 25);

		expect(await dirSize(root)).toEqual({
			bytes: 175,
			files: 3,
			truncated: false,
		});
	});

	test("reports zeroes for a directory that does not exist", async () => {
		expect(await dirSize(join(root, "nope"))).toEqual({
			bytes: 0,
			files: 0,
			truncated: false,
		});
	});

	test("does not follow symlinks", async () => {
		await file(join(root, "real", "data.bin"), 40);
		await symlink(join(root, "real"), join(root, "link"), "dir");

		// 40 bytes counted once — the link is neither a file nor a directory here,
		// so a world symlinked onto another drive is not double-counted and a link
		// loop cannot spin the walk.
		expect((await dirSize(root)).bytes).toBe(40);
	});

	test("stops at maxEntries and says so", async () => {
		for (let i = 0; i < 20; i += 1) await file(join(root, `f${i}`), 10);

		const result = await dirSize(root, { maxEntries: 5 });
		expect(result.truncated).toBe(true);
		expect(result.bytes).toBeLessThan(200);
	});

	test("skips excluded directories", async () => {
		await file(join(root, "keep.txt"), 10);
		await file(join(root, "cache", "big.bin"), 999);

		expect((await dirSize(root, { exclude: new Set(["cache"]) })).bytes).toBe(
			10,
		);
	});
});
