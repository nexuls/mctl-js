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
