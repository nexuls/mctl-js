/**
 * Tests for `NetworkManager` — the degradation rules, above all.
 *
 * The governing promise of this subsystem is that **networking never stops a
 * server from starting**: a missing binary, an unregistered provider, a profile
 * that no longer exists, an agent that refuses to come up — every one of them
 * must land on `direct` with a stated reason rather than throwing. Most of what
 * follows is one of those five paths.
 *
 * Providers are stubs implementing the real interface, which is the point: this
 * exercises the manager's own decisions, and the concrete providers are covered
 * by their own tests (`providers/network/agent.test.ts`) and by running them.
 *
 * `lib/paths` reads the XDG environment on every call, so each test points
 * `XDG_STATE_HOME` / `XDG_CONFIG_HOME` at fresh temp directories — `publish`
 * appends to `events.jsonl` and `loadSecrets` reads `secrets.json`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Config } from "../../types/config.ts";
import { secretsFile } from "../../lib/paths.ts";
import {
	TunnelStartError,
	type Endpoint,
	type ExposeRequest,
	type NetStatus,
	type Readiness,
	type RequiredBinary,
} from "../../types/network.ts";
import type { NetworkProvider } from "../../types/provider.ts";
import type { Server } from "../../types/server.ts";
import { EventBus } from "../events/bus.ts";
import { ProviderRegistry } from "../registry/provider-registry.ts";
import { NetworkManager, scopedSecrets } from "./index.ts";

let stateHome: string;
let configHome: string;
let originalState: string | undefined;
let originalConfig: string | undefined;

/** A stub provider whose every behaviour is set by the test that builds it. */
class StubNetwork implements NetworkProvider {
	exposeCalls: ExposeRequest[] = [];
	teardownCalls: string[] = [];
	// The manager never reads a provider's option schema — it is the form's — so
	// the stub declares none. Required rather than optional on the interface so a
	// real provider cannot forget it.
	readonly options = [];

	constructor(
		readonly id: string,
		readonly displayName: string,
		private readonly behaviour: {
			readiness?: Readiness;
			endpoint?: Endpoint;
			throwOnExpose?: string;
			/** Thrown instead, to exercise the agent-output enrichment. */
			throwTunnelError?: { message: string; output: string };
			status?: NetStatus;
		} = {},
	) {}

	requires(): RequiredBinary[] {
		return [];
	}

	async preflight(): Promise<Readiness> {
		return this.behaviour.readiness ?? { kind: "ready" };
	}

	async expose(request: ExposeRequest): Promise<Endpoint> {
		this.exposeCalls.push(request);
		if (this.behaviour.throwTunnelError) {
			throw new TunnelStartError(
				this.id,
				request.serverId,
				this.behaviour.throwTunnelError.message,
				this.behaviour.throwTunnelError.output,
			);
		}
		if (this.behaviour.throwOnExpose) {
			throw new Error(this.behaviour.throwOnExpose);
		}
		return (
			this.behaviour.endpoint ?? {
				host: `${this.id}.example`,
				port: request.port,
				joinAddress: `${this.id}.example:${request.port}`,
				kind: "tunnel",
				provider: this.id,
			}
		);
	}

	async teardown(serverId: string): Promise<void> {
		this.teardownCalls.push(serverId);
	}

	async status(): Promise<NetStatus | undefined> {
		return this.behaviour.status;
	}
}

/** A `direct` stand-in — the floor every failure lands on. */
function direct(status?: NetStatus): StubNetwork {
	return new StubNetwork("direct", "Direct", {
		endpoint: {
			host: "192.168.1.4",
			port: 25565,
			joinAddress: "192.168.1.4:25565",
			kind: "direct",
			provider: "direct",
		},
		status,
	});
}

/** A server view model with only the fields the manager reads. */
function server(overrides: Partial<Server> = {}): Server {
	return {
		id: "survival",
		name: "Survival",
		kind: "paper",
		minecraftVersion: "1.21.4",
		memory: "2G",
		runtime: "foreground",
		network: "direct",
		path: "/tmp/survival",
		state: "running",
		available: true,
		...overrides,
	};
}

/** A parsed config with the given profiles. */
function config(profiles: Record<string, unknown>) {
	return Config.parse({
		root: "/tmp/mctl-root",
		network: { defaultProfile: "direct", profiles },
	});
}

