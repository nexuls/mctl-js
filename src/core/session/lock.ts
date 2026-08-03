/**
 * Per-server advisory locks — the mechanism that stops two `mctl` instances
 * doing the same non-idempotent thing at the same time (starting one server
 * twice, running one installer twice). Companion to `session-manager.ts`, which
 * reaps locks whose owner died.
 *
 * Core service — no UI, no argv, no provider imports.
 *
 * **How the lock works.** `open(path, "wx")` fails with `EEXIST` when the file
 * already exists, and that check-and-create is atomic in the kernel — which is
 * exactly what a lock needs and what a `pathExists` + `write` pair could never
 * be. The file's contents are the owner's pid, so `reapStaleLocks()` can tell a
 * live holder from a crashed one.
 *
 * **Advisory, not mandatory.** Nothing prevents code from skipping the lock;
 * every mutating path must take it deliberately. That is the trade for having no
 * daemon and no IPC (architecture.md § Statelessness).
 */

import { open, unlink } from "node:fs/promises";
import { runtimeLockFile, runtimeDir } from "../../lib/paths.ts";
import { ensureDir, readTextIfExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";

const logger = log("lock");

/** Thrown when another live instance already holds a server's lock. */
export class ResourceBusyError extends Error {
	constructor(
		readonly id: string,
		readonly ownerPid: number | undefined,
	) {
		super(
			`another mctl instance is already operating on "${id}"` +
				(ownerPid ? ` (pid ${ownerPid})` : ""),
		);
		this.name = "ResourceBusyError";
	}
}

/** Whether a pid is alive; same signal-0 rule as `session-manager.ts`. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Run `work` while holding server `id`'s lock, releasing it afterwards even if
 * `work` throws.
 *
 * A lock left behind by a **dead** process is reclaimed rather than respected —
 * without that, one crash would wedge a server until the next startup sweep.
 *
 * @throws {ResourceBusyError} when a live instance holds the lock.
 */
export async function withServerLock<T>(
	id: string,
	work: () => Promise<T>,
): Promise<T> {
	const file = runtimeLockFile(id);
	await ensureDir(runtimeDir());

	try {
		// "wx" = create exclusively; fails atomically if the file exists.
		const handle = await open(file, "wx");
		await handle.writeFile(JSON.stringify({ pid: process.pid }));
		await handle.close();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const owner = ownerPidOf(await readTextIfExists(file));
		if (owner !== undefined && isPidAlive(owner)) {
			throw new ResourceBusyError(id, owner);
		}
		// Stale: the recorded owner is gone (or unreadable). Take it over.
		logger.info({ id, owner }, "reclaiming stale lock");
		await unlink(file).catch(() => {});
		return withServerLock(id, work);
	}

	try {
		return await work();
	} finally {
		await unlink(file).catch(() => {
			// Another instance may have reaped it as stale if we were slow; either way
			// there is nothing useful to do at this point.
		});
	}
}

/** Read the owner pid out of a lock file's body (`{"pid":N}` or a bare number). */
function ownerPidOf(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	try {
		const parsed = JSON.parse(trimmed) as { pid?: number };
		if (typeof parsed.pid === "number") return parsed.pid;
	} catch {
		// Not JSON; fall through to a bare integer.
	}
	const n = Number.parseInt(trimmed, 10);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}
