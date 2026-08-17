/**
 * PlayitNetwork — run a playit.gg agent alongside a server.
 *
 * A concrete provider: `lib/`, `types/` and the shared agent machinery in
 * `./agent.ts` only; it imports no other provider and nothing from `app/`,
 * `cli/`, or `hooks/`.
 *
 * **playit is account-shaped, not command-shaped, and that changes what MCTL can
 * honestly do.** Unlike ngrok, the tunnel's address is not chosen by the agent
 * at startup — it is allocated against the user's playit.gg account and
 * configured on their web dashboard (`something.craft.ply.gg`,
 * `something.joinmc.link`, …). The agent's job is to be running so that address
 * routes here. So this provider works two ways:
 *
 *  - `options.address` set (**recommended**): MCTL runs the agent and announces
 *    that address. It is the user's dashboard talking, which is the authority.
 *  - `options.address` absent: MCTL runs the agent and scrapes the first playit
 *    hostname it prints. That works when the agent happens to log its tunnels,
 *    and falls back to reporting the agent as up **without** an address rather
 *    than killing a perfectly healthy agent for not saying something it was
 *    never contracted to say (`fallback` in `AgentSpec` exists for exactly this).
 *
 * **First run needs a browser.** A fresh agent prints a claim URL and waits for
 * the user to approve it on playit.gg. MCTL surfaces that URL in the error
 * rather than pretending the tunnel failed for a technical reason.
 *
 * https://playit.gg/ · https://github.com/playit-cloud/playit-agent
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

/** Options a `playit` profile understands. */
interface PlayitOptions {
	/**
	 * The tunnel address from your playit.gg dashboard, e.g.
	 * `alpha-beta.craft.ply.gg` or `alpha-beta.craft.ply.gg:25781`. Strongly
	 * preferred — it is the only source that is actually authoritative.
	 */
	address?: string;
	/** Extra arguments handed to the agent verbatim. */
	args?: string[];
	/** Seconds to wait for the agent to settle. Default 20. */
	timeoutSeconds?: number;
}

/** Secret key holding the agent secret; `MCTL_PLAYIT_SECRET` overrides it. */
const SECRET_KEY = "PLAYIT_SECRET";

/** Binary names, in preference order — the agent ships under both. */
const BINARIES = ["playit", "playit-cli"];

/** playit's tunnel hostnames, as printed by the agent when it logs them. */
const PLAYIT_HOST_RE =
	/\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:ply\.gg|joinmc\.link))(?::(\d+))?\b/i;

/** Minecraft's default port — what a playit Minecraft tunnel maps to unless told otherwise. */
const DEFAULT_TUNNEL_PORT = 25565;

export class PlayitNetwork implements NetworkProvider {
	readonly id = "playit";
	readonly displayName = "playit.gg";

	/** @see NetworkProvider.options */
	readonly options = [
		{
			key: "address",
			label: "Tunnel address",
			kind: "text" as const,
			hint: "from your playit.gg dashboard",
			placeholder: "alpha-beta.craft.ply.gg",
			wide: true,
		},
		{
			key: "timeoutSeconds",
			label: "Start timeout",
			kind: "number" as const,
			hint: "seconds to wait (default 20)",
			fallback: 20,
		},
	];

	requires(): RequiredBinary[] {
		return [
			{
				name: "playit",
				installHint:
					"download the agent from playit.gg/download (packages: playit / playit-cli)",
				url: "https://playit.gg/download",
			},
		];
	}

	async preflight(
		secrets: Readonly<Record<string, string>> = {},
	): Promise<Readiness> {
		const binary = await this.#binary();
		if (!binary) {
			const [required] = this.requires();
			return {
				kind: "missing",
				binary: required!.name,
				hint: required!.installHint,
				url: required!.url,
			};
		}
		return {
			kind: "ready",
			detail: secrets[SECRET_KEY]
				? "agent secret from secrets.json"
				: "using the agent's own stored secret (first run opens a claim URL)",
		};
	}

	async expose(request: ExposeRequest): Promise<Endpoint> {
		const options = (request.options ?? {}) as PlayitOptions;
		const binary = await this.#binary();
		if (!binary) throw new Error("the playit agent is not installed");

		const configured = options.address
			? parseAddress(options.address)
			: undefined;
		const secret = request.secrets[SECRET_KEY];

		const session = await startAgent({
			serverId: request.serverId,
			provider: this.id,
			profile: request.profile,
			localPort: request.port,
			command: binary,
			args: options.args ?? [],
			// Environment, never argv: a secret on a command line is readable by
			// every user on the machine through /proc.
			env: secret ? { PLAYIT_SECRET: secret } : undefined,
			cwd: request.serverPath,
			timeoutMs: (options.timeoutSeconds ?? 20) * 1000,
			// A configured address is authoritative, so scraping is skipped entirely
			// rather than allowed to contradict it.
			match: configured ? () => undefined : matchPlayitHost,
			fallback: configured,
			note: configured
				? "Players join this address directly. It is served by your playit.gg account, so it stays the same across restarts."
				: "Address read from the agent's output. Set this profile's `address` option to the tunnel shown on your playit.gg dashboard to make it reliable.",
		});
		return session.endpoint;
	}

	async teardown(serverId: string): Promise<void> {
		await stopAgent(serverId);
	}

	async status(serverId: string): Promise<NetStatus | undefined> {
		return agentStatus(serverId, this.id, this.displayName);
	}

	/** First of the agent's two published binary names that is on `$PATH`. */
	async #binary(): Promise<string | undefined> {
		for (const name of BINARIES) {
			const found = await which(name);
			if (found) return found;
		}
		return undefined;
	}
}

/** Split a `host` or `host:port` tunnel address from the dashboard. */
export function parseAddress(value: string): AnnouncedAddress {
	const trimmed = value.trim().replace(/^\w+:\/\//, "");
	const [host, port] = trimmed.split(":");
	const parsed = Number.parseInt(port ?? "", 10);
	const resolved =
		Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TUNNEL_PORT;
	return {
		host: host!,
		port: resolved,
		// A playit Minecraft tunnel on the default port is joined by bare hostname;
		// anything else needs the port typed out.
		joinAddress:
			resolved === DEFAULT_TUNNEL_PORT ? host! : `${host}:${resolved}`,
	};
}

/** Find a playit tunnel hostname in one line of agent output. */
export function matchPlayitHost(line: string): AnnouncedAddress | undefined {
	const hit = PLAYIT_HOST_RE.exec(line);
	if (!hit) return undefined;
	return parseAddress(hit[2] ? `${hit[1]}:${hit[2]}` : hit[1]!);
}
