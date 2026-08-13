/**
 * Cloudflare DNS automation: publish a server's address on a domain the user
 * owns, so players join a bare hostname instead of an IP and a port.
 *
 * Core service — no UI, no argv, no provider imports. It sits in `core/` rather
 * than beside the network providers because it is **orthogonal to them**: the
 * records look the same whether the address came from `direct`, `ngrok` or a
 * Cloudflare tunnel, so making it a provider concern would have each of them
 * re-implement it. (`core/java/adoptium.ts` is the precedent for core owning an
 * upstream API client.)
 *
 * **Two records, and the second is the interesting one.** An `A` (or `CNAME`,
 * when the endpoint is itself a hostname) points the name at the address, and an
 * `SRV` at `_minecraft._tcp.<hostname>` carries the **port**. That SRV record is
 * what lets a player type `mc.example.com` and reach a server on 25781 — the
 * Minecraft client resolves it before falling back to the default port. Without
 * it, a non-default port must be typed out.
 *
 * **The safety property that matters most:** every record MCTL creates carries
 * `mctl:<server id>` in its `comment` field, and **deletion only ever touches
 * records carrying that exact tag**. A user's own `A` record on the same
 * hostname is left alone; a record for a *different* server is left alone. MCTL
 * removes what MCTL made, and nothing else.
 *
 * **Why this bypasses `lib/http.ts`.** That helper is an ETag *cache* for
 * idempotent GETs of public manifests. These calls are authenticated and
 * mutating, and caching an authenticated response into `~/.cache/mctl/` would be
 * both wrong and a small credential-adjacent leak. Plain `fetch` + Zod at the
 * boundary, as everywhere else.
 *
 * https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-list-dns-records
 */

import { z } from "zod";
import { log } from "../../lib/logger.ts";
import type { CloudflareDnsConfig } from "../../types/config.ts";
import type { Endpoint } from "../../types/network.ts";

const logger = log("network:dns");

/** Cloudflare's API root. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** How long any single API call may take. */
const TIMEOUT_MS = 15_000;

/** Secret key holding the API token; `MCTL_CLOUDFLARE_TOKEN` overrides it. */
export const CLOUDFLARE_TOKEN_KEY = "CLOUDFLARE_TOKEN";

/**
 * The record comment MCTL writes and matches on. Deliberately machine-shaped
 * rather than prose: it is a *tag*, and a human-friendly sentence would be
 * something a user might reasonably edit, at which point teardown would stop
 * recognising its own records.
 */
export function ownershipTag(serverId: string): string {
	return `mctl:${serverId}`;
}

/** Thrown for any Cloudflare API failure, carrying what the API actually said. */
export class CloudflareDnsError extends Error {
	constructor(
		/** What was being attempted, e.g. `"create SRV record"`. */
		readonly operation: string,
		message: string,
	) {
		super(`cloudflare: ${operation}: ${message}`);
		this.name = "CloudflareDnsError";
	}
}

/** The envelope every Cloudflare v4 response is wrapped in. */
const ApiEnvelope = z.object({
	success: z.boolean(),
	errors: z
		.array(z.object({ code: z.number().optional(), message: z.string() }))
		.default([]),
	result: z.unknown().optional(),
});

const Zone = z.object({ id: z.string(), name: z.string() });

const DnsRecord = z.object({
	id: z.string(),
	type: z.string(),
	name: z.string(),
	content: z.string().optional(),
	comment: z.string().nullish(),
});
type DnsRecord = z.infer<typeof DnsRecord>;

/** What a sync produced. */
export interface DnsSyncResult {
	/** The hostname players should use. */
	hostname: string;
	/** Ids of the records MCTL now owns for this server. */
	records: string[];
	/** Whether an SRV record carries the port (so the bare hostname is enough). */
	srv: boolean;
}

/**
 * Create or update this server's records so `config.hostname` points at
 * `endpoint`, and remove any MCTL-owned record for this server that the new
 * shape no longer needs.
 *
 * Idempotent: running it twice with the same endpoint changes nothing. That
 * matters because it runs on every start, and a tunnel address usually *has*
 * changed between two starts while a direct address usually has not.
 *
 * @throws {CloudflareDnsError} on any API failure — the caller decides whether
 *   that is fatal (it is not: `NetworkManager` reports it and leaves the server
 *   running on the address it already has).
 */
