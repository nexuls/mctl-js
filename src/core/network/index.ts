/**
 * NetworkManager — everything that must happen *around* a network provider to
 * make a server reachable: resolve its profile, check the provider is usable,
 * expose the port, optionally publish DNS records, and announce the result.
 *
 * Core service — no UI, no argv, no concrete provider imports. Both front-ends
 * call this rather than a provider directly, so `mctl start` from a script and
 * the Start button in the TUI produce the same tunnel.
 *
 * **The governing rule, straight from plan.md § Networking: networking must
 * never stop a server from starting.** A missing `cloudflared`, a logged-out
 * tailnet, an ngrok agent that will not authenticate — every one of these
 * degrades to `direct` with a stated reason, and the server runs. A player on
 * the LAN can still join. The alternative, refusing to start a Minecraft server
 * because a tunnel binary is absent, would be MCTL deciding that its optional
 * feature outranks the user's actual goal.
 *
 * **Nothing here is cached.** A server's networking state is re-derived from its
 * `network/<id>.json` descriptor plus a liveness probe on every read, exactly as
 * its run state is re-derived from `runtime/<id>.json`. Two instances therefore
 * agree about a tunnel without talking to each other.
 */

import { log } from "../../lib/logger.ts";
import type { Config, NetworkProfile } from "../../types/config.ts";
import { EventType } from "../../types/events.ts";
import {
	TunnelStartError,
	type DnsStatus,
	type Endpoint,
	type ExposeRequest,
	type NetStatus,
	type Readiness,
	type RequiredBinary,
} from "../../types/network.ts";
import type { NetworkProvider } from "../../types/provider.ts";
import type { Server } from "../../types/server.ts";
import { loadSecrets } from "../config/index.ts";
import type { EventBus } from "../events/bus.ts";
import { publish } from "../events/log.ts";
import { UnknownProviderError } from "../registry/provider-registry.ts";
import type { ProviderRegistry } from "../registry/provider-registry.ts";
import {
	CLOUDFLARE_TOKEN_KEY,
	CloudflareDnsError,
	removeDnsRecords,
	syncDnsRecords,
} from "./cloudflare-dns.ts";

const logger = log("network");

/** The profile every fallback lands on; always present in a valid config. */
const DIRECT = "direct";

/** Everything the manager needs, injected so it stays testable and UI-free. */
export interface NetworkManagerDeps {
	config: Config;
	providers: ProviderRegistry;
	bus: EventBus;
}

/** A profile as the UI lists it, with its provider already resolved. */
export interface ProfileSummary {
	/** Profile name (the value stored in a server's `mctl.json`). */
	name: string;
	/** Provider id the profile selects. */
	provider: string;
	/** Provider display name, or the id when this build has no such provider. */
	providerName: string;
	/** False when no registered provider claims `provider`. */
	known: boolean;
	/** Hostname this profile publishes to Cloudflare DNS, when configured. */
	dnsHostname?: string;
}

/** A provider's readiness, as the Network page lists it. */
export interface ProviderReadiness {
	provider: string;
	providerName: string;
	requires: RequiredBinary[];
	readiness: Readiness;
}

/** What {@link NetworkManager.expose} produced. */
export interface ExposeResult {
	endpoint: Endpoint;
	/** Profile actually used — differs from the requested one after a fallback. */
	profile: string;
	/** Provider actually used. */
	provider: string;
	/** Set when the requested provider could not be used; says why, in user words. */
	degradedReason?: string;
	/** Hostname the DNS records publish, when they were written. */
	dnsHostname?: string;
	/** Set when DNS was configured but failed; the server is up regardless. */
	dnsError?: string;
	/**
	 * Set when DNS was configured and deliberately **not** written — today only
	 * for a hostname the tunnel already serves. Distinct from `dnsError` because
	 * nothing is wrong: there is simply nothing for MCTL to publish.
	 */
	dnsSkipped?: string;
}