function manager(
	profiles: Record<string, unknown>,
	providers: NetworkProvider[],
): NetworkManager {
	const registry = new ProviderRegistry();
	for (const provider of providers) registry.registerNetwork(provider);
	return new NetworkManager({
		config: config(profiles),
		providers: registry,
		bus: new EventBus(),
	});
}

beforeEach(async () => {
	originalState = process.env.XDG_STATE_HOME;
	originalConfig = process.env.XDG_CONFIG_HOME;
	stateHome = await mkdtemp(join(tmpdir(), "mctl-net-state-"));
	configHome = await mkdtemp(join(tmpdir(), "mctl-net-config-"));
	process.env.XDG_STATE_HOME = stateHome;
	process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(async () => {
	if (originalState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = originalState;
	if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalConfig;
	await rm(stateHome, { recursive: true, force: true });
	await rm(configHome, { recursive: true, force: true });
});

describe("profiles", () => {
	test("resolves each profile's provider for display", () => {
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "ngrok" } },
			[direct(), new StubNetwork("ngrok", "ngrok")],
		);
		expect(net.profiles()).toEqual([
			{
				name: "direct",
				provider: "direct",
				providerName: "Direct",
				known: true,
				dnsHostname: undefined,
			},
			{
				name: "tun",
				provider: "ngrok",
				providerName: "ngrok",
				known: true,
				dnsHostname: undefined,
			},
		]);
	});

	test("marks a profile whose provider this build lacks", () => {
		const net = manager({ future: { provider: "wireguard" } }, [direct()]);
		expect(net.profiles()[0]).toMatchObject({
			provider: "wireguard",
			known: false,
		});
	});
});

describe("expose", () => {
	test("uses the profile's provider when it is ready", async () => {
		const tunnel = new StubNetwork("ngrok", "ngrok");
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "ngrok" } },
			[direct(), tunnel],
		);

		const result = await net.expose(server({ network: "tun" }), 25565);
		expect(result.provider).toBe("ngrok");
		expect(result.degradedReason).toBeUndefined();
		expect(result.endpoint.joinAddress).toBe("ngrok.example:25565");
	});

	test("degrades to direct when the provider's binary is missing", async () => {
		const tunnel = new StubNetwork("ngrok", "ngrok", {
			readiness: {
				kind: "missing",
				binary: "ngrok",
				hint: "brew install ngrok",
			},
		});
		const floor = direct();
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "ngrok" } },
			[floor, tunnel],
		);

		const result = await net.expose(server({ network: "tun" }), 25565);
		expect(result.provider).toBe("direct");
		expect(result.degradedReason).toContain("ngrok is not installed");
		expect(result.degradedReason).toContain("brew install ngrok");
		// The unusable provider is never asked to expose anything.
		expect(tunnel.exposeCalls).toHaveLength(0);
		expect(floor.exposeCalls).toHaveLength(1);
	});

	test("degrades when this build has no such provider", async () => {
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "wireguard" } },
			[direct()],
		);
		const result = await net.expose(server({ network: "tun" }), 25565);
		expect(result.provider).toBe("direct");
		expect(result.degradedReason).toContain('no "wireguard" network provider');
	});

	test("degrades when a ready provider's agent fails to come up", async () => {
		const tunnel = new StubNetwork("ngrok", "ngrok", {
			throwOnExpose: "authentication failed",
		});
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "ngrok" } },
			[direct(), tunnel],
		);

		const result = await net.expose(server({ network: "tun" }), 25565);
		expect(result.provider).toBe("direct");
		expect(result.degradedReason).toContain("authentication failed");
		expect(result.endpoint.kind).toBe("direct");
	});

	test("a server naming a deleted profile falls back rather than failing", async () => {
		const net = manager({ direct: { provider: "direct" } }, [direct()]);
		const result = await net.expose(server({ network: "gone" }), 25565);
		expect(result.profile).toBe("direct");
		expect(result.provider).toBe("direct");
	});

	test("a provider is handed only its own secrets", async () => {
		await Bun.write(
			join(configHome, "mctl", "secrets.json"),
			JSON.stringify({
				NGROK_TOKEN: "ngrok-secret",
				S3_SECRET_KEY: "not-yours",
				CLOUDFLARE_TOKEN: "also-not-yours",
			}),
		);
		const tunnel = new StubNetwork("ngrok", "ngrok");
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "ngrok" } },
			[direct(), tunnel],
		);

		await net.expose(server({ network: "tun" }), 25565);
		expect(tunnel.exposeCalls[0]?.secrets).toEqual({
			NGROK_TOKEN: "ngrok-secret",
		});
	});

	test("the profile's options reach the provider", async () => {
		const tunnel = new StubNetwork("ngrok", "ngrok");
		const net = manager(
			{
				direct: { provider: "direct" },
				tun: { provider: "ngrok", options: { region: "eu" } },
			},
			[direct(), tunnel],
		);
		await net.expose(server({ network: "tun" }), 25565);
		expect(tunnel.exposeCalls[0]?.options).toEqual({ region: "eu" });
	});
});