export async function syncDnsRecords(
	config: CloudflareDnsConfig,
	options: {
		serverId: string;
		endpoint: Endpoint;
		token: string;
		/** API root. Overridden only by tests, which run against a local stand-in. */
		apiBase?: string;
	},
): Promise<DnsSyncResult> {
	const { serverId, endpoint, token } = options;
	const api: Api = { base: options.apiBase ?? CLOUDFLARE_API, token };
	const zoneId = await resolveZone(config.zone, api);
	const tag = ownershipTag(serverId);
	const existing = await listOwnedRecords(zoneId, tag, api);

	// An IP goes in an A record; a tunnel hostname must be a CNAME. Getting this
	// backwards is rejected by the API rather than silently wrong, but the error
	// ("content must be a valid IPv4 address") does not explain itself.
	const addressType = isIpv4(endpoint.host) ? "A" : "CNAME";
	const kept: string[] = [];

	kept.push(
		await upsert(
			zoneId,
			api,
			existing,
			{
				type: addressType,
				name: config.hostname,
				content: endpoint.host,
				ttl: config.ttl,
				// Never proxied for Minecraft — the orange cloud speaks HTTP(S) and
				// would make the server unreachable. CNAME/A only; SRV has no proxy.
				proxied: config.proxied,
				comment: tag,
			},
			`create ${addressType} record`,
		),
	);

	if (config.srv) {
		kept.push(
			await upsert(
				zoneId,
				api,
				existing,
				{
					type: "SRV",
					name: `_minecraft._tcp.${config.hostname}`,
					ttl: config.ttl,
					comment: tag,
					data: {
						service: "_minecraft",
						proto: "_tcp",
						name: config.hostname,
						priority: 0,
						weight: 5,
						port: endpoint.port,
						target: config.hostname,
					},
				},
				"create SRV record",
			),
		);
	}

	// Anything still tagged for this server but no longer part of the set — an SRV
	// record left behind after `srv` was turned off, or an A record after a switch
	// to a tunnel hostname — is ours to remove and would otherwise resolve players
	// to a dead address.
	for (const record of existing) {
		if (!kept.includes(record.id)) {
			await deleteRecord(zoneId, record.id, api);
		}
	}

	logger.info(
		{ id: serverId, hostname: config.hostname, records: kept.length },
		"synced cloudflare dns records",
	);
	return { hostname: config.hostname, records: kept, srv: config.srv };
}

/**
 * Remove every record MCTL created for this server.
 *
 * @returns the ids that were removed.
 * @throws {CloudflareDnsError} on any API failure.
 */
export async function removeDnsRecords(
	config: CloudflareDnsConfig,
	options: {
		serverId: string;
		token: string;
		/** API root. Overridden only by tests, which run against a local stand-in. */
		apiBase?: string;
	},
): Promise<string[]> {
	const api: Api = {
		base: options.apiBase ?? CLOUDFLARE_API,
		token: options.token,
	};
	const zoneId = await resolveZone(config.zone, api);
	const owned = await listOwnedRecords(
		zoneId,
		ownershipTag(options.serverId),
		api,
	);
	for (const record of owned) {
		await deleteRecord(zoneId, record.id, api);
	}
	logger.info(
		{ id: options.serverId, records: owned.length },
		"removed cloudflare dns records",
	);
	return owned.map((record) => record.id);
}

/**
 * Resolve a zone **name** to its id, passing an id straight through.
 *
 * Accepting both is deliberate: a zone id is what the API wants and what a
 * script has, but nobody knows their zone id by heart — they know their domain.
 * The discriminator is shape, since a Cloudflare zone id is a 32-character hex
 * string and a domain name always contains a dot.
 */
