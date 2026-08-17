/**
 * The provider **interfaces** core is allowed to know about. Concrete providers
 * (`providers/server/`, `providers/runtime/`) implement these and register into
 * the `ProviderRegistry` at startup; core resolves them by id and never imports
 * one directly (AGENTS.md § 3, architecture.md § Provider system).
 *
 * No I/O, no UI. Interfaces only — this file must never import a concrete
 * provider, or the dependency arrow reverses.
 *
 * Phase 2 defines `ServerProvider` and `RuntimeProvider`; Phase 4 adds
 * `NetworkProvider`. `BackupProvider` arrives with the backup subsystem —
 * writing it now would be designing against imaginary implementations.
 */

import type { ContentSupport } from "./content.ts";
import type {
	InstallRequest,
	InstallStrategy,
	LaunchSpec,
	LoaderVersion,
	VersionInfo,
} from "./install.ts";
import type { JavaRequirement } from "./java.ts";
import type {
	Endpoint,
	ExposeRequest,
	NetStatus,
	NetworkOption,
	Readiness,
	RequiredBinary,
} from "./network.ts";
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
	 * One line explaining what this kind *is*, for a UI that offers the choice.
	 *
	 * Required rather than optional on purpose: the create form asks the user to
	 * pick between nine names that mean nothing without it ("Purpur"? "Quilt"?),
	 * and an optional field is one a new provider silently omits. Keep it to a
	 * short phrase — it is rendered on one terminal row beside the picker, so it
	 * must survive being truncated at roughly 60 cells.
	 */
	readonly description: string;

	/**
	 * Which sorts of add-on this kind actually loads.
	 *
	 * Not a filesystem question, which is why it belongs to the provider: a Paper
	 * server has no `mods/` directory and never will, while a Fabric server that
	 * has none simply has nothing installed yet. Both look identical on disk, and
	 * only the kind knows the difference — so a UI offering "Mods" to a Paper
	 * server, or a marketplace button that could only ever install something the
	 * server ignores, is a bug this field exists to prevent.
	 *
	 * Required, like {@link description}, so a new provider must decide rather
	 * than inherit a default that happens to be wrong for it. Note the two that
	 * are easy to get backwards: **Velocity is a proxy**, so it takes plugins but
	 * has no world and therefore no datapacks; **Vanilla takes datapacks only**.
	 */
	readonly content: ContentSupport;

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

/**
 * A way of making a server reachable: `direct` (report the addresses this
 * machine already has) or a tunnel agent (`cloudflared`, `playit`, `ngrok`,
 * `tailscale`).
 *
 * **Deviations from plan.md § Networking, both deliberate:**
 *  - `expose` takes an {@link ExposeRequest} rather than `(server, port)`. A
 *    provider needs its profile options and its secrets, and neither belongs on
 *    the `Server` view model — `mctl.json` names a *profile*, and the profile's
 *    contents live in `config.json` while its credentials live in
 *    `secrets.json`. Passing a resolved request keeps providers off both files.
 *  - `status` takes the server id rather than the `Server`, because it must be
 *    answerable for a server that is not running (that is precisely when "is
 *    there a stale tunnel?" matters).
 *
 * Every implementation must hold to two rules that come from the plan:
 *  - **Never download the binary.** {@link requires} declares it,
 *    {@link preflight} reports its absence, and `NetworkManager` degrades to
 *    direct rather than failing a server's start.
 *  - **Never log or return a secret.** Tokens arrive in `ExposeRequest.secrets`,
 *    go into the child's environment, and appear nowhere else.
 */
export interface NetworkProvider extends Provider {
	/** External binaries this provider needs, with install hints. `[]` for `direct`. */
	requires(): RequiredBinary[];

	/**
	 * The settings this provider reads out of a profile's `options`, in the order
	 * a form should show them. `[]` for a provider with none.
	 *
	 * Required rather than optional, and declared here rather than listed beside
	 * the Settings form, for the same reason `ServerProvider.content` is: only the
	 * provider knows what it reads, the UI may not import a provider, and an
	 * optional field is one a new provider silently omits — leaving the user a
	 * free-text box and no idea what may go in it.
	 */
	readonly options: readonly NetworkOption[];

	/**
	 * Can this provider be used right now? Checks the binary is on `$PATH` and,
	 * where the agent can be asked cheaply, that it is authenticated.
	 *
	 * Never throws: an unusable provider is a {@link Readiness} value, because
	 * "cloudflared is not installed" is a normal state of the world that the UI
	 * shows in a row, not an exception that aborts a page.
	 */
	preflight(secrets?: Readonly<Record<string, string>>): Promise<Readiness>;

	/**
	 * Make the server reachable and return the endpoint players should use.
	 *
	 * Providers that own an agent process spawn it **detached** and write
	 * `~/.local/state/mctl/network/<id>.json`, so any later instance can find and
	 * stop it — the same no-IPC mechanism the detached runtimes use.
	 *
	 * @throws {Error} when the agent could not be started or announced no address
	 *   within its timeout. `NetworkManager` catches this and degrades to direct.
	 */
	expose(request: ExposeRequest): Promise<Endpoint>;

	/**
	 * Tear down whatever `expose` created and remove the descriptor. A no-op when
	 * nothing is up — `mctl stop` in a teardown script must be safe to run twice.
	 */
	teardown(serverId: string): Promise<void>;

	/**
	 * Re-derive this server's networking state from the descriptor plus a
	 * liveness probe. Returns `undefined` when this provider has nothing recorded
	 * for the server, which `NetworkManager` renders as `down`/`inactive`
	 * depending on whether the server is running.
	 */
	status(serverId: string): Promise<NetStatus | undefined>;
}
