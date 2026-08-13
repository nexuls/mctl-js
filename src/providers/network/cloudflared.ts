/**
 * CloudflaredNetwork — expose a server through a Cloudflare Tunnel.
 *
 * A concrete provider: `lib/`, `types/` and the shared agent machinery in
 * `./agent.ts` only; it imports no other provider and nothing from `app/`,
 * `cli/`, or `hooks/`.
 *
 * Two modes, because Cloudflare has two genuinely different products here:
 *
 *  - **Quick tunnel** (no options): `cloudflared tunnel --url tcp://…` gets a
 *    throwaway `*.trycloudflare.com` hostname with no account at all. It is the
 *    zero-setup path and the one MCTL uses by default.
 *  - **Named tunnel** (`options.tunnel`): `cloudflared tunnel run <name>` runs a
 *    tunnel the user already created and pointed at a hostname on their own
 *    domain. MCTL does not create or configure it — that is `cloudflared`'s own
 *    setup flow, with its own browser login, and wrapping it would be MCTL
 *    pretending to own an account it does not.
 *
 * **The thing every user must be told, and which reads as a broken tunnel if
 * they are not:** a Cloudflare tunnel carrying TCP is *not* directly joinable
 * from a vanilla Minecraft client. Cloudflare terminates TLS and speaks HTTP(S)
 * at the edge; reaching a TCP service behind it requires the **player** to run
 *
 *     cloudflared access tcp --hostname <host> --url localhost:25565
 *
 * and then join `localhost:25565`. That is a real limitation of the product, not
 * of MCTL, so the endpoint carries it as a note rather than hiding it.
 * (Cloudflare Spectrum removes the requirement and is an enterprise feature.)
 *
 * https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
 */

import { which } from "../../lib/shell.ts";
import type {
	Endpoint,
	ExposeRequest,
	NetStatus,
	Readiness,
	RequiredBinary,
} from "../../types/network.ts";
import type { NetworkProvider } from "../../types/provider.ts";
import {
	agentStatus,
	startAgent,
	stopAgent,
	type AnnouncedAddress,
} from "./agent.ts";

/** Options a `cloudflared` profile understands. */
interface CloudflaredOptions {
	/** Named tunnel to run. Absent ⇒ a throwaway `trycloudflare.com` quick tunnel. */
	tunnel?: string;
	/** Hostname the named tunnel's ingress serves. Required with `tunnel`. */
	hostname?: string;
	/** Seconds to wait for the tunnel to come up. Default 30. */
	timeoutSeconds?: number;
}

/**
 * The quick-tunnel hostname, printed inside cloudflared's boxed banner. Matched
 * on the URL rather than the banner because the banner's box drawing has changed
 * between releases and the URL has not.
 */
const QUICK_TUNNEL_RE = /https?:\/\/([a-z0-9-]+\.trycloudflare\.com)/i;

/** What a named tunnel prints once it is actually carrying traffic. */
const CONNECTION_REGISTERED_RE = /Registered tunnel connection/i;

/** The port a Cloudflare hostname is reached on — always the HTTPS edge. */
const EDGE_PORT = 443;

export class CloudflaredNetwork implements NetworkProvider {
	readonly id = "cloudflared";
	readonly displayName = "Cloudflare Tunnel";

	requires(): RequiredBinary[] {
		return [
			{
				name: "cloudflared",
				installHint:
					"brew install cloudflared / pacman -S cloudflared / see the Cloudflare docs for apt & rpm",
				url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
			},
		];
	}

	/**
	 * Ready when the binary exists. Authentication is deliberately **not**
	 * checked: a quick tunnel needs none, and probing `cloudflared tunnel list`
	 * for the named case would make every readiness poll an authenticated API
	 * call against Cloudflare.
	 */
	async preflight(): Promise<Readiness> {
		const binary = await which("cloudflared");
		if (!binary) {
			const [required] = this.requires();
			return {
				kind: "missing",
				binary: required!.name,
				hint: required!.installHint,
				url: required!.url,
			};
		}
		return { kind: "ready" };
	}

	async expose(request: ExposeRequest): Promise<Endpoint> {
		const options = (request.options ?? {}) as CloudflaredOptions;
		const binary = await which("cloudflared");
		if (!binary) throw new Error("cloudflared is not installed");

		const named = options.tunnel !== undefined;
		if (named && !options.hostname) {
			throw new Error(
				'a cloudflared profile with "tunnel" must also set "hostname" — MCTL cannot know which hostname your tunnel\'s ingress serves',
			);
		}

		const args = named
			? ["tunnel", "--no-autoupdate", "run", options.tunnel!]
			: [
					"tunnel",
					"--no-autoupdate",
					"--url",
					`tcp://localhost:${request.port}`,
				];

		const hostname = options.hostname;
		const session = await startAgent({
			serverId: request.serverId,
			provider: this.id,
			profile: request.profile,
			localPort: request.port,
			command: binary,
			args,
			cwd: request.serverPath,
			timeoutMs: (options.timeoutSeconds ?? 30) * 1000,
			match: named
				? (line) => matchNamed(line, hostname!)
				: (line) => matchQuick(line),
			note: accessNote(named ? hostname! : undefined, request.port),
		});
		return session.endpoint;
	}

	async teardown(serverId: string): Promise<void> {
		await stopAgent(serverId);
	}

	async status(serverId: string): Promise<NetStatus | undefined> {
		return agentStatus(serverId, this.id, this.displayName);
	}
}

/** A quick tunnel announces itself as a `trycloudflare.com` URL. */
function matchQuick(line: string): AnnouncedAddress | undefined {
	const hit = QUICK_TUNNEL_RE.exec(line);
	if (!hit) return undefined;
	return { host: hit[1]!, port: EDGE_PORT, joinAddress: hit[1]! };
}

/**
 * A named tunnel prints no address — its hostname comes from the user's own
 * ingress configuration — so what is waited for is the first registered edge
 * connection, which is the moment it starts carrying traffic.
 */
function matchNamed(
	line: string,
	hostname: string,
): AnnouncedAddress | undefined {
	if (!CONNECTION_REGISTERED_RE.test(line)) return undefined;
	return { host: hostname, port: EDGE_PORT, joinAddress: hostname };
}

/** The client-side command players need. See the module doc for why. */
function accessNote(hostname: string | undefined, port: number): string {
	const target = hostname ?? "<the hostname above>";
	return (
		`Cloudflare tunnels carry TCP through the HTTPS edge, so players cannot join this hostname directly. ` +
		`Each player runs: cloudflared access tcp --hostname ${target} --url localhost:${port}  ` +
		`— then joins localhost:${port}.`
	);
}
