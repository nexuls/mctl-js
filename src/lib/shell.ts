/**
 * Process leaf helpers: run a command and collect its output, or locate a binary
 * on `$PATH`.
 *
 * Leaf helper (`lib/`) — UI-free, provider-free, server-free. It knows nothing
 * about Minecraft, Java, or runtimes; it spawns and reports. *Supervising* a
 * long-lived process (deciding it died, restarting it, reading its address out
 * of its output) is **not** this module's job — that belongs to a runtime or
 * network provider. Launching one so it outlives this process is, because that
 * is pure process mechanics with no domain in it: see {@link spawnDetached}.
 *
 * {@link run} is fully buffered, which is only safe because its callers
 * (`java -version`, `tar -xzf`, `tmux has-session`) produce a few kilobytes at
 * most.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { log } from "./logger.ts";

const logger = log("shell");

/** The result of running a command to completion. */
export interface RunResult {
	/** Process exit code (`null` when killed by a signal). */
	code: number | null;
	/** Captured stdout, decoded as UTF-8. */
	stdout: string;
	/**
	 * Captured stderr, decoded as UTF-8. Not an error channel by itself — `java
	 * -version` famously writes its version banner here on JDK 8.
	 */
	stderr: string;
}

/** Options for {@link run}. */
export interface RunOptions {
	/** Working directory for the child. */
	cwd?: string;
	/** Extra environment variables, merged over `process.env`. */
	env?: Record<string, string>;
	/** Kill the child and reject after this many ms. */
	timeoutMs?: number;
	/** Text piped to the child's stdin, which is then closed. */
	stdin?: string;
}

/** Thrown when a command could not be spawned or exceeded its timeout. */
export class CommandError extends Error {
	constructor(
		readonly command: string,
		message: string,
	) {
		super(`${command}: ${message}`);
		this.name = "CommandError";
	}
}

/**
 * Run a command to completion and return its exit code and output. A non-zero
 * exit is **not** an exception — many callers care about the code (`which`-style
 * probes) — but a failure to spawn or a timeout is.
 *
 * @throws {CommandError} when the binary cannot be spawned or the timeout fires.
 */
export async function run(
	command: string,
	args: string[] = [],
	options: RunOptions = {},
): Promise<RunResult> {
	let child: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">;
	try {
		child = Bun.spawn([command, ...args], {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : undefined,
			stdin:
				options.stdin === undefined
					? "ignore"
					: new TextEncoder().encode(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		throw new CommandError(command, `failed to spawn: ${String(err)}`);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
	}

	try {
		// Drain both pipes concurrently with the exit wait: a child that fills its
		// stdout pipe blocks forever if we only await `exited` first.
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (timedOut) {
			throw new CommandError(command, `timed out after ${options.timeoutMs}ms`);
		}
		logger.debug({ command, args, code }, "ran command");
		return { code, stdout, stderr };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Options for {@link spawnDetached}. */
export interface SpawnDetachedOptions {
	/** Working directory for the child. */
	cwd?: string;
	/** Extra environment variables, merged over `process.env`. */
	env?: Record<string, string>;
	/**
	 * File both stdout and stderr are **appended** to. Opened here and closed in
	 * this process immediately after the spawn — the child keeps its own
	 * duplicated descriptor, which is what lets it keep writing after MCTL exits.
	 */
	logFile: string;
}

/**
 * Start a process that **outlives this one**, with its output appended to a file.
 *
 * Three mechanics make that true and all three are required:
 *
 *  - `detached: true` puts the child in its own process group, so a Ctrl-C in
 *    the terminal running MCTL (which signals the whole foreground group) does
 *    not take the tunnel down with it.
 *  - `unref()` removes it from this process's event loop, so MCTL can exit
 *    without waiting on a child that is meant to run for days.
 *  - stdout/stderr are a **file descriptor**, not a pipe. A pipe dies with the
 *    parent, and its far end is unreadable from any other instance — whereas an
 *    appended file is exactly the same no-IPC channel `events.jsonl` and the
 *    console capture already use, so another `mctl` can read why an agent failed.
 *
 * `node:child_process` is used rather than `Bun.spawn` because Bun's spawn has
 * no detach option; the child is not awaited or held in any way here.
 *
 * @returns the child's pid.
 * @throws {CommandError} when the binary cannot be spawned or the log file
 *   cannot be opened.
 */
export function spawnDetached(
	command: string,
	args: string[],
	options: SpawnDetachedOptions,
): number {
	let fd: number;
	try {
		fd = openSync(options.logFile, "a");
	} catch (err) {
		throw new CommandError(command, `cannot open log file: ${String(err)}`);
	}
	try {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		if (child.pid === undefined) {
			throw new CommandError(command, "spawned without a pid");
		}
		child.unref();
		logger.debug({ command, args, pid: child.pid }, "spawned detached process");
		return child.pid;
	} catch (err) {
		if (err instanceof CommandError) throw err;
		throw new CommandError(command, `failed to spawn: ${String(err)}`);
	} finally {
		// The child duplicated the descriptor at spawn time; this process has no
		// further use for it and leaking one per tunnel would be a slow fd leak in
		// a long-lived TUI.
		closeSync(fd);
	}
}

/**
 * Absolute path of `binary` on `$PATH`, or `undefined` when it is not there.
 * Resolved by walking `$PATH` directly rather than shelling out to `which`,
 * which is itself not guaranteed to exist.
 *
 * On Windows, `PATHEXT` suffixes are tried; elsewhere the bare name is used.
 */
export async function which(binary: string): Promise<string | undefined> {
	const path = process.env.PATH;
	if (!path) return undefined;
	const separator = process.platform === "win32" ? ";" : ":";
	const candidates =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
					.split(";")
					.map((ext) => `${binary}${ext.toLowerCase()}`)
			: [binary];

	for (const dir of path.split(separator)) {
		if (dir === "") continue;
		for (const name of candidates) {
			const candidate = `${dir}/${name}`;
			// `Bun.file().exists()` does not tell us about the execute bit, but a
			// non-executable file on PATH is pathological and the spawn would surface
			// it anyway with a clearer error than a bespoke permission check.
			if (await Bun.file(candidate).exists()) return candidate;
		}
	}
	return undefined;
}
