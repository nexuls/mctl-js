/**
 * TailscaleNetwork — reach a server over the user's tailnet.
 *
 * A concrete provider: `lib/`, `types/` and the shared descriptor helpers in
 * `./agent.ts` only; it imports no other provider and nothing from `app/`,
 * `cli/`, or `hooks/`.
 *
 * **This one starts no process, and that is not an oversight.** Tailscale is not
 * a per-service tunnel: the machine is already on the tailnet (its own daemon,
 * started by the user, running as a system service), so the server is *already*
 * reachable at the machine's tailnet address on whatever port it bound. There is
 * nothing for MCTL to launch — only an address to discover and report. So
 * `expose` writes a descriptor with no pid, exactly as `direct` does.
 *
 * The consequence, which the UI states plainly: only people on the same tailnet
 * can join. That is the *point* of this profile — a private server for a group
 * that already shares a tailnet — and it is a different offer from the public
 * tunnels, not a weaker version of them. (Tailscale Funnel exposes services to
 * the public internet, but over HTTPS only, so it cannot carry Minecraft.)
 *
 * https://tailscale.com/kb/1080/cli
 */

import { run, which } from "../../lib/shell.ts";
import type {
	Endpoint,
	ExposeRequest,
	NetStatus,
	Readiness,
	RequiredBinary,
} from "../../types/network.ts";
import type { NetworkProvider } from "../../types/provider.ts";
import { readTunnel, removeTunnel, writeTunnel } from "./agent.ts";

/** Options a `tailscale` profile understands. */
interface TailscaleOptions {
	/**
	 * Advertise the raw `100.x.y.z` address instead of the MagicDNS name.
	 * MagicDNS is the default because it survives a node getting a new address,
	 * but it is off on some tailnets — in which case this provider falls back to
	 * the IP on its own.
	 */
	preferIp?: boolean;
}

/** How long `tailscale status` may take before it is considered wedged. */
const STATUS_TIMEOUT_MS = 5_000;

/** The subset of `tailscale status --json` this provider reads. */
interface TailscaleStatus {
	BackendState?: string;
	Self?: { DNSName?: string; TailscaleIPs?: string[] };
	MagicDNSSuffix?: string;
}

export class TailscaleNetwork implements NetworkProvider {
	readonly id = "tailscale";
	readonly displayName = "Tailscale";

	requires(): RequiredBinary[] {
		return [
			{
				name: "tailscale",
				installHint:
					"curl -fsSL https://tailscale.com/install.sh | sh  (or brew install tailscale)",
				url: "https://tailscale.com/download",
			},
		];
	}

	/**
	 * Ready when the daemon is up **and logged in**. Unlike the tunnel agents,
	 * this can be checked cheaply and locally — `tailscale status` talks to the
	 * local daemon, not to Tailscale — so it is worth checking, and a logged-out
	 * node is the overwhelmingly common failure.
	 */
	async preflight(): Promise<Readiness> {
		const binary = await which("tailscale");
		if (!binary) {
			const [required] = this.requires();
			return {
				kind: "missing",
				binary: required!.name,
				hint: required!.installHint,
				url: required!.url,
			};
		}
		const status = await readStatus(binary);
		if (!status) {
			return {
				kind: "error",
				detail: "tailscale is installed but its daemon did not answer",
			};
		}
		if (status.BackendState !== "Running") {
			return {
				kind: "unauthenticated",
				detail: `tailscale is ${status.BackendState ?? "not running"}`,
				hint: "sudo tailscale up",
			};
		}
		return { kind: "ready", detail: nodeAddress(status)?.host };
	}

	async expose(request: ExposeRequest): Promise<Endpoint> {
		const options = (request.options ?? {}) as TailscaleOptions;
		const binary = await which("tailscale");
		if (!binary) throw new Error("tailscale is not installed");

		const status = await readStatus(binary);
		if (status?.BackendState !== "Running") {
			throw new Error(
				`this machine is not on a tailnet (${status?.BackendState ?? "no answer from the daemon"}). Run \`sudo tailscale up\`.`,
			);
		}
		const address = nodeAddress(status, options.preferIp);
		if (!address) {
			throw new Error(
				"tailscale is running but reports no address for this machine",
			);
		}

		const endpoint: Endpoint = {
			host: address.host,
			port: request.port,
			joinAddress: `${address.host}:${request.port}`,
			kind: "tunnel",
			provider: this.id,
			note: `Reachable to devices on your tailnet only${
				address.viaIp ? " (MagicDNS is off, so this is the raw tailnet IP)" : ""
			}. No port forward and no public exposure.`,
			alternates: address.alternate
				? [{ label: "ip", address: `${address.alternate}:${request.port}` }]
				: undefined,
		};

		await writeTunnel(request.serverId, {
			provider: this.id,
			profile: request.profile,
			// No pid: the tailscale daemon is the user's, started and stopped by
			// them. MCTL must never reap it — see the module doc.
			localPort: request.port,
			endpoint,
			startedAt: new Date().toISOString(),
		});
		return endpoint;
	}

	/** Forget the recorded address. The tailnet connection is not MCTL's to close. */
	async teardown(serverId: string): Promise<void> {
		const session = await readTunnel(serverId);
		if (session && session.provider !== this.id) return;
		await removeTunnel(serverId);
	}

	async status(serverId: string): Promise<NetStatus | undefined> {
		const session = await readTunnel(serverId);
		if (!session || session.provider !== this.id) return undefined;
		// The recorded address is only meaningful while the node is still on the
		// tailnet; a laptop that ran `tailscale down` is no longer reachable there.
		const readiness = await this.preflight();
		return {
			profile: session.profile,
			provider: this.id,
			providerName: this.displayName,
			state: readiness.kind === "ready" ? "up" : "degraded",
			readiness,
			endpoint: session.endpoint,
			since: session.startedAt,
			detail:
				readiness.kind === "ready"
					? undefined
					: "this machine has left the tailnet, so the address no longer resolves",
		};
	}
}

/** Ask the local daemon what it knows. `undefined` when it cannot be asked. */
async function readStatus(
	binary: string,
): Promise<TailscaleStatus | undefined> {
	try {
		const result = await run(binary, ["status", "--json"], {
			timeoutMs: STATUS_TIMEOUT_MS,
		});
		// A logged-out node exits non-zero but still prints usable JSON, so the
		// output is parsed regardless of the exit code and only a parse failure is
		// treated as "no answer".
		return JSON.parse(result.stdout) as TailscaleStatus;
	} catch {
		return undefined;
	}
}

/**
 * This node's address: the MagicDNS name when there is one, else the tailnet IP.
 *
 * `DNSName` arrives fully qualified with a trailing dot (`host.tail1234.ts.net.`)
 * — a valid DNS name, but the Minecraft client does not accept it, so the dot is
 * stripped.
 */
function nodeAddress(
	status: TailscaleStatus,
	preferIp = false,
): { host: string; viaIp: boolean; alternate?: string } | undefined {
	const ip = status.Self?.TailscaleIPs?.find((value) => value.includes("."));
	const dns = status.Self?.DNSName?.replace(/\.$/, "");
	if (preferIp && ip) return { host: ip, viaIp: true };
	if (dns) return { host: dns, viaIp: false, alternate: ip };
	if (ip) return { host: ip, viaIp: true };
	return undefined;
}