export class NetworkManager {
	readonly #deps: NetworkManagerDeps;

	constructor(deps: NetworkManagerDeps) {
		this.#deps = deps;
	}

	/** Every configured profile, with its provider resolved for display. */
	profiles(): ProfileSummary[] {
		const { config, providers } = this.#deps;
		return Object.entries(config.network.profiles).map(([name, profile]) => {
			let providerName = profile.provider;
			let known = true;
			try {
				providerName = providers.network(profile.provider).displayName;
			} catch {
				known = false;
			}
			return {
				name,
				provider: profile.provider,
				providerName,
				known,
				dnsHostname: profile.dns?.hostname,
			};
		});
	}

	/**
	 * Readiness of every registered provider, for the Network page's table.
	 * Never throws: a provider whose preflight blows up is reported as an error
	 * row rather than taking the page down.
	 */
	async readiness(): Promise<ProviderReadiness[]> {
		const secrets = await loadSecrets();
		return Promise.all(
			this.#deps.providers.networks().map(async (provider) => ({
				provider: provider.id,
				providerName: provider.displayName,
				requires: provider.requires(),
				readiness: await provider
					.preflight(scopedSecrets(provider.id, secrets))
					.catch((err): Readiness => ({ kind: "error", detail: String(err) })),
			})),
		);
	}

	/**
	 * Make a running server reachable, falling back to `direct` when its profile
	 * cannot be honoured.
	 *
	 * Called by `RuntimeManager` right after a successful start, with the port the
	 * runtime recorded. It never throws for a networking reason — see the module
	 * doc — so the caller does not have to decide whether a tunnel failure should
	 * unwind a start that already succeeded.
	 */
	async expose(server: Server, port: number): Promise<ExposeResult> {
		const requested = this.#resolveProfile(server.network);
		const secrets = await loadSecrets();

		let profileName = requested.name;
		let profile = requested.profile;
		let provider: NetworkProvider;
		let degradedReason: string | undefined;

		try {
			provider = this.#deps.providers.network(profile.provider);
			const readiness = await provider.preflight(
				scopedSecrets(provider.id, secrets),
			);
			if (readiness.kind !== "ready") {
				degradedReason = describeReadiness(provider.displayName, readiness);
			}
		} catch (err) {
			degradedReason =
				err instanceof UnknownProviderError
					? `this build has no "${profile.provider}" network provider`
					: String(err);
		}

		if (degradedReason) {
			({ profileName, profile, provider } = this.#fallback());
		} else {
			provider = this.#deps.providers.network(profile.provider);
		}

		let endpoint: Endpoint;
		try {
			endpoint = await provider.expose(
				this.#request(server, port, profileName, profile, secrets, provider.id),
			);
		} catch (err) {
			if (provider.id === DIRECT) {
				// The floor gave way. Nothing sensible is left to fall back to, and
				// this is genuinely exceptional (it means reading this machine's own
				// interfaces failed), so it surfaces rather than being swallowed.
				throw err;
			}
			logger.warn(
				{ id: server.id, provider: provider.id, err: String(err) },
				"tunnel failed to come up; falling back to direct",
			);
			degradedReason = `${provider.displayName} did not come up: ${errorText(err)}`;
			({ profileName, profile, provider } = this.#fallback());
			endpoint = await provider.expose(
				this.#request(server, port, profileName, profile, secrets, provider.id),
			);
		}

		const dns = await this.#syncDns(server.id, profile, endpoint, secrets);
		if (dns?.hostname) {
			// The DNS name is now the address players use — that is the whole point
			// of publishing it — so it replaces the raw one on the endpoint.
			endpoint = {
				...endpoint,
				joinAddress: dns.hostname,
				alternates: [
					...(endpoint.alternates ?? []),
					{ label: "origin", address: `${endpoint.host}:${endpoint.port}` },
				],
			};
		}

		await publish(this.#deps.bus, EventType.TunnelUp, {
			id: server.id,
			provider: provider.id,
			profile: profileName,
			joinAddress: endpoint.joinAddress,
			kind: endpoint.kind,
		});

		return {
			endpoint,
			profile: profileName,
			provider: provider.id,
			degradedReason,
			dnsHostname: dns?.hostname,
			dnsError: dns?.error,
			dnsSkipped: dns?.skipped,
		};
	}

	/**
	 * Tear down whatever is recorded for a server: the agent, and any DNS records
	 * MCTL published for it. Safe to call for a server that never had a tunnel.
	 *
	 * The provider is taken from the **descriptor**, not from the current profile:
	 * a user who edits a server's profile while it is running must not leave an
	 * ngrok agent orphaned because cloudflared was asked to stop it.
	 */
	async teardown(server: Server): Promise<void> {
		const { providers, bus } = this.#deps;
		const recorded = await this.#recordedProvider(server.id);
		const ids = recorded ? [recorded] : providers.networkIds();

		for (const id of ids) {
			try {
				await providers.network(id).teardown(server.id);
			} catch (err) {
				logger.warn(
					{ id: server.id, provider: id, err: String(err) },
					"tunnel teardown failed",
				);
			}
		}

		const { profile } = this.#resolveProfile(server.network);
		if (profile.dns) {
			const secrets = await loadSecrets();
			const token = secrets[CLOUDFLARE_TOKEN_KEY];
			if (token) {
				try {
					const removed = await removeDnsRecords(profile.dns, {
						serverId: server.id,
						token,
					});
					await publish(bus, EventType.DnsChanged, {
						id: server.id,
						hostname: profile.dns.hostname,
						records: removed.length,
						action: "removed",
					});
				} catch (err) {
					// A stale record is a nuisance, not a reason to fail a stop.
					logger.warn(
						{ id: server.id, err: errorText(err) },
						"could not remove dns records",
					);
				}
			}
		}

		await publish(bus, EventType.TunnelDown, {
			id: server.id,
			provider: recorded ?? "unknown",
			reason: "teardown",
		});
	}

	/**
	 * This server's networking as it stands right now — re-derived, never cached.
	 *
	 * A stopped server with no descriptor is `inactive`; a running server whose
	 * profile wants a tunnel that is not there is `down`; a server reachable by an
	 * address other than the one its profile asked for is `degraded`.
	 */
	async status(server: Server): Promise<NetStatus> {
		const { providers } = this.#deps;
		const { name, profile } = this.#resolveProfile(server.network);

		let provider: NetworkProvider | undefined;
		let readiness: Readiness = { kind: "ready" };
		try {
			provider = providers.network(profile.provider);
			readiness = await provider
				.preflight(scopedSecrets(provider.id, await loadSecrets()))
				.catch((err): Readiness => ({ kind: "error", detail: String(err) }));
		} catch {
			readiness = {
				kind: "error",
				detail: `this build has no "${profile.provider}" network provider`,
			};
		}

		const dns = await this.#dnsStatus(profile);

		// Asked of *every* provider, not just the profile's: the live tunnel may
		// have been started under a different profile, and reporting "down" while
		// an ngrok agent is running would be a lie the user cannot act on.
		for (const candidate of providers.networks()) {
			const status = await candidate.status(server.id).catch(() => undefined);
			if (!status) continue;
			const matches = candidate.id === profile.provider;
			return {
				...status,
				profile: name,
				state: matches ? status.state : "degraded",
				detail:
					status.detail ??
					(matches
						? undefined
						: `running on ${candidate.displayName}, but this server's profile asks for ${profile.provider}`),
			};
		}

		return {
			profile: name,
			provider: profile.provider,
			providerName: provider?.displayName ?? profile.provider,
			state: server.state === "running" ? "down" : "inactive",
			readiness,
			detail:
				server.state === "running"
					? "no endpoint is recorded for this server"
					: undefined,
			dns,
		};
	}

	/**
	 * What this profile's DNS automation can do right now, or `undefined` when it
	 * configures none.
	 *
	 * Re-derived like everything else: whether a token exists is a fact about the
	 * filesystem this second, and it is the single most common reason records are
	 * not published — silently, since nothing publishes anything without one.
	 */
	async #dnsStatus(profile: NetworkProfile): Promise<DnsStatus | undefined> {
		if (!profile.dns) return undefined;
		const secrets = await loadSecrets();
		if (!secrets[CLOUDFLARE_TOKEN_KEY]) {
			return {
				hostname: profile.dns.hostname,
				state: "no-token",
				detail: `no ${CLOUDFLARE_TOKEN_KEY} in secrets.json — records are not published (set one with \`mctl secret set ${CLOUDFLARE_TOKEN_KEY}\`)`,
			};
		}
		return { hostname: profile.dns.hostname, state: "ready" };
	}

	/** Assemble a provider's request, handing it only its own secrets. */
	#request(
		server: Server,
		port: number,
		profileName: string,
		profile: NetworkProfile,
		secrets: Readonly<Record<string, string>>,
		providerId: string,
	): ExposeRequest {
		return {
			serverId: server.id,
			serverPath: server.path,
			port,
			profile: profileName,
			options: profile.options ?? {},
			secrets: scopedSecrets(providerId, secrets),
		};
	}

	/**
	 * The profile a server names, or the direct fallback.
	 *
	 * A server pointing at a profile that has since been deleted from
	 * `config.json` is a normal consequence of editing settings, not an error
	 * worth stopping a start for — it degrades like everything else here.
	 */
	#resolveProfile(name: string): { name: string; profile: NetworkProfile } {
		const profiles = this.#deps.config.network.profiles;
		const profile = profiles[name];
		if (profile) return { name, profile };
		return {
			name: DIRECT,
			profile: profiles[DIRECT] ?? { provider: DIRECT },
		};
	}

	/** The direct profile and its provider — the floor every failure lands on. */
	#fallback(): {
		profileName: string;
		profile: NetworkProfile;
		provider: NetworkProvider;
	} {
		const profile = this.#deps.config.network.profiles[DIRECT] ?? {
			provider: DIRECT,
		};
		return {
			profileName: DIRECT,
			profile,
			provider: this.#deps.providers.network(DIRECT),
		};
	}

	/** Which provider owns this server's recorded endpoint, if any. */
	async #recordedProvider(serverId: string): Promise<string | undefined> {
		for (const provider of this.#deps.providers.networks()) {
			const status = await provider.status(serverId).catch(() => undefined);
			if (status) return provider.id;
		}
		return undefined;
	}

	/**
	 * Publish DNS records for an endpoint, if the profile asks for it.
	 *
	 * Failure is reported, never thrown: the server is up and reachable at the
	 * address the provider gave, and a DNS problem (a token missing a permission,
	 * Cloudflare being down) must not undo that.
	 */
	async #syncDns(
		serverId: string,
		profile: NetworkProfile,
		endpoint: Endpoint,
		secrets: Readonly<Record<string, string>>,
	): Promise<
		{ hostname?: string; error?: string; skipped?: string } | undefined
	> {
		if (!profile.dns) return undefined;
		// Nothing to publish when the address already *is* the hostname: that is a
		// pre-defined Cloudflare tunnel, whose record was created by
		// `cloudflared tunnel route dns` and points at `<uuid>.cfargotunnel.com`.
		// Writing our own would be a CNAME from the name to itself, which either
		// the API rejects or resolution breaks on — and which would replace the
		// record that actually makes the tunnel reachable.
		if (isSelfReferential(profile.dns.hostname, endpoint)) {
			return { skipped: SELF_DNS_DETAIL };
		}
		const token = secrets[CLOUDFLARE_TOKEN_KEY];
		if (!token) {
			return {
				error: `no ${CLOUDFLARE_TOKEN_KEY} in secrets.json (or MCTL_${CLOUDFLARE_TOKEN_KEY}) — DNS records were not published`,
			};
		}
		try {
			const result = await syncDnsRecords(profile.dns, {
				serverId,
				endpoint,
				token,
			});
			await publish(this.#deps.bus, EventType.DnsChanged, {
				id: serverId,
				hostname: result.hostname,
				records: result.records.length,
				action: "synced",
			});
			return { hostname: result.hostname };
		} catch (err) {
			const detail =
				err instanceof CloudflareDnsError ? err.message : errorText(err);
			logger.warn({ id: serverId, err: detail }, "dns sync failed");
			return { error: detail };
		}
	}
}

