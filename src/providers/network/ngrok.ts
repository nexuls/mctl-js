/**
 * NgrokNetwork — expose a server through an ngrok TCP tunnel.
 *
 * A concrete provider: `lib/`, `types/` and the shared agent machinery in
 * `./agent.ts` only; it imports no other provider and nothing from `app/`,
 * `cli/`, or `hooks/`.
 *
 * **This is the one tunnel here that a vanilla Minecraft client can join
 * directly**, because ngrok's TCP tunnels are real TCP end to end: the agent
 * announces `tcp://N.tcp.ngrok.io:PORT` and that, minus the scheme, is exactly
 * what a player types. No client-side helper, unlike cloudflared.
 *
 * **Credentials.** ngrok requires an authtoken. MCTL passes it in the child's
 * **environment** (`NGROK_AUTHTOKEN`) rather than on the command line, because a
 * command line is world-readable in `/proc` on Linux — the token would otherwise
 * be visible to every user on the machine. It is read from `secrets.json`
 * (`NGROK_TOKEN`, overridable by `MCTL_NGROK_TOKEN`) and appears in no log, no
 * descriptor and no event payload. When no token is configured, MCTL says so and
 * lets the agent fall back to whatever `ngrok config add-authtoken` already
 * stored — that is a legitimate setup and refusing it would be MCTL insisting on
 * owning a credential the user already gave to ngrok.
 *
 * https://ngrok.com/docs/agent/cli/#ngrok-tcp
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

/** Options an `ngrok` profile understands. */
interface NgrokOptions {
	/** Edge region: `us`, `eu`, `ap`, `au`, `sa`, `jp`, `in`. Default: ngrok's own choice. */
	region?: string;
	/** A reserved TCP address (`1.tcp.eu.ngrok.io:12345`) from a paid plan. */
	remoteAddr?: string;
	/** Seconds to wait for the tunnel to come up. Default 30. */
	timeoutSeconds?: number;
}

/** Secret key holding the authtoken; `MCTL_NGROK_TOKEN` overrides it at load time. */
const TOKEN_KEY = "NGROK_TOKEN";

/**
 * The announcement, from ngrok's logfmt output:
 * `t=… lvl=info msg="started tunnel" … url=tcp://6.tcp.eu.ngrok.io:19132`.
 *
 * `--log stdout --log-format logfmt` is passed explicitly so this shape is
 * guaranteed: with no `--log`, ngrok draws its full-screen terminal UI instead
 * and prints nothing parseable at all.
 */
const TUNNEL_URL_RE = /url=tcp:\/\/([^\s:]+):(\d+)/;

export class NgrokNetwork implements NetworkProvider {
	readonly id = "ngrok";
	readonly displayName = "ngrok";

	requires(): RequiredBinary[] {
		return [
			{
				name: "ngrok",
				installHint:
					"brew install ngrok / snap install ngrok / download from ngrok.com/download",
				url: "https://ngrok.com/download",
			},
		];
	}

	async preflight(
		secrets: Readonly<Record<string, string>> = {},
	): Promise<Readiness> {
		const binary = await which("ngrok");
		if (!binary) {
			const [required] = this.requires();
			return {
				kind: "missing",
				binary: required!.name,
				hint: required!.installHint,
				url: required!.url,
			};
		}
		// Not an error: `ngrok config add-authtoken` stores one in ngrok's own
		// config, which MCTL neither reads nor should. This says which of the two
		// sources will be used, so a failure later is explicable.
		return {
			kind: "ready",
			detail: secrets[TOKEN_KEY]
				? "authtoken from secrets.json"
				: "using ngrok's own stored authtoken",
		};
	}

	async expose(request: ExposeRequest): Promise<Endpoint> {
		const options = (request.options ?? {}) as NgrokOptions;
		const binary = await which("ngrok");
		if (!binary) throw new Error("ngrok is not installed");

		const args = [
			"tcp",
			String(request.port),
			"--log",
			"stdout",
			"--log-format",
			"logfmt",
		];
		if (options.region) args.push("--region", options.region);
		if (options.remoteAddr) args.push("--remote-addr", options.remoteAddr);

		const token = request.secrets[TOKEN_KEY];
		const session = await startAgent({
			serverId: request.serverId,
			provider: this.id,
			profile: request.profile,
			localPort: request.port,
			command: binary,
			args,
			// Environment, never argv — see the module doc.
			env: token ? { NGROK_AUTHTOKEN: token } : undefined,
			cwd: request.serverPath,
			timeoutMs: (options.timeoutSeconds ?? 30) * 1000,
			match: matchTunnelUrl,
			note: "Players join this address directly — no client-side helper needed.",
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

/** Pull `host:port` out of ngrok's `url=tcp://…` log field. */
export function matchTunnelUrl(line: string): AnnouncedAddress | undefined {
	const hit = TUNNEL_URL_RE.exec(line);
	if (!hit) return undefined;
	const port = Number.parseInt(hit[2]!, 10);
	if (!Number.isInteger(port) || port <= 0) return undefined;
	return { host: hit[1]!, port };
}
