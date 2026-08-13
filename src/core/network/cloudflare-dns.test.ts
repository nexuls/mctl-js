/**
 * Tests for the Cloudflare DNS automation, driven against a **real HTTP server**
 * standing in for the Cloudflare API — the same pattern `core/server/ping.test.ts`
 * uses for the Minecraft list ping, and for the same reason: the interesting
 * behaviour is in the request/response round trip, so a mocked `fetch` would
 * assert only that the code calls the function it obviously calls.
 *
 * The stand-in holds records in a map and records every request, which is what
 * lets these tests pin the one property that really matters: **MCTL only ever
 * deletes records it tagged as its own.** A bug there silently removes a user's
 * DNS, which is the worst thing this module could do.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CloudflareDnsConfig } from "../../types/config.ts";
import type { Endpoint } from "../../types/network.ts";
import {
	CloudflareDnsError,
	ownershipTag,
	removeDnsRecords,
	syncDnsRecords,
} from "./cloudflare-dns.ts";

/** One record as the stand-in API stores it. */
interface Record_ {
	id: string;
	type: string;
	name: string;
	content?: string;
	comment?: string | null;
	ttl?: number;
	proxied?: boolean;
	data?: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let records: Map<string, Record_>;
let requests: { method: string; path: string; auth?: string }[];
let nextId = 0;

/** A zone id shaped the way Cloudflare's are (32 hex), so the id fast-path is exercised. */
const ZONE_ID = "0123456789abcdef0123456789abcdef";

const config: CloudflareDnsConfig = {
	zone: "example.com",
	hostname: "mc.example.com",
	proxied: false,
	srv: true,
	ttl: 60,
};

const endpoint: Endpoint = {
	host: "203.0.113.7",
	port: 25781,
	joinAddress: "203.0.113.7:25781",
	kind: "direct",
	provider: "direct",
};

function ok(result: unknown): Response {
	return Response.json({ success: true, errors: [], result });
}

beforeEach(() => {
	records = new Map();
	requests = [];
	nextId = 0;
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				path: url.pathname + url.search,
				auth: request.headers.get("authorization") ?? undefined,
			});

			if (url.pathname === "/zones") {
				const name = url.searchParams.get("name");
				return ok(name === "example.com" ? [{ id: ZONE_ID, name }] : []);
			}

			const listPath = `/zones/${ZONE_ID}/dns_records`;
			if (url.pathname === listPath && request.method === "GET") {
				return ok([...records.values()]);
			}
			if (url.pathname === listPath && request.method === "POST") {
				return request.json().then((body) => {
					const record = { ...(body as Record_), id: `rec-${nextId++}` };
					records.set(record.id, record);
					return ok(record);
				});
			}
			if (url.pathname.startsWith(`${listPath}/`)) {
				const id = url.pathname.slice(listPath.length + 1);
				if (request.method === "PUT") {
					return request.json().then((body) => {
						const record = { ...(body as Record_), id };
						records.set(id, record);
						return ok(record);
					});
				}
				if (request.method === "DELETE") {
					records.delete(id);
					return ok({ id });
				}
			}
			return Response.json(
				{ success: false, errors: [{ code: 7003, message: "no route" }] },
				{ status: 404 },
			);
		},
	});
	base = `http://localhost:${server.port}`;
});

afterEach(() => {
	server.stop(true);
});

const sync = () =>
	syncDnsRecords(config, {
		serverId: "survival",
		endpoint,
		token: "secret-token",
		apiBase: base,
	});