/** What the UI says about a profile publishing a name the tunnel already serves. */
const SELF_DNS_DETAIL =
	"this tunnel already serves that hostname — `cloudflared tunnel route dns` owns the record, so MCTL publishes nothing";

/**
 * Whether publishing `hostname` for this endpoint would point the name at
 * itself.
 *
 * True for a pre-defined Cloudflare tunnel, whose announced host *is* the
 * hostname its ingress serves. Compared case-insensitively and without a
 * trailing dot, because DNS names are, and a mismatch here would write the very
 * record this exists to prevent.
 */
function isSelfReferential(
	hostname: string,
	endpoint: Endpoint | undefined,
): boolean {
	if (!endpoint) return false;
	const normal = (value: string) =>
		value.trim().replace(/\.$/, "").toLowerCase();
	return normal(hostname) === normal(endpoint.host);
}

/**
 * The subset of `secrets.json` a provider is allowed to see: keys prefixed with
 * its own id, upper-cased (`ngrok` → `NGROK_*`).
 *
 * Handing every provider the whole secret store would work and would be wrong:
 * a tunnel agent's environment has no business containing an S3 key, and the
 * cheapest way to keep a credential out of a process is to never put it there
 * (AGENTS.md § Secrets). Secret keys are UPPER_SNAKE by convention
 * (`core/config/`), which is what makes this prefix rule exact rather than a
 * guess.
 */
