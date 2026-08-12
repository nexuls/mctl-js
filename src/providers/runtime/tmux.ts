/**
 * TmuxRuntime — run a server inside a **detached tmux session**, so it outlives
 * the `mctl` process that started it.
 *
 * A concrete provider: `lib/`, `core/runtime/`, `core/session/` and `types/`
 * only; it imports no other provider and nothing from `app/`, `cli/`, or
 * `hooks/`.
 *
 * **This is the runtime that makes "MCTL manages servers, it does not hold them"
 * literally true** (plan.md § Statelessness). It removes both of the foreground
 * runtime's limitations at once:
 *
 *  - The server survives closing the TUI, a `mctl` crash, and an SSH disconnect.
 *  - **`exec` works from any instance**, because the console is reachable through
 *    a *named* tmux session rather than through a pipe only the parent holds.
 *    There is no `SessionNotOwnedError` here.
 *
 * **How a server is started, and why not simply `tmux new-session … java …`.**
 * The session is created empty, output capture is attached, and only then is the
 * launch command typed into it with a leading `exec`:
 *
 *     tmux new-session -d -s mctl-<id> -c <server dir>
 *     tmux pipe-pane -o -t mctl-<id> 'cat >> ~/.local/state/mctl/console/<id>.log'
 *     tmux send-keys -t mctl-<id> -l 'exec "…/java" -Xms2G … -jar server.jar nogui'
 *     tmux send-keys -t mctl-<id> Enter
 *
 * Two things fall out of that order, both load-bearing:
 *
 *  - **No output is lost.** `pipe-pane` only captures what is printed *after* it
 *    is attached, so a server launched as the session's own command would have
 *    its first lines — including an immediate crash — vanish.
 *  - **`exec` keeps the pid.** It replaces the shell in place rather than forking,
 *    so the pane's pid *is* the JVM's pid, recorded once and never re-read. Had
 *    the shell stayed, `pane_pid` would be the shell's and every liveness probe
 *    would report a dead server as running.
 *
 * **Liveness is still the pid**, exactly as for every other runtime, and the
 * session is checked as well: a pane whose process died closes the window and
 * (with no other windows) the session, so the two agree — but a user who typed
 * `exit` into the pane, or a tmux server that was killed, is a case where the
 * session is gone while the recorded pid may briefly linger. `status` reports
 * `stopped` unless *both* hold.
 */

import { join } from "node:path";
import { consoleDir, consoleLogFile, runtimeFile } from "../../lib/paths.ts";
import { ensureDir, readTextIfExists, writeJsonAtomic } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { run, which } from "../../lib/shell.ts";
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
import { launchCommand } from "../../core/runtime/launch.ts";
import { tailConsoleLog } from "../../core/runtime/console-log.ts";

const logger = log("runtime:tmux");

/** Default grace period before a stop escalates from a console `stop` to signals. */
const DEFAULT_STOP_TIMEOUT_MS = 60_000;

/** Minecraft's default port when `server.properties` says nothing. */
const DEFAULT_PORT = 25565;

/** How long a `tmux` control command may take before it is considered wedged. */
const TMUX_TIMEOUT_MS = 10_000;

/** Thrown when tmux is not installed. Carries the platform's install hint. */
export class TmuxUnavailableError extends Error {
	constructor() {
		super(
			"tmux is not installed or not on PATH. Install it " +
				"(apt install tmux / dnf install tmux / brew install tmux / pacman -S tmux), " +
				'or set this server\'s runtime to "foreground" with `mctl edit <id> --runtime foreground`.',
		);
		this.name = "TmuxUnavailableError";
	}
}

/**
 * The tmux session name for a server.
 *
 * Prefixed so MCTL's sessions are recognisable in a user's `tmux ls` and can
 * never collide with one of their own. Dots are replaced because tmux treats
 * them as a target separator (`session.window`), and a server id may not contain
 * anything else that needs escaping (`core/server/manager.ts` restricts ids to
 * lowercase letters, digits and hyphens).
 */
export function sessionName(id: string): string {
	return `mctl-${id.replace(/\./g, "-")}`;
}

export class TmuxRuntime implements RuntimeProvider {
	readonly id = "tmux";
	readonly displayName = "tmux";