describe("syncDnsRecords", () => {
	test("writes an A record and an SRV record carrying the port", async () => {
		const result = await sync();
		expect(result.records).toHaveLength(2);

		const written = [...records.values()];
		const a = written.find((r) => r.type === "A")!;
		expect(a.name).toBe("mc.example.com");
		expect(a.content).toBe("203.0.113.7");
		// Never proxied: the orange cloud speaks HTTP(S) and would break Minecraft.
		expect(a.proxied).toBe(false);

		const srv = written.find((r) => r.type === "SRV")!;
		expect(srv.name).toBe("_minecraft._tcp.mc.example.com");
		// The port lives here and nowhere else — this is what lets a player type a
		// bare hostname for a server on a non-default port.
		expect(srv.data).toMatchObject({
			service: "_minecraft",
			proto: "_tcp",
			port: 25781,
			target: "mc.example.com",
		});
	});

	test("tags every record it creates with the server id", async () => {
		await sync();
		for (const record of records.values()) {
			expect(record.comment).toBe(ownershipTag("survival"));
		}
	});

	test("a tunnel hostname becomes a CNAME, not an A record", async () => {
		await syncDnsRecords(config, {
			serverId: "survival",
			endpoint: { ...endpoint, host: "4.tcp.ngrok.io" },
			token: "t",
			apiBase: base,
		});
		expect([...records.values()].map((r) => r.type).sort()).toEqual([
			"CNAME",
			"SRV",
		]);
	});

	test("is idempotent — a second sync updates rather than duplicating", async () => {
		await sync();
		const first = [...records.keys()].sort();
		await sync();
		expect([...records.keys()].sort()).toEqual(first);
		expect(records.size).toBe(2);
	});

	test("a changed address updates the existing record in place", async () => {
		await sync();
		await syncDnsRecords(config, {
			serverId: "survival",
			endpoint: { ...endpoint, host: "203.0.113.9" },
			token: "t",
			apiBase: base,
		});
		expect([...records.values()].find((r) => r.type === "A")?.content).toBe(
			"203.0.113.9",
		);
		expect(records.size).toBe(2);
	});

	test("turning SRV off removes the record it previously created", async () => {
		await sync();
		await syncDnsRecords(
			{ ...config, srv: false },
			{ serverId: "survival", endpoint, token: "t", apiBase: base },
		);
		expect([...records.values()].map((r) => r.type)).toEqual(["A"]);
	});

	test("resolves a zone name to its id", async () => {
		await sync();
		expect(requests[0]?.path).toBe("/zones?name=example.com");
	});

	test("a zone id is used directly, with no lookup", async () => {
		await syncDnsRecords(
			{ ...config, zone: ZONE_ID },
			{ serverId: "survival", endpoint, token: "t", apiBase: base },
		);
		expect(requests.some((r) => r.path.startsWith("/zones?"))).toBe(false);
	});

	test("an invisible zone fails with a message naming the permission", async () => {
		await expect(
			syncDnsRecords(
				{ ...config, zone: "nobody.example" },
				{ serverId: "survival", endpoint, token: "t", apiBase: base },
			),
		).rejects.toThrow(/Zone:Read/);
	});

	test("the token travels in the Authorization header and nowhere else", async () => {
		await sync();
		expect(requests.every((r) => r.auth === "Bearer secret-token")).toBe(true);
		// It must never end up in a URL, where it would be logged by every proxy
		// and every server access log between here and Cloudflare.
		expect(requests.some((r) => r.path.includes("secret-token"))).toBe(false);
	});
});

describe("removeDnsRecords", () => {
	test("removes only the records MCTL tagged for this server", async () => {
		await sync();
		// A record the user made by hand, on the same hostname MCTL manages — the
		// exact case a name-based cleanup would destroy.
		records.set("user-owned", {
			id: "user-owned",
			type: "TXT",
			name: "mc.example.com",
			content: "do not touch",
			comment: null,
		});
		// And one MCTL made for a *different* server.
		records.set("other-server", {
			id: "other-server",
			type: "A",
			name: "creative.example.com",
			comment: ownershipTag("creative"),
		});

		const removed = await removeDnsRecords(config, {
			serverId: "survival",
			token: "t",
			apiBase: base,
		});

		expect(removed).toHaveLength(2);
		expect([...records.keys()].sort()).toEqual(["other-server", "user-owned"]);
	});

	test("is a no-op when MCTL owns nothing on the zone", async () => {
		expect(
			await removeDnsRecords(config, {
				serverId: "survival",
				token: "t",
				apiBase: base,
			}),
		).toEqual([]);
	});

	test("an API failure is a typed error carrying what Cloudflare said", async () => {
		await expect(
			removeDnsRecords(
				{ ...config, zone: "0000000000000000000000000000dead" },
				{ serverId: "survival", token: "t", apiBase: base },
			),
		).rejects.toBeInstanceOf(CloudflareDnsError);
	});
});
