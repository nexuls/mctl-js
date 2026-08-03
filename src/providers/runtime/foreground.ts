/**
 * ForegroundRuntime — run a server as a **child of this `mctl` process**.
 *
 * A concrete provider: `lib/`, `core/session/`, and `types/` only; it imports no
 * other provider and nothing from `app/`, `cli/`, or `hooks/`.
 *
 * **What "foreground" means, and its one real limitation.** The server's
 * lifetime is tied to the MCTL process that started it (plan.md § Runtime):
 * close the TUI, and the server goes with it. That is the right trade for
 * dev/quick use, and the detached runtimes (tmux in Phase 3, docker in Phase 5)
 * are what "leave it running" means. It also means **stdin is reachable only
 * from the owning process** — a Unix pipe has no name — so `exec` from a
 * *different* instance throws {@link SessionNotOwnedError} rather than pretending
 * to deliver the command. Everything else works cross-instance:
 *
 *  - `status` reads the on-disk descriptor and probes the pid (as always).
 *  - `logs` tails the shared capture file under `~/.local/state/mctl/console/`,
 *    so a `mctl logs` in another terminal sees the same output.
 *  - `stop` signals the pid, and Minecraft's own shutdown hook saves the world —
 *    so a stop from a second instance is still a *graceful* stop.
 *
 * **Handles are process-local, state is on disk.** The `#children` map holds
 * `Subprocess` handles for servers this process started. That is not a cache of
 * server state — it is the OS handle itself, which cannot be re-derived — and
 * every fact another instance needs (pid, port, start time) is written to
 * `runtime/<id>.json` (architecture.md § Statelessness).
 */

import Bun from "bun";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { consoleLogFile, consoleDir, runtimeFile } from "../../lib/paths.ts";
import { ensureDir, readTextIfExists, writeJsonAtomic } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import type {
	LaunchContext,
	LogOptions,
	RuntimeProvider,
	StopOptions,
} from "../../types/provider.ts";
import type {
	RuntimeSession,
	Server,
	ServerState,
} from "../../types/server.ts";
import { probe } from "../../core/session/session-manager.ts";

const logger = log("runtime:foreground");

/** Default grace period before a stop escalates from SIGTERM to SIGKILL. */
const DEFAULT_STOP_TIMEOUT_MS = 60_000;

/** How often {@link ForegroundRuntime.logs} re-checks the capture file when following. */
const FOLLOW_POLL_MS = 200;

/** Minecraft's default port when `server.properties` says nothing. */
const DEFAULT_PORT = 25565;

/** Thrown when an operation needs the process handle and this instance lacks it. */
export class SessionNotOwnedError extends Error {
	constructor(readonly id: string) {
		super(
			`server "${id}" was started by another mctl instance; ` +
				`the foreground runtime can only send console commands from the process that owns it`,
		);
		this.name = "SessionNotOwnedError";
	}
}

/** A server this process started, plus the sink capturing its output. */
interface OwnedChild {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	/** Resolves when the child has exited and its descriptor has been reaped. */
	exited: Promise<void>;
}

export class ForegroundRuntime implements RuntimeProvider {
	readonly id = "foreground";
	readonly displayName = "Foreground";

	/** Handles for servers started by *this* process. See the module doc. */
	readonly #children = new Map<string, OwnedChild>();

