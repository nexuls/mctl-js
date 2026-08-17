/**
 * Tests for the pure, provider-specific half of exposing a tunnel: pulling the
 * announced address out of one line of an agent's output.
 *
 * This is the only part of a tunnel provider that can be tested without the
 * agent, and it is also the part most likely to break silently — an upstream
 * release that changes a log line turns a working tunnel into a 30-second
 * timeout, and the difference between "matched" and "did not match" is invisible
 * from the outside. The lines below are the real shapes these agents print.
 */

import { describe, expect, test } from "bun:test";
import { createProviderRegistry } from "../index.ts";
import { planCloudflared } from "./cloudflared.ts";
import { matchTunnelUrl } from "./ngrok.ts";
import { matchPlayitHost, parseAddress } from "./playit.ts";

describe("ngrok", () => {
	test("reads host and port from a logfmt started-tunnel line", () => {
		const line =
			't=2026-08-13T09:12:44+0000 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=//localhost:25565 url=tcp://4.tcp.eu.ngrok.io:19132';
		expect(matchTunnelUrl(line)).toEqual({
			host: "4.tcp.eu.ngrok.io",
			port: 19132,
		});
	});

	test("ignores the lines around it", () => {
		expect(
			matchTunnelUrl('lvl=info msg="client session established"'),
		).toBeUndefined();
		// The HTTP form is a different tunnel type and must not be mistaken for the
		// TCP one — its address would not be joinable.
		expect(
			matchTunnelUrl('msg="started tunnel" url=https://abc.ngrok.io'),
		).toBeUndefined();
		expect(matchTunnelUrl("")).toBeUndefined();
	});
});

describe("playit", () => {
	test("a dashboard address with an explicit port keeps it", () => {
		expect(parseAddress("alpha-beta.craft.ply.gg:25781")).toEqual({
			host: "alpha-beta.craft.ply.gg",
			port: 25781,
			joinAddress: "alpha-beta.craft.ply.gg:25781",
		});
	});

	test("a bare hostname joins on the default port and needs no port typed", () => {
		expect(parseAddress("alpha-beta.craft.ply.gg")).toEqual({
			host: "alpha-beta.craft.ply.gg",
			port: 25565,
			joinAddress: "alpha-beta.craft.ply.gg",
		});
	});

	test("a scheme pasted from the dashboard is stripped", () => {
		expect(parseAddress("tcp://alpha.joinmc.link:25565").host).toBe(
			"alpha.joinmc.link",
		);
	});

	test("finds a playit hostname inside a log line", () => {
		expect(
			matchPlayitHost("tunnel ready: alpha-beta.craft.ply.gg:25781 -> 25565"),
		).toMatchObject({ host: "alpha-beta.craft.ply.gg", port: 25781 });
		expect(
			matchPlayitHost("visit https://playit.gg/claim/abc"),
		).toBeUndefined();
	});
});

/**
 * `planCloudflared` is the other pure half of a tunnel provider: which argv a
 * profile's options resolve to, and which profiles are refused. Every rule is a
 * claim about a user's configuration, and none of them can be checked by
 * starting a real tunnel — a wrong one costs a 30-second timeout and an error
 * from cloudflared that does not name the option at fault.
 */
