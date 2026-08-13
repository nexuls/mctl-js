/**
 * RuntimeManager — everything that must happen *around* a runtime provider to
 * start or stop a server: resolve the provider, resolve Java, build the JVM
 * arguments, take the per-server lock, and announce the state change.
 *
 * Core service — no UI, no argv, no concrete provider imports. Both front-ends
 * call this rather than a provider directly, which is what guarantees a `mctl
 * start` from a script and a Start button in the TUI behave identically.
 *
 * **Why `restart` lives here and not on the provider.** A restart is "stop, then
 * start with a *freshly resolved* context" — the Java requirement or the memory
 * setting may have changed in between. Composing it once here gives every
 * runtime identical semantics; putting it on the interface would have every
 * provider re-implement the same resolution (types/provider.ts documents the
 * deviation from plan.md § Runtime).
 */

import { join } from "node:path";
import { pathExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import type { RootPaths } from "../../lib/paths.ts";
import type { Config } from "../../types/config.ts";
import type { LaunchSpec } from "../../types/install.ts";
import { EventType } from "../../types/events.ts";
import type {
	LaunchContext,
	LogOptions,
	StopOptions,
} from "../../types/provider.ts";
import type {
	RuntimeSession,
	Server,
	ServerState,
} from "../../types/server.ts";
import type { EventBus } from "../events/bus.ts";
import { publish } from "../events/log.ts";
import { resolveJava } from "../java/index.ts";
import type { NetworkManager } from "../network/index.ts";
import type { ProviderRegistry } from "../registry/provider-registry.ts";
import { withServerLock } from "../session/lock.ts";
import { getServer } from "../server/discover.ts";
import { ServerOperationError } from "../server/manager.ts";
import { launchInputs } from "./launch.ts";

const logger = log("runtime");

/**
 * Port assumed when a runtime recorded none. Every runtime reads `server-port`
 * from `server.properties` at start, so this is only reached for a server whose
 * descriptor predates that — and Minecraft's own default is the right guess.
 */
const DEFAULT_PORT = 25565;

/** Everything the manager needs, injected so it stays testable and UI-free. */
export interface RuntimeManagerDeps {
	/** Loaded, validated configuration. */
	config: Config;
	/** Data paths derived from it. */
	paths: RootPaths;
	/** Concrete providers registered for this process. */
	providers: ProviderRegistry;
	/** The process event bus. */
	bus: EventBus;
	/**
	 * Networking, applied around a start/stop.
	 *
	 * Optional so a test (or a future headless caller) can drive the runtime with
	 * no networking at all; absent means the server simply starts with no endpoint
	 * recorded. It is always present in `core/context.ts`, which is what both
	 * front-ends use.
	 */
	network?: NetworkManager;
}

/** Options for {@link RuntimeManager.start}. */
export interface StartOptions {
	/**
	 * Allow downloading a JDK if none installed satisfies the server's
	 * requirement. Default `true`; a UI that wants to prompt first passes `false`
	 * and handles `JavaNotResolvedError`.
	 */
	autoInstallJava?: boolean;
}

/**
 * Translate a memory string from `mctl.json` into JVM heap flags.
 *
 * Both `-Xms` and `-Xmx` are set to the same value on purpose: a Minecraft
 * server reaches its steady-state heap within minutes anyway, and pre-committing
 * it avoids the stop-the-world resizes that show up as lag spikes during the
 * first hour of play. This is also what every Minecraft launch script does.
 *
 * @throws {ServerOperationError} when the value is not a JVM size literal.
 */
export function heapArgs(memory: string): string[] {
	const value = memory.trim();
	if (!/^\d+[kmgKMG]?$/.test(value)) {
		throw new ServerOperationError(
			undefined,
			`invalid memory value "${memory}": expected a JVM size like "2G" or "4096M"`,
		);
	}
	return [`-Xms${value}`, `-Xmx${value}`];
}

/**
 * Put the heap flags where a generated launch script will read them.
 *
 * Forge's `run.sh` does not accept JVM arguments on its command line — it reads
 * `user_jvm_args.txt` and splices it into its own `java` invocation. So for a
 * `script` launch the only way to honour a server's `memory` setting is to write
 * that file, which MCTL therefore owns for such servers. It is rewritten on every
 * start (the setting may have changed) and comments explain its origin, because a
 * user who opens it after hand-editing it deserves to know why their edit went
 * away. A no-op for every other launch spec.
 */
async function writeScriptJvmArgs(
	spec: LaunchSpec,
	dir: string,
	jvmArgs: string[],
): Promise<void> {
	if (spec.kind !== "script" || !spec.jvmArgsFile) return;
	const body = [
		"# Written by MCTL on every start, from this server's `memory` setting.",
		"# Change it with `mctl edit <id> --memory 6G` — edits here are overwritten.",
		...jvmArgs,
		"",
	].join("\n");
	await Bun.write(join(dir, spec.jvmArgsFile), body);
}

export class RuntimeManager {
	readonly #deps: RuntimeManagerDeps;

	constructor(deps: RuntimeManagerDeps) {
		this.#deps = deps;
	}

	/**
	 * Start a server: resolve its provider, its Java, and its launch spec, then
	 * hand a complete {@link LaunchContext} to the runtime.
	 *
	 * Held under the server's lock for the whole resolution *and* spawn, so two
	 * instances racing on `mctl start survival` cannot both get past the
	 * already-running check (architecture.md § Statelessness, "Concurrency").
	 *
	 * @throws {ServerOperationError} when the server is missing, unavailable, or
	 *   already running.
	 * @throws {ResourceBusyError} when another instance is starting it right now.
	 * @throws {UnknownProviderError} for an unregistered `kind` or `runtime`.
	 * @throws {JavaNotResolvedError} when no suitable Java can be found or fetched.
	 *
	 * Networking is applied **after** the process is up and is never allowed to
	 * fail the start: a tunnel that will not come up degrades to direct, and even
	 * that is caught here. A running server the user can reach on the LAN beats no
	 * server at all (plan.md § Networking).
	 */
	async start(id: string, options: StartOptions = {}): Promise<RuntimeSession> {
		const { paths, providers, bus } = this.#deps;

		return withServerLock(id, async () => {
			const server = await this.#require(id);
			if (server.state === "running") {
				throw new ServerOperationError(id, `server "${id}" is already running`);
			}

			const kind = providers.server(server.kind);
			const runtime = providers.runtime(server.runtime);

			const requirement = await kind.javaRequirement(
				server.minecraftVersion,
				server.loaderVersion,
			);
			const java = await resolveJava(requirement, server.java, paths, {
				autoInstall: options.autoInstallJava !== false,
			});

			const jvmArgs = heapArgs(server.memory);
			const context: LaunchContext = {
				server,
				// The recorded spec wins: for Forge and NeoForge it names files the
				// *installer* generated, which the provider cannot re-derive without
				// knowing the loader version and re-checking upstream's layout. A server
				// with no recorded spec is a `server.jar` kind and the provider answers.
				spec: server.launch ?? kind.launchSpec(server.path),
				javaPath: java.installation.javaPath,
				jvmArgs,
			};
			await this.#verifyLaunchable(server, context.spec);
			// A generated launch script builds its own JVM command line and reads heap
			// flags from a file, so they are put where it will look before it runs.
			await writeScriptJvmArgs(context.spec, server.path, jvmArgs);

			const session = await runtime.start(context);
			logger.info(
				{ id, pid: session.pid, java: java.installation.major },
				"started server",
			);
			await publish(bus, EventType.ServerStateChanged, {
				id,
				state: "running",
			});
			await this.#expose(server, session);
			return session;
		});
	}

	/**
	 * Stop a server. A stop on an already-stopped server is a **no-op, not an
	 * error** — `mctl stop` in a teardown script must be safe to run twice.
	 */
	async stop(id: string, options: StopOptions = {}): Promise<void> {
		const { providers, bus } = this.#deps;
		const server = await this.#require(id);
		if (server.state !== "running") {
			logger.debug({ id }, "stop requested for a server that is not running");
			return;
		}
		// The runtime that *started* it owns the stop, which is why this reads
		// `server.runtime` from `mctl.json` rather than assuming the default.
		await providers.runtime(server.runtime).stop(server, options);
		logger.info({ id }, "stopped server");
		await publish(bus, EventType.ServerStateChanged, { id, state: "stopped" });
		// After the process is down, so an agent is never left forwarding to a port
		// nothing is listening on. Never allowed to fail a stop.
		await this.#deps.network?.teardown(server).catch((err: unknown) => {
			logger.warn({ id, err: String(err) }, "network teardown failed");
		});
	}

	/** Stop then start, re-resolving everything in between. */
	async restart(
		id: string,
		options: StartOptions & StopOptions = {},
	): Promise<RuntimeSession> {
		await this.stop(id, options);
		return this.start(id, options);
	}

	/** Stream a server's console output; see {@link LogOptions}. */
	async logs(
		id: string,
		options: LogOptions = {},
	): Promise<AsyncIterable<string>> {
		const server = await this.#require(id);
		return this.#deps.providers.runtime(server.runtime).logs(server, options);
	}

	/**
	 * Send one line to a server's console.
	 * @throws {ServerOperationError} when it is not running.
	 */
	async exec(id: string, command: string): Promise<void> {
		const server = await this.#require(id);
		if (server.state !== "running") {
			throw new ServerOperationError(id, `server "${id}" is not running`);
		}
		await this.#deps.providers.runtime(server.runtime).exec(server, command);
	}

	/** Live-probed state of one server. */
	async status(id: string): Promise<ServerState> {
		const server = await this.#require(id);
		return this.#deps.providers.runtime(server.runtime).status(server);
	}

	/**
	 * Expose a freshly started server through its network profile.
	 *
	 * Swallows everything: `NetworkManager.expose` already degrades to direct on
	 * any provider problem, so an exception here means something unexpected went
	 * wrong in MCTL itself — which is worth a log line and nothing more, because
	 * the server is already running and unwinding it would be a worse outcome
	 * than a missing join address.
	 */
	async #expose(server: Server, session: RuntimeSession): Promise<void> {
		const network = this.#deps.network;
		if (!network) return;
		try {
			const result = await network.expose(server, session.port ?? DEFAULT_PORT);
			if (result.degradedReason) {
				logger.warn(
					{ id: server.id, reason: result.degradedReason },
					"network profile degraded to direct",
				);
			}
		} catch (err) {
			logger.warn(
				{ id: server.id, err: String(err) },
				"could not expose server; it is running with no recorded endpoint",
			);
		}
	}

	/**
	 * Refuse to start when the files the launch spec names are not there.
	 *
	 * Worth its own check rather than letting the JVM report it: a missing jar
	 * produces `Error: Unable to access jarfile server.jar`, and a missing Forge
	 * argfile produces a JVM usage dump — neither of which tells the user that
	 * their install is incomplete or that the directory was moved. This says so.
	 */
	async #verifyLaunchable(server: Server, spec: LaunchSpec): Promise<void> {
		const missing: string[] = [];
		for (const file of launchInputs(spec, server.path)) {
			if (!(await pathExists(file))) missing.push(file);
		}
		if (missing.length > 0) {
			throw new ServerOperationError(
				server.id,
				`server "${server.id}" cannot start: ${missing.join(", ")} ${
					missing.length === 1 ? "is" : "are"
				} missing. The install may be incomplete — re-create the server or restore its files.`,
			);
		}
	}

	/** Load a server, rejecting missing and unavailable ones with a clear message. */
	async #require(id: string): Promise<Server> {
		const server = await getServer(id, this.#deps.paths.serversDir);
		if (!server) throw new ServerOperationError(id, `no such server: ${id}`);
		if (!server.available) {
			throw new ServerOperationError(
				id,
				`server "${id}" is unavailable (${server.path} is missing)`,
			);
		}
		return server;
	}
}