describe("status", () => {
	test("inactive for a stopped server with nothing recorded", async () => {
		const net = manager({ direct: { provider: "direct" } }, [direct()]);
		const result = await net.status(server({ state: "stopped" }));
		expect(result.state).toBe("inactive");
		expect(result.endpoint).toBeUndefined();
	});

	test("down for a running server with no endpoint", async () => {
		const net = manager({ direct: { provider: "direct" } }, [direct()]);
		const result = await net.status(server());
		expect(result.state).toBe("down");
		expect(result.detail).toContain("no endpoint");
	});

	test("up when the profile's own provider reports an endpoint", async () => {
		const recorded: NetStatus = {
			profile: "direct",
			provider: "direct",
			providerName: "Direct",
			state: "up",
			readiness: { kind: "ready" },
			endpoint: {
				host: "192.168.1.4",
				port: 25565,
				joinAddress: "192.168.1.4:25565",
				kind: "direct",
				provider: "direct",
			},
		};
		const net = manager({ direct: { provider: "direct" } }, [direct(recorded)]);
		expect((await net.status(server())).state).toBe("up");
	});

	test("degraded when a different provider owns the live endpoint", async () => {
		// The user edited the profile while the server was running: the tunnel that
		// is actually up is not the one the profile now asks for. Reporting "up"
		// would hide that; reporting "down" would deny a working address.
		const live: NetStatus = {
			profile: "old",
			provider: "ngrok",
			providerName: "ngrok",
			state: "up",
			readiness: { kind: "ready" },
			endpoint: {
				host: "4.tcp.ngrok.io",
				port: 19132,
				joinAddress: "4.tcp.ngrok.io:19132",
				kind: "tunnel",
				provider: "ngrok",
			},
		};
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "cloudflared" } },
			[
				direct(),
				new StubNetwork("cloudflared", "Cloudflare Tunnel"),
				new StubNetwork("ngrok", "ngrok", { status: live }),
			],
		);

		const result = await net.status(server({ network: "tun" }));
		expect(result.state).toBe("degraded");
		expect(result.endpoint?.joinAddress).toBe("4.tcp.ngrok.io:19132");
		expect(result.detail).toContain("cloudflared");
	});
});

describe("teardown", () => {
	test("stops the provider that actually owns the endpoint", async () => {
		const live: NetStatus = {
			profile: "tun",
			provider: "ngrok",
			providerName: "ngrok",
			state: "up",
			readiness: { kind: "ready" },
		};
		const floor = direct();
		const tunnel = new StubNetwork("ngrok", "ngrok", { status: live });
		const net = manager(
			{ direct: { provider: "direct" }, tun: { provider: "ngrok" } },
			[floor, tunnel],
		);

		await net.teardown(server({ network: "direct" }));
		// Driven by the descriptor, not by the current profile — otherwise editing
		// a profile mid-run orphans the agent that is really there.
		expect(tunnel.teardownCalls).toEqual(["survival"]);
		expect(floor.teardownCalls).toEqual([]);
	});

	test("sweeps every provider when nothing is recorded", async () => {
		const floor = direct();
		const tunnel = new StubNetwork("ngrok", "ngrok");
		const net = manager({ direct: { provider: "direct" } }, [floor, tunnel]);
		await net.teardown(server());
		expect(floor.teardownCalls).toEqual(["survival"]);
		expect(tunnel.teardownCalls).toEqual(["survival"]);
	});
});

describe("scopedSecrets", () => {
	test("passes only the calling provider's keys", () => {
		const all = {
			NGROK_TOKEN: "a",
			NGROK_API_KEY: "b",
			PLAYIT_SECRET: "c",
			CLOUDFLARE_TOKEN: "d",
		};
		expect(scopedSecrets("ngrok", all)).toEqual({
			NGROK_TOKEN: "a",
			NGROK_API_KEY: "b",
		});
		expect(scopedSecrets("playit", all)).toEqual({ PLAYIT_SECRET: "c" });
	});

	test("a provider with no secrets gets an empty object, not everything", () => {
		expect(scopedSecrets("direct", { NGROK_TOKEN: "a" })).toEqual({});
	});
});

