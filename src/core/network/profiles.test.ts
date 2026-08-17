/**
 * Tests for the network-profile transforms.
 *
 * All of them are pure `Config → Config`, which is the whole reason the write
 * (`saveProfile`) is one line on top: the rules that matter — which profiles may
 * not be deleted, what an option string means, what happens to the fields a
 * partial edit does not mention — are checkable without a `$HOME`, a config file
 * or a mocked `writeConfig`.
 */

import { describe, expect, test } from "bun:test";
import { Config } from "../../types/config.ts";
import {
	DIRECT_PROFILE,
	ProfileError,
	formatOptions,
	parseOptions,
	profileNameIssue,
	withDefaultProfile,
	withProfile,
	withoutProfile,
} from "./profiles.ts";

/** A parsed config with every schema default filled in. */
function baseConfig(overrides: Record<string, unknown> = {}): Config {
	return Config.parse({ root: "/tmp/root", ...overrides });
}

/** A config that already defines a second, tunnelled profile. */
function withTunnel(): Config {
	return baseConfig({
		network: {
			defaultProfile: "direct",
			profiles: {
				direct: { provider: "direct" },
				"cf-tunnel": {
					provider: "cloudflared",
					options: { tunnel: "mc", hostname: "mc.example.com" },
					dns: { zone: "example.com", hostname: "mc.example.com" },
				},
			},
		},
	});
}

describe("profileNameIssue", () => {
	test("accepts the shape a server may store in its mctl.json", () => {
		expect(profileNameIssue("direct")).toBeUndefined();
		expect(profileNameIssue("cf-tunnel-2")).toBeUndefined();
	});

	test("rejects an empty name and anything a command line would fight", () => {
		expect(profileNameIssue("")).toBe("required");
		expect(profileNameIssue("  ")).toBeDefined();
		expect(profileNameIssue("Cf Tunnel")).toBeDefined();
		expect(profileNameIssue("-leading")).toBeDefined();
	});
});

describe("withProfile", () => {
	test("creates a profile without disturbing the others", () => {
		const next = withProfile(baseConfig(), "ngrok-eu", { provider: "ngrok" });
		expect(next.network.profiles["ngrok-eu"]).toEqual({
			provider: "ngrok",
			options: undefined,
			dns: undefined,
		});
		expect(next.network.profiles[DIRECT_PROFILE]).toBeDefined();
		expect(next.network.defaultProfile).toBe("direct");
	});

	test("a partial edit keeps the fields it does not mention", () => {
		const next = withProfile(withTunnel(), "cf-tunnel", { provider: "ngrok" });
		const profile = next.network.profiles["cf-tunnel"];
		expect(profile?.provider).toBe("ngrok");
		expect(profile?.options).toEqual({
			tunnel: "mc",
			hostname: "mc.example.com",
		});
		expect(profile?.dns?.hostname).toBe("mc.example.com");
	});

	test("options replace rather than merge, and an empty map is dropped", () => {
		const one = withProfile(withTunnel(), "cf-tunnel", {
			options: { hostname: "other.example.com" },
		});
		// Replacement is what makes a stale key removable at all — a merge would
		// leave `tunnel` behind with no way to take it out.
		expect(one.network.profiles["cf-tunnel"]?.options).toEqual({
			hostname: "other.example.com",
		});
		const none = withProfile(withTunnel(), "cf-tunnel", { options: {} });
		expect(none.network.profiles["cf-tunnel"]?.options).toBeUndefined();
	});

	test("`dns: null` removes the DNS block", () => {
		const next = withProfile(withTunnel(), "cf-tunnel", { dns: null });
		expect(next.network.profiles["cf-tunnel"]?.dns).toBeUndefined();
	});

	test("DNS defaults come from the schema, and proxied stays off", () => {
		const next = withProfile(baseConfig(), "cf", {
			provider: "cloudflared",
			dns: { zone: "example.com", hostname: "mc.example.com" },
		});
		const dns = next.network.profiles.cf?.dns;
		expect(dns?.ttl).toBe(60);
		expect(dns?.srv).toBe(true);
		// The orange cloud speaks HTTP(S); a proxied record makes a Minecraft
		// server unreachable rather than protected.
		expect(dns?.proxied).toBe(false);
	});

	test("rejects an invalid name and DNS the schema will not take", () => {
		expect(() => withProfile(baseConfig(), "Cf Tunnel", {})).toThrow(
			ProfileError,
		);
		expect(() =>
			withProfile(baseConfig(), "cf", { dns: { zone: "example.com" } }),
		).toThrow(ProfileError);
	});
});

describe("withoutProfile", () => {
	test("removes a profile", () => {
		const next = withoutProfile(withTunnel(), "cf-tunnel");
		expect(next.network.profiles["cf-tunnel"]).toBeUndefined();
		expect(next.network.profiles.direct).toBeDefined();
	});

	test("refuses `direct` — it is the floor every failure lands on", () => {
		expect(() => withoutProfile(withTunnel(), DIRECT_PROFILE)).toThrow(
			/cannot be removed/,
		);
	});

	test("refuses the default profile", () => {
		const config = baseConfig({
			network: {
				defaultProfile: "cf-tunnel",
				profiles: {
					direct: { provider: "direct" },
					"cf-tunnel": { provider: "cloudflared" },
				},
			},
		});
		expect(() => withoutProfile(config, "cf-tunnel")).toThrow(
			/default profile/,
		);
	});

	test("refuses a profile that does not exist", () => {
		expect(() => withoutProfile(baseConfig(), "nope")).toThrow(/no such/);
	});
});

describe("withDefaultProfile", () => {
	test("points the default at another profile", () => {
		expect(
			withDefaultProfile(withTunnel(), "cf-tunnel").network.defaultProfile,
		).toBe("cf-tunnel");
	});

	test("refuses a default that names nothing", () => {
		expect(() => withDefaultProfile(baseConfig(), "nope")).toThrow(/no such/);
	});
});

describe("parseOptions / formatOptions", () => {
	test("reads JSON values and leaves plain text alone", () => {
		expect(parseOptions("tunnel=mc, hostname=mc.example.com")).toEqual({
			tunnel: "mc",
			hostname: "mc.example.com",
		});
		expect(parseOptions("timeoutSeconds=30, publicAddress=false")).toEqual({
			timeoutSeconds: 30,
			publicAddress: false,
		});
		expect(parseOptions('args=["--quiet"]')).toEqual({ args: ["--quiet"] });
	});

	test("a value may contain `=`; only the first splits", () => {
		expect(parseOptions("remoteAddr=1.2.3.4:19132")).toEqual({
			remoteAddr: "1.2.3.4:19132",
		});
	});

	test("blank entries are skipped and a bare word is an error", () => {
		expect(parseOptions("  ,\n")).toEqual({});
		expect(() => parseOptions("tunnel")).toThrow(/key=value/);
	});

	test("round-trips every value shape a provider reads", () => {
		const options = {
			tunnel: "mc",
			timeoutSeconds: 30,
			publicAddress: false,
			args: ["--quiet"],
			// A numeric *string* must come back a string, not a number — which is why
			// it is written quoted rather than bare.
			region: "31",
		};
		expect(parseOptions(formatOptions(options))).toEqual(options);
	});

	test("an absent option map formats as an empty field", () => {
		expect(formatOptions(undefined)).toBe("");
	});
});
