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

import { log } from "../../lib/logger.ts";
import type { RootPaths } from "../../lib/paths.ts";
import type { Config } from "../../types/config.ts";
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
import type { ProviderRegistry } from "../registry/provider-registry.ts";
import { withServerLock } from "../session/lock.ts";
import { getServer } from "../server/discover.ts";
import { ServerOperationError } from "../server/manager.ts";

const logger = log("runtime");

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

			const context: LaunchContext = {
				server,
				spec: kind.launchSpec(server.path),
				javaPath: java.installation.javaPath,
				jvmArgs: heapArgs(server.memory),
			};

			const session = await runtime.start(context);
			logger.info(
				{ id, pid: session.pid, java: java.installation.major },
				"started server",
			);
			await publish(bus, EventType.ServerStateChanged, {
				id,
				state: "running",
			});
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
