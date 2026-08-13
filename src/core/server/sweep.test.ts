/**
 * Tests for the download sweep.
 *
 * The behaviour that matters is what it *refuses* to delete: another instance's
 * in-flight create is a staging directory that looks exactly like an abandoned
 * one, and the only thing separating them is how recently something inside was
 * written. Every case here drives a real temp tree with real mtimes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "../../lib/fs.ts";
import { rootPaths } from "../../lib/paths.ts";
import { sweepDownloads } from "./sweep.ts";

let root: string;
let paths: ReturnType<typeof rootPaths>;
const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** Set a path's mtime to `ms` before {@link NOW}. */
async function aged(path: string, ms: number): Promise<void> {
	const at = new Date(NOW - ms);
	await utimes(path, at, at);
}

/** A staging tree holding one file, both aged by `ms`. */
async function staging(name: string, ms: number, bytes = 8): Promise<string> {
	const dir = join(paths.stagingDir, name);
	await mkdir(join(dir, "libraries"), { recursive: true });
	const file = join(dir, "libraries", "server.jar");
	await writeFile(file, "x".repeat(bytes));
	await aged(file, ms);
	await aged(join(dir, "libraries"), ms);
	await aged(dir, ms);
	return dir;
}

/** A partial download aged by `ms`. */
async function partial(name: string, ms: number): Promise<string> {
	const dir = join(paths.downloadsDir, "partial");
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, "partial bytes");
	await aged(file, ms);
	return file;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mctl-sweep-"));
	paths = rootPaths(root);
	await mkdir(paths.stagingDir, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("staging", () => {
	test("removes a tree nothing has touched for longer than the threshold", async () => {
		const dir = await staging("abandoned", 8 * HOUR, 1024);
		const result = await sweepDownloads(paths, { now: NOW });
		expect(result.staging).toEqual([dir]);
		expect(result.bytes).toBe(1024);
		expect(await pathExists(dir)).toBe(false);
	});

	test("leaves a fresh tree alone — it may be another instance's create", async () => {
		const dir = await staging("in-flight", 5 * 60 * 1000);
		const result = await sweepDownloads(paths, { now: NOW });
		expect(result.staging).toEqual([]);
		expect(await pathExists(dir)).toBe(true);
	});

	test("judges age by the newest file inside, not the directory itself", async () => {
		// The real shape of a long download: the directory was created hours ago
		// and has not been touched since, while the file inside it is being
		// written to right now. Trusting the directory's own mtime would delete a
		// live install out from under the process doing it.
		const dir = await staging("downloading", 9 * HOUR);
		await aged(join(dir, "libraries", "server.jar"), 30 * 1000);
		const result = await sweepDownloads(paths, { now: NOW });
		expect(result.staging).toEqual([]);
		expect(await pathExists(dir)).toBe(true);
	});

	test("honours a caller's threshold", async () => {
		const dir = await staging("recent", 2 * HOUR);
		await sweepDownloads(paths, { now: NOW, maxAgeMs: HOUR });
		expect(await pathExists(dir)).toBe(false);
	});

	test("sweeps each tree independently", async () => {
		const old = await staging("old", 10 * HOUR);
		const live = await staging("live", 1000);
		await sweepDownloads(paths, { now: NOW });
		expect(await pathExists(old)).toBe(false);
		expect(await pathExists(live)).toBe(true);
	});
});

describe("partials", () => {
	test("removes a partial nobody has resumed in a fortnight", async () => {
		const file = await partial("stale.part", 20 * 24 * HOUR);
		const result = await sweepDownloads(paths, { now: NOW });
		expect(result.partials).toEqual([file]);
		expect(await pathExists(file)).toBe(false);
	});

	test("keeps a partial the user could still resume", async () => {
		// A failed 200 MB install is worth retrying tomorrow; the whole point of
		// `partial/` is that it outlives the attempt that created it.
		const file = await partial("yesterday.part", 24 * HOUR);
		const result = await sweepDownloads(paths, { now: NOW });
		expect(result.partials).toEqual([]);
		expect(await pathExists(file)).toBe(true);
	});

	test("ages partials on their own threshold, not staging's", async () => {
		const file = await partial("day-old.part", 24 * HOUR);
		await sweepDownloads(paths, { now: NOW, partialMaxAgeMs: 12 * HOUR });
		expect(await pathExists(file)).toBe(false);
	});
});

test("an absent downloads tree is a normal state, not an error", async () => {
	await rm(paths.downloadsDir, { recursive: true, force: true });
	const result = await sweepDownloads(paths, { now: NOW });
	expect(result).toEqual({ staging: [], partials: [], bytes: 0 });
});

test("never reaches outside the downloads directory", async () => {
	// The sweep runs unattended at startup, so the one thing it must never do is
	// walk up into a server directory. `servers/` is a sibling of `downloads/`
	// under the same root, aged well past every threshold.
	const server = join(paths.serversDir, "survival");
	await mkdir(server, { recursive: true });
	const world = join(server, "world");
	await writeFile(world, "irreplaceable");
	await aged(world, 400 * 24 * HOUR);
	await aged(server, 400 * 24 * HOUR);

	await sweepDownloads(paths, { now: NOW });
	expect(await pathExists(world)).toBe(true);
});
