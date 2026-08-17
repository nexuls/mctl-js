/**
 * CloudflaredNetwork — expose a server through a Cloudflare Tunnel.
 *
 * A concrete provider: `lib/`, `types/` and the shared agent machinery in
 * `./agent.ts` only; it imports no other provider and nothing from `app/`,
 * `cli/`, or `hooks/`.
 *
 * Two modes, because Cloudflare has two genuinely different products here, and
 * a profile says which with `options.mode` (`quick` | `named`):
 *
 *  - **Quick tunnel** (`mode=quick`, the default): `cloudflared tunnel --url
 *    tcp://…` gets a throwaway `*.trycloudflare.com` hostname with no account at
 *    all. Its hostname is **assigned, never chosen** — Cloudflare generates the
 *    four-word label — so there is nothing to configure and nothing to reserve.
 *  - **Pre-defined tunnel** (`mode=named`): `cloudflared tunnel run <tunnel>`
 *    runs a tunnel the user already created and pointed at a hostname on their
 *    own domain. It is identified by **`options.tunnelId`** (the UUID Cloudflare
 *    assigns, and what the dashboard shows), by `options.tunnel` (its name), or
 *    by a token alone. MCTL does not create or configure it — that is
 *    `cloudflared`'s own setup flow, with its own browser login, and wrapping it
 *    would be MCTL pretending to own an account it does not.
 *
 * **Credentials for a pre-defined tunnel.** `cloudflared tunnel run <id>` needs
 * the tunnel's credentials file, which `cloudflared tunnel login` + `create`
 * leave in `~/.cloudflared/`. A tunnel created in the Zero Trust dashboard has
 * no local file and is run from its **token** instead: put it in `secrets.json`
 * as `CLOUDFLARED_TOKEN` and it reaches the agent as the `TUNNEL_TOKEN`
 * environment variable — never on the command line, which is world-readable in
 * `/proc`. With a token the tunnel identifies itself, so `tunnelId` is optional.
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

/** Which Cloudflare product a profile runs. */
export type CloudflaredMode = "quick" | "named";

/** Options a `cloudflared` profile understands. */
export interface CloudflaredOptions {
	/**
	 * `quick` for a throwaway `trycloudflare.com` hostname, `named` for a tunnel
	 * the user has already defined.
	 *
	 * Optional, and **inferred when absent** — `named` if the profile identifies a
	 * tunnel, `quick` otherwise. That is the shape every profile written before
	 * this option existed has, so they keep working unchanged; setting it
	 * explicitly is what lets a contradiction (`mode=quick` beside a `tunnelId`)
	 * be reported rather than silently resolved.
	 */
	mode?: CloudflaredMode;
	/** UUID of a pre-defined tunnel — what the Zero Trust dashboard shows. */
	tunnelId?: string;
	/** Name of a pre-defined tunnel. An alias for {@link tunnelId}; the id wins. */
	tunnel?: string;
	/** Hostname the tunnel's ingress serves. Required for a `named` tunnel. */
	hostname?: string;
	/** Seconds to wait for the tunnel to come up. Default 30. */
	timeoutSeconds?: number;
}

/** Secret holding a dashboard-managed tunnel's run token. */
const TOKEN_KEY = "CLOUDFLARED_TOKEN";

/**
 * `cloudflared`'s own name for that token. Passed through the environment, which
 * the agent reads, rather than `--token` on argv (AGENTS.md § Secrets).
 * https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-tunnel-permissions/
 */
const TOKEN_ENV = "TUNNEL_TOKEN";

/** The shape Cloudflare assigns a tunnel, so a name typed into `tunnelId` is caught. */
const TUNNEL_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What {@link planCloudflared} resolved a profile into. */
export type CloudflaredPlan =
	| { mode: "quick"; args: string[] }
	| { mode: "named"; args: string[]; hostname: string };

