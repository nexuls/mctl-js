/**
 * Zod schemas and inferred types for the networking domain: how a player reaches
 * a server, and what MCTL records about the tunnel it started to make that
 * possible.
 *
 * No I/O here — this module only *describes and validates* shapes. Discovery,
 * supervision and DNS live in `core/network/` and `providers/network/`.
 * Validation is applied at the disk boundary like everything else: a
 * `network/<id>.json` descriptor is off-disk data and is trusted only after
 * parsing here.
 *
 * **The one invariant worth stating up front:** none of this is authoritative
 * state. A tunnel descriptor plays exactly the role `runtime/<id>.json` plays
 * for a server process — it is a *re-identification* record (which provider,
 * which pid, what address it announced), re-probed on every read and reaped when
 * its process is gone. No instance holds "the set of live tunnels".
 */

import { z } from "zod";

/**
 * An external binary a network provider needs, with the platform-appropriate way
 * to get it.
 *
 * MCTL **never downloads these** (plan.md § Networking): they are user-installed
 * tools with their own auth flows and update channels, and silently fetching a
 * VPN client or a tunnel agent on a user's behalf is not MCTL's call. A missing
 * binary is reported with this hint and the server still starts on direct
 * networking.
 */
export interface RequiredBinary {
	/** Executable name looked up on `$PATH`, e.g. `"cloudflared"`. */
	name: string;
	/** One-line, copy-pasteable install hint shown in the UI. */
	installHint: string;
	/** Upstream documentation, for the user who wants the real instructions. */
	url?: string;
}

/**
 * One setting a network provider reads out of its profile's `options`, declared
 * so a **form can render it** instead of asking the user to type
 * `timeoutSeconds=45` into a free-text box.
 *
 * The field lives on the provider (like `ServerProvider.content`) for the reason
 * that rule exists: only the provider knows what it reads, a UI may not import a
 * provider, and a list kept beside the form is a list that goes a phase stale.
 * `NetworkProfile.options` stays a loose `Record<string, unknown>` at the config
 * boundary — this describes it for humans, it does not narrow the schema, so an
 * option a newer MCTL writes still loads.
 */
export interface NetworkOption {
	/** Key inside `profile.options`, e.g. `"tunnelId"`. */
	key: string;
	/** Field label, e.g. `"Tunnel id"`. */
	label: string;
	/** Which control renders it, and what type the value is stored as. */
	kind: NetworkOptionKind;
	/** Short help for the field's bottom border. Keep it under ~40 cells. */
	hint?: string;
	/** Placeholder for a `text` field. */
	placeholder?: string;
	/** The options of a `choice` field. */
	choices?: NetworkOptionChoice[];
	/**
	 * What the provider does when the option is absent. A value equal to this is
	 * stored as *nothing*, which is what keeps `config.json` down to the settings
	 * that were actually chosen.
	 */
	fallback?: string | number | boolean;
	/**
	 * Show this field only while another option holds a given value — how
	 * cloudflared's tunnel fields stay hidden for a quick tunnel, which does not
	 * have them.
	 */
	showWhen?: { key: string; equals: string | number | boolean };
	/** Give the field a row to itself in a two-column form. */
	wide?: boolean;
}

/** How a {@link NetworkOption} is rendered and stored. */
export type NetworkOptionKind = "text" | "number" | "boolean" | "choice";

/** One option of a `choice` {@link NetworkOption}. */
export interface NetworkOptionChoice {
	/** Stored value. */
	value: string;
	/** Visible label. */
	label: string;
	/** Optional one-line explanation, shown beside the label. */
	description?: string;
}

/** Thrown when an agent started but never announced an address. */
export class TunnelStartError extends Error {
	constructor(
		readonly provider: string,
		readonly serverId: string,
		message: string,
		/** The tail of the agent's own output, which is the only real diagnosis. */
		readonly output?: string,
	) {
		super(message);
		this.name = "TunnelStartError";
	}
}

/**
 * Whether a provider can actually be used right now.
 *
 * A tagged union rather than a boolean because the three failure modes need
 * different words in the UI: a missing binary is an install command, an
 * unauthenticated agent is a login command, and everything else is a message.
 */
export type Readiness =
	| { kind: "ready"; detail?: string }
	| { kind: "missing"; binary: string; hint: string; url?: string }
	| { kind: "unauthenticated"; detail: string; hint: string }
	| { kind: "error"; detail: string };

/** Whether {@link Readiness} means "go". */
export function isReady(readiness: Readiness): boolean {
	return readiness.kind === "ready";
}

/** One-line human summary of a {@link Readiness}, for a table cell or a toast. */
export function readinessLabel(readiness: Readiness): string {
	switch (readiness.kind) {
		case "ready":
			return readiness.detail ? `ready — ${readiness.detail}` : "ready";
		case "missing":
			return `${readiness.binary} is not installed`;
		case "unauthenticated":
			return readiness.detail;
		case "error":
			return readiness.detail;
	}
}

/**
 * Where players connect. `joinAddress` is the string a player types into their
 * multiplayer screen — which is *not* always `host:port`: a Cloudflare `SRV`
 * record makes the bare domain the join address, and the Minecraft client
 * resolves the port itself.
 */
