/**
 * The provider **interfaces** core is allowed to know about. Concrete providers
 * (`providers/server/`, `providers/runtime/`) implement these and register into
 * the `ProviderRegistry` at startup; core resolves them by id and never imports
 * one directly (AGENTS.md § 3, architecture.md § Provider system).
 *
 * No I/O, no UI. Interfaces only — this file must never import a concrete
 * provider, or the dependency arrow reverses.
 *
 * Phase 2 defines `ServerProvider` and `RuntimeProvider`. `BackupProvider` and
 * `NetworkProvider` arrive with their phases (4) — writing them now would be
 * designing against imaginary implementations.
 */

import type {
	InstallRequest,
	InstallStrategy,
	LaunchSpec,
	LoaderVersion,
	VersionInfo,
} from "./install.ts";
import type { JavaRequirement } from "./java.ts";
import type { RuntimeSession, Server, ServerState } from "./server.ts";

/** Common shape of every registered provider: a stable id and a display name. */
export interface Provider {
	/** Registry key. Matches the value stored in `mctl.json` (`kind` / `runtime`). */
	readonly id: string;
	/** Human-facing name for the UI, e.g. `"Paper"`. */
	readonly displayName: string;
}

/**
 * A server implementation (Vanilla, Paper, Fabric, …). Owns everything
 * kind-specific: which versions exist, what Java they need, how they install,
 * and how they launch.
 *
 * Every method that touches the network goes through `lib/http.ts`, so upstream
 * manifests are ETag-cached for free, and every response is Zod-validated inside
 * the provider — core receives only the flat view models declared here.
 */
export interface ServerProvider extends Provider {
	/**
	 * Every installable Minecraft version, newest first.
	 * @throws {HttpError} when upstream is unreachable and nothing is cached.
	 */
	minecraftVersions(): Promise<VersionInfo[]>;

	/**
	 * Loader builds available for a Minecraft version, newest first. Kinds without
	 * a loader (Vanilla, Paper) return `[]` rather than throwing — "no loader" is
	 * a normal answer, not an error.
	 */
	loaderVersions(minecraftVersion: string): Promise<LoaderVersion[]>;

	/**
	 * What upstream declares about Java for this version.
	 *
	 * Returns `null` when **no** upstream source declares anything — that is a
	 * meaningful answer, not a failure: it is the single case in which MCTL must
	 * ask the user and pin their choice into `mctl.json` rather than guess
	 * (plan.md § Java Manager, "Fallback").
	 */
	javaRequirement(
		minecraftVersion: string,
		loaderVersion?: string,
	): Promise<JavaRequirement | null>;

	/**
	 * Resolve the concrete steps needed to install this kind at the requested
	 * version. Pure metadata work — it performs no download itself, so a caller
	 * can show the user what will happen (and how big it is) before committing.
	 */
	resolveInstall(request: InstallRequest): Promise<InstallStrategy>;

	/**
	 * How to launch an installed server living at `dir`. Synchronous and
	 * filesystem-free for `directJar` kinds (the answer is always `server.jar`);
	 * Phase-3 kinds that must inspect generated files may widen this.
	 */
	launchSpec(dir: string): LaunchSpec;
}

/** Everything a runtime needs to actually start a server process. */
export interface LaunchContext {
	/** The server being started (id, path, memory, runtime — from `mctl.json`). */
	server: Server;
	/** What to launch, from {@link ServerProvider.launchSpec}. */
	spec: LaunchSpec;
	/** Absolute path to the resolved `java` executable. */
	javaPath: string;
	/** JVM arguments (heap sizing etc.) to place before the launch spec's args. */
	jvmArgs: string[];
}

/** Options for stopping a server. */
export interface StopOptions {
	/**
	 * How long to wait for a graceful shutdown (a `stop` console command, then
	 * SIGTERM) before escalating to SIGKILL. A Minecraft server saves its world on
	 * shutdown, so killing early risks losing recent chunks — the default is
	 * generous on purpose.
	 */
	timeoutMs?: number;
}

/** Options for reading a server's console output. */
export interface LogOptions {
	/** Emit the last N lines already captured before following. Default: all. */
	tail?: number;
	/** Keep the iterator open and yield new lines as they arrive. */
	follow?: boolean;
	/** Abort signal to stop following. */
	signal?: AbortSignal;
}

/**
 * A way of running a server process: attached to MCTL (`foreground`), or
 * detached so it outlives the instance (`tmux`, `docker` — Phase 3/5).
 *
 * **Deviations from plan.md § Runtime, both deliberate:**
 *  - `start` takes a {@link LaunchContext} rather than `(server, spec)`. A
 *    runtime cannot spawn anything without the resolved `java` binary and JVM
 *    args, and re-resolving them inside every runtime would duplicate
 *    `core/java/` in each provider.
 *  - `restart` is **not** here. It is a composition (stop, then start with a
 *    freshly resolved context) and lives on `RuntimeManager`, so every runtime
 *    gets identical restart semantics for free.
 */
export interface RuntimeProvider extends Provider {
	/**
	 * Start the server and write its session descriptor
	 * (`~/.local/state/mctl/runtime/<id>.json`) so any instance can re-identify it.
	 * @returns the descriptor that was written.
	 */
	start(context: LaunchContext): Promise<RuntimeSession>;

	/**
	 * Stop the server gracefully, escalating if it does not exit in time, and
	 * remove its session descriptor. A no-op when the server is not running.
	 */
	stop(server: Server, options?: StopOptions): Promise<void>;

	/** Stream the server's console output. */
	logs(server: Server, options?: LogOptions): AsyncIterable<string>;

	/**
	 * Send one line to the server's console stdin (e.g. `"say hello"`).
	 * @throws {SessionNotOwnedError} when this instance cannot reach the process's
	 *   stdin — see `providers/runtime/foreground.ts` for why that is possible.
	 */
	exec(server: Server, command: string): Promise<void>;

	/** Re-identify the server's state from its descriptor plus a liveness probe. */
	status(server: Server): Promise<ServerState>;
}