/**
 * Turn a profile's options into the argv to run. Pure and exported, because
 * every rule here is a claim about a user's configuration and none of them can
 * be checked by starting a real tunnel in a test.
 *
 * @param hasToken whether `CLOUDFLARED_TOKEN` is available — a token identifies
 *   the tunnel by itself, so it stands in for `tunnelId`.
 * @throws {Error} with a message written for the user, for a profile that cannot
 *   be run: a contradiction, a missing hostname, or a `tunnelId` that is not a
 *   UUID (a tunnel *name* in that field is the likely slip, and cloudflared
 *   would fail minutes later with its own less specific error).
 */
export function planCloudflared(
	options: CloudflaredOptions,
	port: number,
	hasToken = false,
): CloudflaredPlan {
	const identified =
		options.tunnelId !== undefined || options.tunnel !== undefined;
	const mode: CloudflaredMode =
		options.mode ?? (identified || hasToken ? "named" : "quick");

	if (mode !== "quick" && mode !== "named") {
		throw new Error(
			`unknown cloudflared mode "${options.mode}" — use "quick" (a trycloudflare.com hostname) or "named" (a tunnel you defined)`,
		);
	}

	if (mode === "quick") {
		if (identified) {
			throw new Error(
				'a cloudflared profile with mode="quick" cannot also name a tunnel — a quick tunnel\'s hostname is assigned by Cloudflare. Drop the tunnel/tunnelId option, or set mode="named"',
			);
		}
		return {
			mode,
			args: ["tunnel", "--no-autoupdate", "--url", `tcp://localhost:${port}`],
		};
	}

	if (options.tunnelId !== undefined && !TUNNEL_ID_RE.test(options.tunnelId)) {
		throw new Error(
			`"${options.tunnelId}" is not a tunnel id — Cloudflare ids look like 6ff42ae2-765d-4adf-8112-31c55c1551ef. If that is the tunnel's *name*, set tunnel=${options.tunnelId} instead`,
		);
	}
	if (!identified && !hasToken) {
		throw new Error(
			`a cloudflared profile with mode="named" must set tunnelId (or tunnel), or hold a ${TOKEN_KEY} in secrets.json`,
		);
	}
	if (!options.hostname) {
		throw new Error(
			'a pre-defined cloudflared tunnel must also set "hostname" — MCTL cannot know which hostname your tunnel\'s ingress serves',
		);
	}

	// The id is preferred when both are given: a name is per-account and can be
	// changed in the dashboard, while the id is the tunnel's identity. cloudflared
	// accepts either in the same position.
	const reference = options.tunnelId ?? options.tunnel;
	return {
		mode,
		hostname: options.hostname,
		args: [
			"tunnel",
			"--no-autoupdate",
			"run",
			// A token-only tunnel names itself; `run` with no argument is correct.
			...(reference ? [reference] : []),
		],
	};
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
	 * call against Cloudflare. A token in `secrets.json` is *reported* — it is
	 * what a dashboard-managed tunnel runs on — but not verified for the same
	 * reason.
	 */
	async preflight(
		secrets: Readonly<Record<string, string>> = {},
	): Promise<Readiness> {
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
		return {
			kind: "ready",
			detail: secrets[TOKEN_KEY] ? "tunnel token from secrets.json" : undefined,
		};
	}

	async expose(request: ExposeRequest): Promise<Endpoint> {
		const options = (request.options ?? {}) as CloudflaredOptions;
		const binary = await which("cloudflared");
		if (!binary) throw new Error("cloudflared is not installed");

		const token = request.secrets[TOKEN_KEY];
		const plan = planCloudflared(options, request.port, token !== undefined);

		const session = await startAgent({
			serverId: request.serverId,
			provider: this.id,
			profile: request.profile,
			localPort: request.port,
			command: binary,
			args: plan.args,
			// The token goes in the environment, never in argv — see TOKEN_ENV.
			env: token ? { [TOKEN_ENV]: token } : undefined,
			cwd: request.serverPath,
			timeoutMs: (options.timeoutSeconds ?? 30) * 1000,
			match:
				plan.mode === "named"
					? (line) => matchNamed(line, plan.hostname)
					: (line) => matchQuick(line),
			note: accessNote(
				plan.mode === "named" ? plan.hostname : undefined,
				request.port,
			),
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