	/**
	 * Create a detached session and launch the server inside it. See the module
	 * doc for why the session is created empty and the command typed in after.
	 */
	async start(context: LaunchContext): Promise<RuntimeSession> {
		const { server, spec, javaPath, jvmArgs } = context;
		const tmux = await this.#tmux();
		const session = sessionName(server.id);
		const { command, args } = launchCommand(spec, javaPath, jvmArgs);

		await ensureDir(consoleDir());
		const logFile = consoleLogFile(server.id);
		// Truncate on start: the capture is a view of the *current* run, and an
		// appended file would replay a previous session's shutdown to anyone tailing it.
		await Bun.write(logFile, "");

		// A stale session with this name would make `send-keys` type the launch
		// command into someone else's shell. It can only exist if a previous server
		// died in a way that left the pane open, which `remain-on-exit` (off by
		// default) normally prevents.
		if (await this.#hasSession(tmux, session)) {
			logger.warn({ session }, "killing a stale tmux session before starting");
			await this.#tmuxRun(tmux, ["kill-session", "-t", session]);
		}

		await this.#tmuxRun(tmux, [
			"new-session",
			"-d",
			"-s",
			session,
			"-c",
			server.path,
		]);
		await this.#tmuxRun(tmux, [
			"pipe-pane",
			"-o",
			"-t",
			session,
			`cat >> ${shellQuote(logFile)}`,
		]);

		const line = `exec ${[command, ...args].map(shellQuote).join(" ")}`;
		logger.info(
			{ id: server.id, session, command, args, cwd: server.path },
			"starting server (tmux)",
		);
		// `-l` sends the text literally: without it tmux would interpret words like
		// `Enter` or a `;` inside a JVM argument as key names or command separators.
		await this.#tmuxRun(tmux, ["send-keys", "-t", session, "-l", line]);
		await this.#tmuxRun(tmux, ["send-keys", "-t", session, "Enter"]);

		const pid = await this.#panePid(tmux, session);
		if (pid === undefined) {
			await this.#tmuxRun(tmux, ["kill-session", "-t", session]);
			throw new Error(
				`tmux session ${session} vanished immediately after starting ${server.id}`,
			);
		}

		const descriptor: RuntimeSession = {
			pid,
			runtime: this.id,
			sessionRef: session,
			port: await readServerPort(server.path),
			startedAt: new Date().toISOString(),
		};
		await writeJsonAtomic(runtimeFile(server.id), descriptor);
		return descriptor;
	}

	/**
	 * Stop the server, escalating only if it will not go quietly.
	 *
	 * Three tiers, as for every runtime — but the first one works **from any
	 * instance** here, which is the whole point: `stop` is typed into the named
	 * session's console, so the server saves and exits the way it would if the
	 * operator had typed it.
	 */
	async stop(server: Server, options: StopOptions = {}): Promise<void> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		const { state, session: descriptor } = await probe(server.id);
		if (state !== "running" || !descriptor) return;

		const tmux = await this.#tmux();
		const session = descriptor.sessionRef ?? sessionName(server.id);

		if (await this.#hasSession(tmux, session)) {
			await this.#tmuxRun(tmux, ["send-keys", "-t", session, "-l", "stop"]);
			await this.#tmuxRun(tmux, ["send-keys", "-t", session, "Enter"]);
			if (!(await waitForExit(descriptor.pid, timeoutMs))) {
				logger.warn(
					{ id: server.id, pid: descriptor.pid },
					"console stop timed out; sending SIGTERM",
				);
				signal(descriptor.pid, "SIGTERM");
				if (!(await waitForExit(descriptor.pid, timeoutMs))) {
					logger.warn({ id: server.id }, "SIGTERM timed out; sending SIGKILL");
					signal(descriptor.pid, "SIGKILL");
					await waitForExit(descriptor.pid, 5_000);
				}
			}
			// The pane closes with its process and takes the session with it; this is
			// only for the case where something else is still holding the window open.
			await this.#tmuxRun(tmux, ["kill-session", "-t", session]).catch(
				() => {},
			);
		} else {
			// Session already gone but a descriptor survived: signal the pid directly.
			signal(descriptor.pid, "SIGTERM");
			await waitForExit(descriptor.pid, timeoutMs);
		}

		await Bun.file(runtimeFile(server.id))
			.delete()
			.catch(() => {});
		logger.info({ id: server.id, session }, "stopped server (tmux)");
	}

	/** The shared capture file, identical to every other runtime. */
	logs(server: Server, options: LogOptions = {}): AsyncIterable<string> {
		return tailConsoleLog(consoleLogFile(server.id), options);
	}

	/**
	 * Send one line to the server console — **from any instance**, unlike the
	 * foreground runtime. A tmux session is addressed by name, so nothing about
	 * this depends on which process started the server.
	 */
	async exec(server: Server, command: string): Promise<void> {
		const tmux = await this.#tmux();
		const { session: descriptor } = await probe(server.id);
		const session = descriptor?.sessionRef ?? sessionName(server.id);
		if (!(await this.#hasSession(tmux, session))) {
			throw new Error(
				`server "${server.id}" has no live tmux session (${session})`,
			);
		}
		await this.#tmuxRun(tmux, ["send-keys", "-t", session, "-l", command]);
		await this.#tmuxRun(tmux, ["send-keys", "-t", session, "Enter"]);
		logger.debug({ id: server.id, command }, "sent console command");
	}

	/**
	 * Running only when the recorded pid is alive **and** its session still
	 * exists. The extra check is what the pid alone cannot tell us: a tmux server
	 * killed out from under a session, or a pane the user exited, leaves a window
	 * in which the descriptor still looks plausible.
	 */
	async status(server: Server): Promise<ServerState> {
		const { state, session: descriptor } = await probe(server.id);
		if (state !== "running" || !descriptor) return state;
		const tmux = await which("tmux");
		// With no tmux binary the session cannot be confirmed either way; the pid is
		// alive, so reporting `unknown` is more honest than either alternative.
		if (!tmux) return "unknown";
		const session = descriptor.sessionRef ?? sessionName(server.id);
		return (await this.#hasSession(tmux, session)) ? "running" : "stopped";
	}

	/** Locate tmux, or explain how to install it. */
	async #tmux(): Promise<string> {
		const path = await which("tmux");
		if (!path) throw new TmuxUnavailableError();
		return path;
	}

	/** Run a tmux control command, throwing on a non-zero exit. */
	async #tmuxRun(tmux: string, args: string[]): Promise<string> {
		const result = await run(tmux, args, { timeoutMs: TMUX_TIMEOUT_MS });
		if (result.code !== 0) {
			throw new Error(
				`tmux ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
			);
		}
		return result.stdout;
	}

	/** Whether a session with this name exists. */
	async #hasSession(tmux: string, session: string): Promise<boolean> {
		// `has-session` exits non-zero when the session is absent, which is an
		// answer rather than a failure — so this does not go through `#tmuxRun`.
		const result = await run(tmux, ["has-session", "-t", `=${session}`], {
			timeoutMs: TMUX_TIMEOUT_MS,
		});
		return result.code === 0;
	}

	/**
	 * The pid of the process running in the session's pane — the JVM, because the
	 * launch line `exec`s over the shell (see the module doc).
	 */
	async #panePid(tmux: string, session: string): Promise<number | undefined> {
		const out = await this.#tmuxRun(tmux, [
			"list-panes",
			"-t",
			`=${session}`,
			"-F",
			"#{pane_pid}",
		]);
		const pid = Number.parseInt(out.trim().split("\n")[0] ?? "", 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	}
}

/**
 * Quote one argument for the shell tmux types the launch line into.
 *
 * Single quotes with the standard `'\''` escape: everything inside them is
 * literal, which is what a filesystem path or a JVM argument needs. Without this
 * a server directory containing a space would run the JVM against the wrong path
 * and a `$` in a path would expand to nothing.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
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
 * time so the UI can show a join address.
 */
async function readServerPort(dir: string): Promise<number> {
	const text = await readTextIfExists(join(dir, "server.properties"));
	if (!text) return DEFAULT_PORT;
	const match = /^\s*server-port\s*=\s*(\d+)\s*$/m.exec(text);
	const port = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
	return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}