/**
 * DNS is reported, not silently skipped.
 *
 * Both of these were live defects: a profile with a DNS block and no API token
 * published nothing and said nothing anywhere (the start path dropped the error
 * on the floor), and a pre-defined Cloudflare tunnel would have had MCTL write a
 * CNAME from its hostname to itself — over the record that actually makes the
 * tunnel reachable.
 */
describe("dns", () => {
	/** Put a Cloudflare token in the temp config home this test's paths resolve to. */
	async function withToken(): Promise<void> {
		// The config dir is a fresh temp for each test and nothing has created it.
		await mkdir(dirname(secretsFile()), { recursive: true });
		await writeFile(
			secretsFile(),
			JSON.stringify({ CLOUDFLARE_TOKEN: "test-token" }),
			{ mode: 0o600 },
		);
	}

	const dnsProfile = (hostname: string) => ({
		direct: { provider: "direct" },
		cf: {
			provider: "cf",
			dns: { zone: "example.com", hostname },
		},
	});

	test("a hostname the tunnel already serves is skipped, not published", async () => {
		// The endpoint's host *is* the hostname: `cloudflared tunnel route dns`
		// owns that record, and writing our own would point the name at itself.
		const tunnel = new StubNetwork("cf", "Cloudflare Tunnel", {
			endpoint: {
				host: "mc.example.com",
				port: 443,
				joinAddress: "mc.example.com",
				kind: "tunnel",
				provider: "cf",
			},
		});
		const net = manager(dnsProfile("mc.example.com"), [direct(), tunnel]);
		const result = await net.expose(server({ network: "cf" }), 25565);

		expect(result.dnsSkipped).toMatch(/already serves that hostname/);
		expect(result.dnsError).toBeUndefined();
		expect(result.dnsHostname).toBeUndefined();
		// And the endpoint is untouched — nothing to swap in, no "origin" alternate.
		expect(result.endpoint.joinAddress).toBe("mc.example.com");
	});

	test("a configured hostname with no token reports why nothing was published", async () => {
		const tunnel = new StubNetwork("cf", "Cloudflare Tunnel");
		const net = manager(dnsProfile("mc.example.com"), [direct(), tunnel]);
		const result = await net.expose(server({ network: "cf" }), 25565);
		expect(result.dnsError).toMatch(/CLOUDFLARE_TOKEN/);
	});

	test("status reports the standing DNS state, token or not", async () => {
		const net = manager(dnsProfile("mc.example.com"), [
			direct(),
			new StubNetwork("cf", "Cloudflare Tunnel"),
		]);
		const stopped = server({ network: "cf", state: "stopped" });

		const without = await net.status(stopped);
		expect(without.dns?.state).toBe("no-token");
		expect(without.dns?.hostname).toBe("mc.example.com");
		expect(without.dns?.detail).toMatch(/mctl secret set/);

		await withToken();
		const withIt = await net.status(stopped);
		expect(withIt.dns?.state).toBe("ready");
		expect(withIt.dns?.detail).toBeUndefined();
	});

	test("a profile without DNS reports none", async () => {
		const net = manager({ direct: { provider: "direct" } }, [direct()]);
		expect((await net.status(server())).dns).toBeUndefined();
	});
});

describe("degradation detail", () => {
	test("carries the agent's own last line, not just the timeout", async () => {
		// "cloudflared did not announce an address within 30s" is the symptom;
		// "tunnel credentials file not found" is the cause and the thing a user can
		// act on. Reporting only the first is what makes a tunnel look mysterious.
		const tunnel = new StubNetwork("cf", "Cloudflare Tunnel", {
			throwTunnelError: {
				message: "cf did not announce an address within 30s",
				output:
					"2026-08-17T09:00:00Z INF Starting tunnel\ntunnel credentials file not found",
			},
		});
		const net = manager(
			{ direct: { provider: "direct" }, cf: { provider: "cf" } },
			[direct(), tunnel],
		);
		const result = await net.expose(server({ network: "cf" }), 25565);

		expect(result.provider).toBe("direct");
		expect(result.degradedReason).toContain("did not announce an address");
		expect(result.degradedReason).toContain(
			"tunnel credentials file not found",
		);
	});
});