	/**
	 * Launch the server and write its session descriptor.
	 *
	 * The child is spawned with `cwd` set to the server directory, because a
	 * Minecraft server resolves `world/`, `server.properties`, `mods/` and its own
	 * `logs/` relative to the working directory — launching from anywhere else
	 * silently creates a second world tree next to MCTL.
	 */
	async start(context: LaunchContext): Promise<RuntimeSession> {
		const { server, spec, javaPath, jvmArgs } = context;
		const args = [...jvmArgs, "-jar", spec.jar, "nogui"];

		await ensureDir(consoleDir());
		const logFile = consoleLogFile(server.id);
		// Truncate on start: the capture is a view of the *current* run, and an
		// appended file would replay a previous session's shutdown to anyone who
		// tails it. Minecraft's own rolling logs in the server dir remain the
		// historical record.
		await Bun.write(logFile, "");

		logger.info(
			{ id: server.id, javaPath, args, cwd: server.path },
			"starting server (foreground)",
		);
		const child = Bun.spawn([javaPath, ...args], {
			cwd: server.path,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const session: RuntimeSession = {
			pid: child.pid,
			runtime: this.id,
			port: await readServerPort(server.path),
			startedAt: new Date().toISOString(),
		};
		await writeJsonAtomic(runtimeFile(server.id), session);

		// Pump both streams into the shared capture file. Interleaving is by arrival
		// order, which matches what a terminal would have shown.
		const pumping = Promise.all([
			pump(child.stdout, logFile),
			pump(child.stderr, logFile),
		]);

		const exited = (async () => {
			const code = await child.exited;
			await pumping.catch(() => {});
			logger.info({ id: server.id, code }, "server process exited");
			this.#children.delete(server.id);
			// Let the next `probe()` reap the descriptor by finding a dead pid; doing
			// it here as well keeps the window short for a watching instance.
			await Bun.file(runtimeFile(server.id))
				.delete()
				.catch(() => {});
		})();

		this.#children.set(server.id, { child, exited });
		return session;
	}

	/**
	 * Stop the server, escalating only if it will not go quietly.
	 *
	 * Three tiers, in order: the console `stop` command (only possible when this
	 * process owns stdin), then `SIGTERM` (which Minecraft's shutdown hook handles
	 * by saving and exiting), then `SIGKILL` after the timeout. The generous
	 * default timeout exists because the middle step is where the world is saved —
	 * killing early risks losing recently generated chunks.
	 */
	async stop(server: Server, options: StopOptions = {}): Promise<void> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		const owned = this.#children.get(server.id);

		if (owned) {
			try {
				owned.child.stdin.write("stop\n");
				owned.child.stdin.flush();
			} catch (err) {
				logger.warn(
					{ id: server.id, err: String(err) },
					"could not write stop command",
				);
			}
			if (await settled(owned.exited, timeoutMs)) return;
			logger.warn({ id: server.id }, "stop command timed out; sending SIGTERM");
			owned.child.kill("SIGTERM");
			if (await settled(owned.exited, timeoutMs)) return;
			logger.warn({ id: server.id }, "SIGTERM timed out; sending SIGKILL");
			owned.child.kill("SIGKILL");
			await owned.exited;
			return;
		}

		// Not ours: signal the recorded pid and wait for it to disappear. This is
		// still graceful — SIGTERM triggers the same shutdown hook the `stop`
		// console command does.
		const { state, session } = await probe(server.id);
		if (state !== "running" || !session) return;
		logger.info(
			{ id: server.id, pid: session.pid },
			"stopping foreign session via SIGTERM",
		);
		signal(session.pid, "SIGTERM");
		if (!(await waitForExit(session.pid, timeoutMs))) {
			logger.warn(
				{ id: server.id, pid: session.pid },
				"SIGTERM timed out; sending SIGKILL",
			);
			signal(session.pid, "SIGKILL");
			await waitForExit(session.pid, 5_000);
		}
		await Bun.file(runtimeFile(server.id))
			.delete()
			.catch(() => {});
	}

	/**
	 * Stream the captured console output. Reads the shared capture file rather
	 * than the child's pipe, so this works from any instance and can replay what
	 * was printed before the reader attached.
	 */
	async *logs(server: Server, options: LogOptions = {}): AsyncIterable<string> {
		const file = consoleLogFile(server.id);
		const existing = (await readTextIfExists(file)) ?? "";
		let offset = existing.length;

		const lines = existing.split("\n");
		// A trailing "" from the final newline is not a line.
		if (lines.at(-1) === "") lines.pop();
		const initial =
			options.tail === undefined ? lines : lines.slice(-options.tail);
		for (const line of initial) yield line;

		if (!options.follow) return;

		let carry = "";
		while (!options.signal?.aborted) {
			await Bun.sleep(FOLLOW_POLL_MS);
			const text = (await readTextIfExists(file)) ?? "";
			if (text.length < offset) {
				// The file was truncated — a new run started. Resume from its beginning.
				offset = 0;
				carry = "";
			}
			if (text.length === offset) continue;
			const chunk = carry + text.slice(offset);
			offset = text.length;
			const parts = chunk.split("\n");
			// The last part may be a partial line; hold it until its newline arrives.
			carry = parts.pop() ?? "";
			for (const line of parts) yield line;
		}
	}

	/**
	 * Send one line to the server console.
	 * @throws {SessionNotOwnedError} when this process did not start the server —
	 *   see the module doc for why that is a hard limit of this runtime.
	 */
	async exec(server: Server, command: string): Promise<void> {
		const owned = this.#children.get(server.id);
		if (!owned) throw new SessionNotOwnedError(server.id);
		owned.child.stdin.write(`${command}\n`);
		owned.child.stdin.flush();
		logger.debug({ id: server.id, command }, "sent console command");
	}

	/** Re-identify state from the descriptor + pid probe (never from `#children`). */
	async status(server: Server): Promise<ServerState> {
		const { state } = await probe(server.id);
		return state;
	}

	/**
	 * Wait for a server this process owns to exit. Used by the CLI's attached
	 * `mctl start`, which must not return while the server is running.
	 * Resolves immediately when the server is not ours.
	 */
	async waitForOwned(id: string): Promise<void> {
		await this.#children.get(id)?.exited;
	}

	/** True when this process holds the server's handle (so `exec` will work). */
	owns(id: string): boolean {
		return this.#children.has(id);
	}
}

/** Copy a child stream into the capture file as it arrives. */
async function pump(
	stream: ReadableStream<Uint8Array>,
	file: string,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		await appendFile(file, decoder.decode(chunk, { stream: true }));
	}
}

/** Resolve `true` if `promise` settles within `ms`, `false` on timeout. */
async function settled(
	promise: Promise<unknown>,
	ms: number,
): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		Bun.sleep(ms).then(() => false),
	]);
}

/** Send a signal, ignoring "already gone". */
function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(pid, sig);
	} catch {
		// ESRCH: it exited between the probe and the signal — the desired outcome.
	}
}

/** Poll until `pid` is gone or `ms` elapses. Returns whether it exited. */
async function waitForExit(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
		}
		await Bun.sleep(250);
	}
	return false;
}

/**
 * Read `server-port` out of the server's `server.properties`.
 *
 * Read live and never mirrored (plan.md § Directory Layout): the user may edit
 * that file at any time, and MCTL only records the port it observed at start
 * time so the UI can show a join address. Absent file or key ⇒ Minecraft's
 * default, {@link DEFAULT_PORT}.
 */
async function readServerPort(dir: string): Promise<number> {
	const text = await readTextIfExists(join(dir, "server.properties"));
	if (!text) return DEFAULT_PORT;
	const match = /^\s*server-port\s*=\s*(\d+)\s*$/m.exec(text);
	const port = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
	return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}
