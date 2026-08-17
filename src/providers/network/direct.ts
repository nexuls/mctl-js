/**
 * DirectNetwork — no tunnel: report the addresses this machine already has.
 *
 * A concrete provider: `lib/` and `types/` only; it imports no other provider
 * and nothing from `app/`, `cli/`, or `hooks/`.
 *
 * This is the default profile and the fallback every other provider degrades to,
 * so it is deliberately the one provider that **cannot fail**: it needs no
 * binary, no account and no network, and its `preflight` is always ready.
 *
 * **What it does and does not claim.** It reports the LAN address (which a
 * player on the same network can genuinely use) and, unless the profile turns it
 * off, the public address as seen from outside. The public one is reported as an
 * *address*, never as "reachable": whether a player on the internet can connect
 * additionally depends on a port forward MCTL cannot see, let alone create.
 * Saying "your public IP is x.y.z.w" is true; saying "players can join at
 * x.y.z.w:25565" would not be, and that distinction is why the endpoint carries
 * a note rather than a claim.
 */

import { lanAddress, publicAddress } from "../../lib/net.ts";
import type {
	Endpoint,
	ExposeRequest,
	NetStatus,
	Readiness,
	RequiredBinary,
} from "../../types/network.ts";
import type { NetworkProvider } from "../../types/provider.ts";
import { readTunnel, removeTunnel, writeTunnel } from "./agent.ts";

/** Options a `direct` profile understands. */
interface DirectOptions {
	/**
	 * Look up this machine's public address through an external echo service.
	 * Default `true`. Turning it off keeps MCTL from talking to any third party
	 * on a server's start — worth having for an air-gapped or privacy-sensitive
	 * host, where the lookup would fail slowly and tell nobody anything.
	 */
	publicAddress?: boolean;
	/**
	 * Advertise this address instead of a detected one. For the host that already
	 * knows its own name — a VPS with a domain, a machine behind a router the
	 * user has forwarded by hand.
	 */
	host?: string;
}

export class DirectNetwork implements NetworkProvider {
	readonly id = "direct";
	readonly displayName = "Direct";

	/** No external binary — that is the whole point of this provider. */
	/** @see NetworkProvider.options */
	readonly options = [
		{
			key: "host",
			label: "Advertise host",
			kind: "text" as const,
			hint: "a name you already own",
			placeholder: "detected LAN address",
		},
		{
			key: "publicAddress",
			label: "Look up public address",
			kind: "boolean" as const,
			fallback: true,
			hint: "asks an external echo service",
			wide: true,
		},
	];

	requires(): RequiredBinary[] {
		return [];
	}

	/** Always ready. See the module doc: this is the floor everything falls back to. */
	async preflight(): Promise<Readiness> {
		return { kind: "ready", detail: "no external dependency" };
	}

	/**
	 * Report the join address for a server on this machine.
	 *
	 * A descriptor is written even though there is no process, because "this
	 * server is on the direct profile and its address is X" is a fact other
	 * instances should be able to read without redoing the lookups — and because
	 * teardown then has one uniform thing to clean up whatever the profile was.
	 */
	async expose(request: ExposeRequest): Promise<Endpoint> {
		const options = (request.options ?? {}) as DirectOptions;
		const lan = lanAddress();
		const wan =
			options.publicAddress === false ? undefined : await publicAddress();
		const host = options.host ?? lan ?? "localhost";

		const alternates: { label: string; address: string }[] = [];
		if (options.host && lan) {
			alternates.push({ label: "lan", address: `${lan}:${request.port}` });
		}
		if (wan)
			alternates.push({ label: "public", address: `${wan}:${request.port}` });

		const endpoint: Endpoint = {
			host,
			port: request.port,
			joinAddress: `${host}:${request.port}`,
			kind: "direct",
			provider: this.id,
			note:
				wan === undefined
					? "Reaching this from the internet needs a port forward or a tunnel."
					: `Public address ${wan} — players outside your network also need port ${request.port} forwarded to this machine.`,
			alternates: alternates.length > 0 ? alternates : undefined,
		};

		await writeTunnel(request.serverId, {
			provider: this.id,
			profile: request.profile,
			// No pid: there is no agent. `readTunnel` therefore never reaps this
			// descriptor, which is correct — a direct address does not "die", it is
			// simply superseded by the next start or removed by teardown.
			localPort: request.port,
			endpoint,
			startedAt: new Date().toISOString(),
		});
		return endpoint;
	}

	/** Forget the recorded address. There is no process to stop. */
	async teardown(serverId: string): Promise<void> {
		const session = await readTunnel(serverId);
		if (session && session.provider !== this.id) return;
		await removeTunnel(serverId);
	}

	async status(serverId: string): Promise<NetStatus | undefined> {
		const session = await readTunnel(serverId);
		if (!session || session.provider !== this.id) return undefined;
		return {
			profile: session.profile,
			provider: this.id,
			providerName: this.displayName,
			state: "up",
			readiness: { kind: "ready" },
			endpoint: session.endpoint,
			since: session.startedAt,
		};
	}
}