export function scopedSecrets(
	providerId: string,
	secrets: Readonly<Record<string, string>>,
): Record<string, string> {
	const prefix = `${providerId.toUpperCase()}_`;
	const scoped: Record<string, string> = {};
	for (const [key, value] of Object.entries(secrets)) {
		if (key.startsWith(prefix)) scoped[key] = value;
	}
	return scoped;
}

/** Turn a non-ready {@link Readiness} into a sentence for the fallback notice. */
function describeReadiness(name: string, readiness: Readiness): string {
	switch (readiness.kind) {
		case "ready":
			return "";
		case "missing":
			return `${readiness.binary} is not installed (${readiness.hint})`;
		case "unauthenticated":
			return `${name}: ${readiness.detail} — ${readiness.hint}`;
		case "error":
			return `${name}: ${readiness.detail}`;
	}
}

/**
 * An error's message without the stack, for a user-facing string.
 *
 * A {@link TunnelStartError} carries the tail of the agent's **own** output, and
 * that is the only real diagnosis there is: "cloudflared did not announce an
 * address within 30s" describes the symptom, while the line the agent printed
 * ("tunnel credentials file not found") names the cause and what to do about it.
 * Reporting only the timeout is what makes a broken tunnel look like a mystery.
 */
function errorText(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const output =
		err instanceof TunnelStartError
			? lastMeaningfulLine(err.output)
			: undefined;
	return output ? `${err.message} — the agent said: ${output}` : err.message;
}

/**
 * The last line of an agent's output that says something.
 *
 * Blank lines and the progress/banner noise agents print while starting are
 * dropped, and only one line is kept: this ends up in a table cell and a toast
 * description, and the full capture is in `network/<id>.log` for anyone who
 * wants it.
 */
function lastMeaningfulLine(output: string | undefined): string | undefined {
	const line = (output ?? "")
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.at(-1);
	return line && line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
