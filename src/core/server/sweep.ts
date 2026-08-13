/**
 * Sweep of the download working areas: `$ROOT/downloads/staging/<uuid>/` and
 * `$ROOT/downloads/partial/`.
 *
 * Core service — no UI, no argv, no provider knowledge. It only ever removes
 * files MCTL itself created inside `$ROOT/downloads`; it never touches a server
 * directory (AGENTS.md § Secrets and user data).
 *
 * **Why this exists.** A create assembles into a per-attempt staging directory
 * and deletes it in a `finally`. A process killed with SIGKILL never runs that
 * `finally`, so the tree survives; nothing reads it afterwards and it can be
 * several hundred megabytes. Resumable downloads have the same shape one level
 * up: `partial/` deliberately outlives a failed create so the next attempt can
 * continue it, which also means a partial for a version nobody installs again
 * stays forever.
 *
 * **Why an age threshold rather than "delete what is there".** MCTL is
 * multi-instance and holds no shared model, so another instance's *in-flight*
 * create is a staging directory that looks exactly like an abandoned one. There
 * is no lock to consult — the create lock covers the server id, not the staging
 * uuid. Age is the discriminator that needs no coordination: a directory nothing
 * has written to in {@link DEFAULT_MAX_AGE_MS} is not being written to by
 * anyone. The mtime is taken from the newest entry inside the directory, not the
 * directory itself, because a long download only touches the file.
 *
 * Partials get a longer default life than staging: resuming one is the entire
 * point of keeping it, and the user may well retry a failed 200 MB install
 * tomorrow rather than in the next hour.
 */

import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readDirIfExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import type { RootPaths } from "../../lib/paths.ts";

const logger = log("sweep");

/** Staging trees untouched for this long are abandoned (6 hours). */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Partial downloads untouched for this long are stale (14 days). */
export const DEFAULT_PARTIAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Options for {@link sweepDownloads}. */
export interface SweepOptions {
	/**
	 * Age at which a staging directory is considered abandoned, in milliseconds.
	 * Must clear the longest plausible install, since a live create is
	 * indistinguishable from a dead one apart from its age.
	 */
	maxAgeMs?: number;
	/** Age at which a partial download is considered stale, in milliseconds. */
	partialMaxAgeMs?: number;
	/** Clock injection point, so a test does not have to wait. */
	now?: number;
}

/** What a sweep removed. Sizes are in bytes and are best-effort. */
export interface SweepResult {
	/** Absolute paths of the staging directories removed. */
	staging: string[];
	/** Absolute paths of the partial download files removed. */
	partials: string[];
	/** Total bytes reclaimed, as far as the sweep could measure. */
	bytes: number;
}

/**
 * Remove abandoned staging trees and stale partial downloads.
 *
 * Never throws: a sweep is opportunistic housekeeping, and a permission error on
 * one entry must not take down the front-end that called it. Failures are
 * logged and the sweep continues with the next entry.
 *
 * @param paths the data paths from `rootPaths()` / `resolveRootPaths(config)`.
 * @returns what was removed, for a caller that wants to report it.
 */
export async function sweepDownloads(
	paths: RootPaths,
	options: SweepOptions = {},
): Promise<SweepResult> {
	const now = options.now ?? Date.now();
	const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const partialMaxAge = options.partialMaxAgeMs ?? DEFAULT_PARTIAL_MAX_AGE_MS;
	const result: SweepResult = { staging: [], partials: [], bytes: 0 };

	for (const name of await listDir(paths.stagingDir)) {
		const dir = join(paths.stagingDir, name);
		if (!(await statOrUndefined(dir))?.isDirectory()) continue;
		const touched = await newestMtime(dir);
		if (touched === undefined || now - touched < maxAge) continue;
		const bytes = await sizeOf(dir);
		if (await remove(dir)) {
			result.staging.push(dir);
			result.bytes += bytes;
		}
	}

	const partialDir = join(paths.downloadsDir, "partial");
	for (const name of await listDir(partialDir)) {
		const file = join(partialDir, name);
		const info = await statOrUndefined(file);
		if (info === undefined || info.isDirectory()) continue;
		if (now - info.mtimeMs < partialMaxAge) continue;
		if (await remove(file)) {
			result.partials.push(file);
			result.bytes += info.size;
		}
	}

	if (result.staging.length > 0 || result.partials.length > 0) {
		logger.info(
			{
				staging: result.staging.length,
				partials: result.partials.length,
				bytes: result.bytes,
			},
			"swept abandoned download working files",
		);
	}
	return result;
}

/**
 * Most recent mtime anywhere in `dir`, including `dir` itself, in epoch ms.
 *
 * A download in progress rewrites one file deep inside the tree and leaves every
 * ancestor's mtime alone, so the directory's own timestamp would call a live
 * install abandoned. Recursion is bounded by the tree the installer produced —
 * deep, but never a server's world.
 */
async function newestMtime(dir: string): Promise<number | undefined> {
	const self = await statOrUndefined(dir);
	let newest = self?.mtimeMs;
	for (const name of await listDir(dir)) {
		const child = join(dir, name);
		const info = await statOrUndefined(child);
		const at = info?.isDirectory() ? await newestMtime(child) : info?.mtimeMs;
		if (at !== undefined && (newest === undefined || at > newest)) newest = at;
	}
	return newest;
}

/** Bytes held by `dir`, best-effort; a stat failure counts as zero. */
async function sizeOf(dir: string): Promise<number> {
	let total = 0;
	for (const name of await listDir(dir)) {
		const child = join(dir, name);
		const info = await statOrUndefined(child);
		total += info?.isDirectory() ? await sizeOf(child) : (info?.size ?? 0);
	}
	return total;
}

/**
 * Entry names in `dir`, or `[]` when it is absent or unreadable.
 *
 * `readDirIfExists` swallows only ENOENT and rethrows a permission error; a
 * sweep must not propagate either, so it is wrapped here.
 */
async function listDir(dir: string): Promise<string[]> {
	try {
		return await readDirIfExists(dir);
	} catch (error) {
		logger.warn({ dir, error }, "could not read a download directory");
		return [];
	}
}

/** `stat`, or `undefined` when the entry vanished or cannot be read. */
async function statOrUndefined(path: string) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

/** Remove a file or tree; logs and reports false rather than throwing. */
async function remove(path: string): Promise<boolean> {
	try {
		await rm(path, { recursive: true, force: true });
		return true;
	} catch (error) {
		logger.warn({ path, error }, "could not remove abandoned download file");
		return false;
	}
}