export const Endpoint = z.object({
	/** Hostname or IP the endpoint resolves to. */
	host: z.string().min(1),
	/** TCP port players connect to (the tunnel's port, not necessarily the server's). */
	port: z.number().int().positive(),
	/** What the user should copy — may omit the port when an SRV record carries it. */
	joinAddress: z.string().min(1),
	/** `"direct"` for an address on this machine's own networks, `"tunnel"` otherwise. */
	kind: z.enum(["direct", "tunnel"]),
	/** Id of the provider that produced it. */
	provider: z.string().min(1),
	/**
	 * Anything the user must know to actually connect — most importantly that a
	 * Cloudflare TCP tunnel needs `cloudflared access tcp` on the *player's*
	 * machine, which is otherwise a mystery that reads as a broken tunnel.
	 */
	note: z.string().optional(),
	/** Secondary addresses (LAN vs public) worth showing beside the main one. */
	alternates: z
		.array(z.object({ label: z.string(), address: z.string() }))
		.optional(),
});
export type Endpoint = z.infer<typeof Endpoint>;

/**
 * `~/.local/state/mctl/network/<id>.json` — the tunnel session descriptor.
 *
 * The exact analogue of `runtime/<id>.json`: it exists so *any* instance can
 * re-identify a tunnel this or another instance started, tear it down, and show
 * its address. It carries liveness and identity only, never credentials — a
 * token that reached this file would be a token on disk in a world-readable
 * place.
 */
export const TunnelSession = z.object({
	/** Network provider id that owns the tunnel. */
	provider: z.string().min(1),
	/** Config profile name it was started from. */
	profile: z.string().min(1),
	/**
	 * Pid of the supervised agent, when there is one. `tailscale` and `direct`
	 * announce an address without owning a process, so this is optional and its
	 * absence means "nothing to reap".
	 */
	pid: z.number().int().positive().optional(),
	/** Local port the tunnel forwards to. */
	localPort: z.number().int().positive(),
	/** The endpoint announced to players. */
	endpoint: Endpoint,
	/** DNS records MCTL created for this server, so teardown removes exactly those. */
	dnsRecords: z.array(z.string()).optional(),
	/** ISO-8601 time the tunnel came up. */
	startedAt: z.string(),
});
export type TunnelSession = z.infer<typeof TunnelSession>;

/**
 * Live state of one server's networking, rebuilt from disk plus a liveness probe
 * on every read.
 *
 *  - `up`       — the endpoint is announced and its agent (if any) is alive.
 *  - `down`     — the profile wants a tunnel and there isn't one.
 *  - `degraded` — the server is reachable, but not the way the profile asked
 *                 (the classic case: the tunnel binary is missing, so MCTL fell
 *                 back to direct rather than refusing to start the server).
 *  - `inactive` — nothing to report; the server is not running.
 */
export const NetState = z.enum(["up", "down", "degraded", "inactive"]);
export type NetState = z.infer<typeof NetState>;

/** What a front-end renders for a server's networking. */
export interface NetStatus {
	/** Profile name from `mctl.json`. */
	profile: string;
	/** Provider id the profile selects. */
	provider: string;
	/** Provider display name, so the UI need not resolve the registry itself. */
	providerName: string;
	state: NetState;
	/** Whether the provider could be used right now. */
	readiness: Readiness;
	/** The announced endpoint, when there is one. */
	endpoint?: Endpoint;
	/** ISO-8601 time the tunnel came up. */
	since?: string;
	/** Why the state is what it is — always set for `degraded` and `down`. */
	detail?: string;
	/**
	 * What the profile's Cloudflare DNS automation is doing, when it configures
	 * any.
	 *
	 * Reported alongside the tunnel rather than folded into `detail` because they
	 * fail independently and for different reasons: a tunnel can be perfectly up
	 * while its records were never published (no API token), which is exactly the
	 * state that reads as "DNS doesn't work" with nothing on screen to say so.
	 */
	dns?: DnsStatus;
}

/** The standing state of a profile's DNS automation, re-derived on every read. */
export interface DnsStatus {
	/** Hostname the profile publishes. */
	hostname: string;
	/**
	 * `ready` — configured and able to publish; `no-token` — configured but there
	 * is no API token to publish with; `self` — the address *is* this hostname, so
	 * there is nothing for MCTL to publish (a pre-defined Cloudflare tunnel, whose
	 * record `cloudflared tunnel route dns` already owns).
	 */
	state: "ready" | "no-token" | "self";
	/** One line for the UI, always set when `state` is not `ready`. */
	detail?: string;
}

/** Everything a provider needs to expose one server. */
export interface ExposeRequest {
	/** Server id — the key for its descriptor and DNS record tagging. */
	serverId: string;
	/** Absolute path to the server directory (some agents want a working dir). */
	serverPath: string;
	/** Local TCP port the Minecraft server is listening on. */
	port: number;
	/** Profile name, recorded in the descriptor. */
	profile: string;
	/** Provider-specific options from the profile in `config.json`. */
	options: Record<string, unknown>;
	/**
	 * Resolved secrets for this provider, already overlaid with `MCTL_*` env
	 * vars. **Never log, never place in an event payload** (AGENTS.md § Secrets).
	 */
	secrets: Readonly<Record<string, string>>;
}