describe("cloudflared", () => {
	test("no options is a quick trycloudflare tunnel over the local port", () => {
		expect(planCloudflared({}, 25565)).toEqual({
			mode: "quick",
			args: ["tunnel", "--no-autoupdate", "--url", "tcp://localhost:25565"],
		});
		// Explicit and inferred must produce the same thing, or writing the mode
		// down would change behaviour.
		expect(planCloudflared({ mode: "quick" }, 25565)).toEqual(
			planCloudflared({}, 25565),
		);
	});

	test("a tunnel id runs that pre-defined tunnel", () => {
		const plan = planCloudflared(
			{
				tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
				hostname: "mc.example.com",
			},
			25565,
		);
		expect(plan).toEqual({
			mode: "named",
			hostname: "mc.example.com",
			args: [
				"tunnel",
				"--no-autoupdate",
				"run",
				"6ff42ae2-765d-4adf-8112-31c55c1551ef",
			],
		});
	});

	test("a name still works, and the id wins when both are given", () => {
		expect(
			planCloudflared({ tunnel: "mc", hostname: "mc.example.com" }, 25565),
		).toMatchObject({ args: ["tunnel", "--no-autoupdate", "run", "mc"] });
		// A name can be changed in the dashboard; the id is the tunnel's identity.
		expect(
			planCloudflared(
				{
					tunnel: "mc",
					tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
					hostname: "mc.example.com",
				},
				25565,
			),
		).toMatchObject({
			args: [
				"tunnel",
				"--no-autoupdate",
				"run",
				"6ff42ae2-765d-4adf-8112-31c55c1551ef",
			],
		});
	});

	test("a token identifies the tunnel by itself, so `run` takes no argument", () => {
		expect(
			planCloudflared({ hostname: "mc.example.com" }, 25565, true),
		).toEqual({
			mode: "named",
			hostname: "mc.example.com",
			args: ["tunnel", "--no-autoupdate", "run"],
		});
	});

	test("a tunnel *name* typed into tunnelId is caught, not passed on", () => {
		// cloudflared would accept it and fail later with its own error; the field
		// it names is the one thing this can say and that one cannot.
		expect(() =>
			planCloudflared({ tunnelId: "my-tunnel", hostname: "mc.example.com" }, 1),
		).toThrow(/not a tunnel id/);
	});

	test("a pre-defined tunnel must name the hostname its ingress serves", () => {
		expect(() =>
			planCloudflared({ tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef" }, 1),
		).toThrow(/hostname/);
	});

	test("mode=named with nothing to run on is refused", () => {
		expect(() =>
			planCloudflared({ mode: "named", hostname: "mc.example.com" }, 1),
		).toThrow(/tunnelId/);
	});

	test("mode=quick beside a tunnel is a contradiction, not a silent winner", () => {
		expect(() => planCloudflared({ mode: "quick", tunnel: "mc" }, 1)).toThrow(
			/cannot also name a tunnel/,
		);
	});

	test("an unknown mode names the two that exist", () => {
		expect(() =>
			// A profile is free-form text, so this is a plain typo, not a type error.
			planCloudflared({ mode: "tunnel" as "quick" }, 1),
		).toThrow(/"quick".*"named"/);
	});
});

/**
 * What the real providers declare as their options.
 *
 * The declaration is rendered as a form by Settings and printed by
 * `mctl network profile --help`, so a broken one is a broken *field* — a
 * `showWhen` naming a key that does not exist silently hides its field forever,
 * and a duplicate key gives two controls the same slot in the profile.
 */
describe("declared provider options", () => {
	const providers = createProviderRegistry().networks();

	test("every network provider declares its options", () => {
		// Required on the interface, so this is really checking that the five
		// shipped providers were each thought about rather than given `[]` by a
		// compiler error.
		expect(providers.length).toBeGreaterThan(0);
		const withOptions = providers.filter((p) => p.options.length > 0);
		expect(withOptions.map((p) => p.id).sort()).toEqual([
			"cloudflared",
			"direct",
			"ngrok",
			"playit",
			"tailscale",
		]);
	});

	for (const provider of providers) {
		test(`${provider.id}: keys are unique and every showWhen resolves`, () => {
			const keys = provider.options.map((option) => option.key);
			expect(new Set(keys).size).toBe(keys.length);
			for (const option of provider.options) {
				if (!option.showWhen) continue;
				const target = provider.options.find(
					(entry) => entry.key === option.showWhen?.key,
				);
				expect(target).toBeDefined();
				// A condition on a free-text field can never be met reliably; the ones
				// that gate a field are choices (or booleans).
				expect(["choice", "boolean"]).toContain(target?.kind ?? "missing");
			}
			for (const option of provider.options) {
				if (option.kind !== "choice") continue;
				expect(option.choices?.length ?? 0).toBeGreaterThan(1);
			}
		});
	}
});
