/**
 * SessionManager — re-identifies a server's run state from disk on demand and
 * reaps dead session descriptors and stale locks. This is the beating heart of
 * MCTL's statelessness (architecture.md § Statelessness): the "running set" is
 * **always recomputed** from `~/.local/state/mctl/runtime/<id>.json` plus a
 * liveness probe, and is **never** cached as authoritative in memory.
 *
 * Core service — no UI, no argv, no provider imports. Depends only on `lib/`
 * (paths, fs, logger) and the Zod schema in `types/server.ts`. Runtime providers
 * (foreground/tmux/docker) *write* the descriptors in later phases; this module
 * only reads and verifies them.
 *
 * **Liveness probe (`probe`):**
 *  - No descriptor file → `stopped`.
 *  - Descriptor unreadable / invalid → `stopped`, and the junk file is reaped.
 *  - Descriptor valid, owning process alive → `running`.
 *  - Descriptor valid, owning process dead → `stopped`, and the file is reaped.
 */

import { unlink } from "node:fs/promises";
import { runtimeFile, runtimeLockFile, runtimeDir } from "../../lib/paths.ts";
import {
	readJsonIfExists,
	readTextIfExists,
	readDirIfExists,
} from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { RuntimeSession, type ServerState } from "../../types/server.ts";

const logger = log("session");

/** The result of probing one server: its live state and, if running, its session. */
export interface ProbeResult {
	/** `running` when the descriptor is valid and its process is alive, else `stopped`. */
	state: Extract<ServerState, "running" | "stopped">;
	/** The live session descriptor when `state === "running"`. */
	session?: RuntimeSession;
}

/**
 * Whether a process with the given pid is currently alive. Uses signal `0`,
 * which performs the permission/existence check without delivering a signal:
 *  - resolves (no throw) → the process exists and we may signal it → alive.
 *  - `EPERM` → the process exists but is owned by another user → still alive.
 *  - `ESRCH` → no such process → dead.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Re-identify a server's run state from its session descriptor. Reaps the
 * descriptor when it is invalid or its process is dead, so a crashed server does
 * not linger as "running". Never throws — a probe failure degrades to `stopped`.
 *
 * @param id server id (the descriptor is `runtime/<id>.json`).
 *
 * **Scope: the pid, deliberately.** For a detached runtime, full liveness also
 * means "the session or container still exists", and that question can only be
 * answered by the runtime that owns it — which this module must not import, or
 * the dependency arrow reverses (AGENTS.md § 3). So the split is: `probe` gives
 * every caller the cheap, provider-free answer, and
 * `RuntimeProvider.status()` refines it (`providers/runtime/tmux.ts` checks
 * `has-session` on top of this). The pid remains the *primary* signal for tmux
 * too, because the launch line `exec`s over the shell and the recorded pid is
 * therefore the JVM's own.
 */
export async function probe(id: string): Promise<ProbeResult> {
	const file = runtimeFile(id);
	let raw: unknown;
	try {
		raw = await readJsonIfExists(file);
	} catch (err) {
		// Corrupt JSON in a descriptor is not a running server — reap and report stopped.
		logger.warn(
			{ id, err: String(err) },
			"unreadable runtime descriptor; reaping",
		);
		await reap(file, id);
		return { state: "stopped" };
	}
	if (raw === undefined) return { state: "stopped" };

	const parsed = RuntimeSession.safeParse(raw);
	if (!parsed.success) {
		logger.warn({ id }, "invalid runtime descriptor; reaping");
		await reap(file, id);
		return { state: "stopped" };
	}

	if (isPidAlive(parsed.data.pid)) {
		return { state: "running", session: parsed.data };
	}

	// The recorded process is gone — the server died without cleaning up. Reap the
	// stale descriptor so subsequent probes report `stopped` immediately.
	logger.info({ id, pid: parsed.data.pid }, "dead session; reaping descriptor");
	await reap(file, id);
	return { state: "stopped" };
}

/** Delete a stale descriptor, ignoring a concurrent reap by another instance. */
async function reap(file: string, id: string): Promise<void> {
	try {
		await unlink(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn(
				{ id, err: String(err) },
				"failed to reap runtime descriptor",
			);
		}
	}
}

/**
 * The shape of a lock file's contents. Locks guard actions that must not
 * double-run across instances (start, install, supervise). Written in later
 * phases; reaped here so a crashed instance never wedges a resource.
 */
interface LockContents {
	/** Pid of the instance holding the lock. */
	pid?: number;
}

/**
 * Remove lock files under `runtime/` whose owning process is dead. Called at
 * startup so a crashed instance's locks (start/install/supervisor) don't wedge a
 * server forever. A lock whose owner is still alive is left untouched. Never
 * throws — a best-effort sweep.
 *
 * @returns the ids whose stale locks were reaped (for logging/telemetry).
 */
export async function reapStaleLocks(): Promise<string[]> {
	const names = await readDirIfExists(runtimeDir());
	const reaped: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".lock")) continue;
		const id = name.slice(0, -".lock".length);
		const file = runtimeLockFile(id);
		const text = await readTextIfExists(file);
		if (text === undefined) continue; // reaped concurrently
		const pid = parseLockPid(text);
		// A lock with no discernible owner is treated as stale (nobody can prove it
		// live); a lock owned by a live process is kept.
		if (pid !== undefined && isPidAlive(pid)) continue;
		try {
			await unlink(file);
			reaped.push(id);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn({ id, err: String(err) }, "failed to reap stale lock");
			}
		}
	}
	if (reaped.length > 0) logger.info({ reaped }, "reaped stale locks");
	return reaped;
}

/** Extract the owner pid from a lock file's text (JSON `{ pid }` or a bare number). */
function parseLockPid(text: string): number | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		const obj = JSON.parse(trimmed) as LockContents;
		if (typeof obj.pid === "number" && Number.isInteger(obj.pid))
			return obj.pid;
	} catch {
		// Not JSON — fall through to a bare-integer read.
	}
	const n = Number.parseInt(trimmed, 10);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}