async function resolveZone(zone: string, api: Api): Promise<string> {
	if (/^[0-9a-f]{32}$/i.test(zone)) return zone;
	const result = await call(
		`${api.base}/zones?name=${encodeURIComponent(zone)}`,
		{ method: "GET" },
		api,
		"look up zone",
	);
	const zones = z.array(Zone).parse(result);
	const found = zones.find((candidate) => candidate.name === zone);
	if (!found) {
		throw new CloudflareDnsError(
			"look up zone",
			`no zone named "${zone}" is visible to this API token — check the token's Zone:Read permission covers it`,
		);
	}
	return found.id;
}

/** Every record on the zone carrying this server's ownership tag. */
async function listOwnedRecords(
	zoneId: string,
	tag: string,
	api: Api,
): Promise<DnsRecord[]> {
	const result = await call(
		`${api.base}/zones/${zoneId}/dns_records?per_page=1000`,
		{ method: "GET" },
		api,
		"list records",
	);
	// Filtered here rather than through the API's `comment` filter: that filter is
	// not available on every plan, and reading the zone and matching locally is
	// both universally supported and easier to be certain about — this is the
	// check that keeps MCTL from deleting a user's own records.
	return z
		.array(DnsRecord)
		.parse(result)
		.filter((record) => record.comment === tag);
}

/** Where the API lives and how to authenticate to it, threaded through every call. */
interface Api {
	base: string;
	token: string;
}

/** Fields shared by the create and update calls. */
interface RecordBody {
	type: string;
	name: string;
	content?: string;
	ttl: number;
	proxied?: boolean;
	comment: string;
	data?: Record<string, unknown>;
}

/**
 * Update the existing record of this type+name if MCTL already owns one, else
 * create it. Returns the record id either way.
 */
async function upsert(
	zoneId: string,
	api: Api,
	existing: DnsRecord[],
	body: RecordBody,
	operation: string,
): Promise<string> {
	const match = existing.find(
		(record) => record.type === body.type && record.name === body.name,
	);
	const result = await call(
		match
			? `${api.base}/zones/${zoneId}/dns_records/${match.id}`
			: `${api.base}/zones/${zoneId}/dns_records`,
		{ method: match ? "PUT" : "POST", body: JSON.stringify(body) },
		api,
		operation,
	);
	return DnsRecord.parse(result).id;
}

/** Delete one record, tolerating a record that is already gone. */
async function deleteRecord(
	zoneId: string,
	recordId: string,
	api: Api,
): Promise<void> {
	try {
		await call(
			`${api.base}/zones/${zoneId}/dns_records/${recordId}`,
			{ method: "DELETE" },
			api,
			"delete record",
		);
	} catch (err) {
		// Someone deleting it in the dashboard first is the outcome we wanted, not
		// a failure that should abort the rest of a teardown.
		if (
			err instanceof CloudflareDnsError &&
			/81044|not found/i.test(err.message)
		) {
			return;
		}
		throw err;
	}
}

/**
 * One authenticated API call, returning the envelope's `result`.
 *
 * The token goes in the `Authorization` header and **nowhere else** — not into
 * the thrown message, not into the log line, not into an event payload
 * (AGENTS.md § Secrets). Cloudflare's own error text is surfaced verbatim
 * because it is unusually good (it names the missing permission).
 */
async function call(
	url: string,
	init: { method: string; body?: string },
	api: Api,
	operation: string,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${api.token}`,
				"Content-Type": "application/json",
			},
			body: init.body,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new CloudflareDnsError(operation, `request failed: ${String(err)}`);
	}

	let envelope: z.infer<typeof ApiEnvelope>;
	try {
		envelope = ApiEnvelope.parse(await response.json());
	} catch {
		throw new CloudflareDnsError(
			operation,
			`HTTP ${response.status} with an unreadable body`,
		);
	}
	if (!envelope.success) {
		const detail =
			envelope.errors
				.map((e) => `${e.code ?? ""} ${e.message}`.trim())
				.join("; ") || `HTTP ${response.status}`;
		throw new CloudflareDnsError(operation, detail);
	}
	return envelope.result;
}

/** Whether a host is a literal IPv4 address (⇒ an `A` record, not a `CNAME`). */
export function isIpv4(host: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
