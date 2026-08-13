/**
 * ProviderRegistry — the indirection that keeps core ignorant of concrete
 * providers. Providers register themselves at startup (wired in
 * `providers/index.ts`, called by each front-end); core only ever asks the
 * registry for "the provider with id `x`" (architecture.md § Provider system).
 *
 * Core service — no UI, no argv, no concrete provider imports. It depends on the
 * *interfaces* in `types/provider.ts` and nothing else.
 *
 * The ids are the values stored in a server's `mctl.json`: `kind` selects a
 * {@link ServerProvider}, `runtime` selects a {@link RuntimeProvider}. That is
 * why an unknown id is a typed, user-facing error and not an assertion — it means
 * a server was created by a build of MCTL that knows a kind this one does not.
 */

import type {
	NetworkProvider,
	RuntimeProvider,
	ServerProvider,
} from "../../types/provider.ts";

/**
 * Thrown when a server names a provider this build does not have. Carries the
 * available ids so a front-end can say what *is* supported rather than just
 * failing.
 */
export class UnknownProviderError extends Error {
	constructor(
		/** `"server"` or `"runtime"` — which registry was consulted. */
		readonly category: string,
		/** The id that could not be resolved. */
		readonly id: string,
		/** Ids that are registered, for a helpful message. */
		readonly available: string[],
	) {
		super(
			`unknown ${category} provider "${id}" (available: ${available.join(", ") || "none"})`,
		);
		this.name = "UnknownProviderError";
	}
}

/**
 * A registry of the concrete providers this process has available.
 *
 * Deliberately an instance rather than a module-level singleton: tests and the
 * two front-ends each build their own, and a global would be exactly the kind of
 * hidden authoritative state the rest of MCTL avoids.
 */
export class ProviderRegistry {
	readonly #servers = new Map<string, ServerProvider>();
	readonly #runtimes = new Map<string, RuntimeProvider>();
	readonly #networks = new Map<string, NetworkProvider>();

	/** Register a server-kind provider. Re-registering an id replaces it. */
	registerServer(provider: ServerProvider): this {
		this.#servers.set(provider.id, provider);
		return this;
	}

	/** Register a runtime provider. Re-registering an id replaces it. */
	registerRuntime(provider: RuntimeProvider): this {
		this.#runtimes.set(provider.id, provider);
		return this;
	}

	/**
	 * Register a network provider. Re-registering an id replaces it.
	 *
	 * Unlike `kind` and `runtime`, the id here is the `provider` field of a
	 * *network profile* in `config.json`, not a value in `mctl.json` — a server
	 * records a profile **name**, and the profile chooses the provider.
	 */
	registerNetwork(provider: NetworkProvider): this {
		this.#networks.set(provider.id, provider);
		return this;
	}

	/**
	 * Resolve a server-kind provider by the `kind` recorded in `mctl.json`.
	 * @throws {UnknownProviderError} when no provider claims that id.
	 */
	server(id: string): ServerProvider {
		const provider = this.#servers.get(id);
		if (!provider) {
			throw new UnknownProviderError("server", id, this.serverIds());
		}
		return provider;
	}

	/**
	 * Resolve a runtime provider by the `runtime` recorded in `mctl.json`.
	 * @throws {UnknownProviderError} when no provider claims that id.
	 */
	runtime(id: string): RuntimeProvider {
		const provider = this.#runtimes.get(id);
		if (!provider) {
			throw new UnknownProviderError("runtime", id, this.runtimeIds());
		}
		return provider;
	}

	/**
	 * Resolve a network provider by a profile's `provider` id.
	 * @throws {UnknownProviderError} when no provider claims that id.
	 */
	network(id: string): NetworkProvider {
		const provider = this.#networks.get(id);
		if (!provider) {
			throw new UnknownProviderError("network", id, this.networkIds());
		}
		return provider;
	}

	/** Every registered server provider, registration order. */
	servers(): ServerProvider[] {
		return [...this.#servers.values()];
	}

	/** Every registered runtime provider, registration order. */
	runtimes(): RuntimeProvider[] {
		return [...this.#runtimes.values()];
	}

	/** Ids of every registered server provider — what a UI offers on create. */
	serverIds(): string[] {
		return [...this.#servers.keys()];
	}

	/** Ids of every registered runtime provider. */
	runtimeIds(): string[] {
		return [...this.#runtimes.keys()];
	}

	/** Every registered network provider, registration order. */
	networks(): NetworkProvider[] {
		return [...this.#networks.values()];
	}

	/** Ids of every registered network provider — what a UI offers as a profile provider. */
	networkIds(): string[] {
		return [...this.#networks.keys()];
	}
}
