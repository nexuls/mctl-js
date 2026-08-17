/**
 * Tests for the Settings edit-buffer mapping — the pure half of
 * `use-settings.ts` (the React hook itself needs a renderer and is exercised by
 * running the app).
 *
 * The load-bearing property is **merge-not-replace**: saving the form must never
 * drop a config key the form doesn't render (backup schedule/retention, named
 * network profiles, a key written by a newer MCTL).
 */

import { describe, expect, test } from "bun:test";
import { Config } from "../../types/config.ts";
import {
	configToDraft,
	draftToConfig,
	emptyProfile,
	profileIssues,
	validateDraft,
	type SettingsDraft,
} from "./use-settings.ts";

/** A parsed config with every schema default filled in, rooted at `/tmp/root`. */
function baseConfig(overrides: Record<string, unknown> = {}): Config {
	return Config.parse({ root: "/tmp/root", ...overrides });
}

describe("configToDraft", () => {
	test("absent overrides pre-fill the root-relative defaults, toggles off", () => {
		const draft = configToDraft(baseConfig());
		expect(draft.overrideServers).toBe(false);
		expect(draft.serversDir).toBe("/tmp/root/servers");
		expect(draft.overrideBackups).toBe(false);
		expect(draft.backupsDir).toBe("/tmp/root/backups");
	});

	test("present overrides turn the toggles on and carry the path", () => {
		const draft = configToDraft(
			baseConfig({ servers_dir: "/mnt/big/mc", backups_dir: "/mnt/big/bk" }),
		);
		expect(draft.overrideServers).toBe(true);
		expect(draft.serversDir).toBe("/mnt/big/mc");
		expect(draft.overrideBackups).toBe(true);
		expect(draft.backupsDir).toBe("/mnt/big/bk");
	});

	test("an absent default Minecraft version becomes an empty field", () => {
		expect(configToDraft(baseConfig()).minecraftVersion).toBe("");
	});
});

describe("draftToConfig", () => {
	test("round-trips an untouched draft to an equivalent config", () => {
		const config = baseConfig({ servers_dir: "/mnt/big/mc" });
		const written = Config.parse(
			draftToConfig(config, configToDraft(config), config.theme, config.icons),
		);
		expect(written).toEqual(config);
	});

	test("keeps fields the form does not render", () => {
		const config = baseConfig({
			backup: { enabled: true, schedule: "0 4 * * *", retention: 7 },
			network: {
				defaultProfile: "direct",
				profiles: {
					direct: { provider: "direct" },
					lan: { provider: "direct", options: { iface: "eth0" } },
				},
			},
		});
		const draft = configToDraft(config);
		const written = Config.parse(
			draftToConfig(
				config,
				{ ...draft, memory: "8G" },
				config.theme,
				config.icons,
			),
		);
		expect(written.defaults.memory).toBe("8G");
		expect(written.backup.schedule).toBe("0 4 * * *");
		expect(written.backup.retention).toBe(7);
		expect(Object.keys(written.network.profiles)).toEqual(["direct", "lan"]);
	});

	test("turning an override off removes the key, restoring the default", () => {
		const config = baseConfig({ servers_dir: "/mnt/big/mc" });
		const draft = { ...configToDraft(config), overrideServers: false };
		const written = Config.parse(
			draftToConfig(config, draft, config.theme, config.icons),
		);
		expect(written.servers_dir).toBeUndefined();
	});

	test("takes the theme id from the argument, not the stale config", () => {
		const config = baseConfig({ theme: "terminal" });
		const written = Config.parse(
			draftToConfig(config, configToDraft(config), "nord", config.icons),
		);
		expect(written.theme).toBe("nord");
	});

	test("blanking the Minecraft version drops the key rather than writing ''", () => {
		const config = baseConfig({ defaults: { minecraftVersion: "1.21.4" } });
		const draft = { ...configToDraft(config), minecraftVersion: "  " };
		const written = Config.parse(
			draftToConfig(config, draft, config.theme, config.icons),
		);
		expect(written.defaults.minecraftVersion).toBeUndefined();
	});
});

describe("validateDraft", () => {
	const draft = (patch: Partial<SettingsDraft>): SettingsDraft => ({
		...configToDraft(baseConfig()),
		...patch,
	});

	test("a clean draft has no issues", () => {
		expect(validateDraft(draft({}))).toEqual({});
	});

	test("a relative override path is rejected — but only while enabled", () => {
		expect(
			validateDraft(draft({ overrideServers: true, serversDir: "mc" }))
				.serversDir,
		).toBeDefined();
		expect(
			validateDraft(draft({ overrideServers: false, serversDir: "mc" }))
				.serversDir,
		).toBeUndefined();
	});

	test("memory may not be blank", () => {
		expect(validateDraft(draft({ memory: "   " })).memory).toBeDefined();
	});
});

describe("draftToConfig — icon mode", () => {
	test("takes the icon mode from the argument, not the stale config", () => {
		// The icon provider persists on change, so `config` in hand can lag one
		// write behind the set the user is actually looking at.
		const config = baseConfig({ icons: "auto" });
		const written = Config.parse(
			draftToConfig(config, configToDraft(config), config.theme, "ascii"),
		);
		expect(written.icons).toBe("ascii");
	});
});

/**
 * The network-profile editor, which is the one part of the form that edits a
 * *collection* rather than a field — so the mapping has two extra jobs: a stable
 * row identity while a name is being retyped, and a deletion that actually
 * reaches the file (the profiles are the one section written wholesale).
 */
describe("profiles", () => {
	const tunnelled = () =>
		baseConfig({
			network: {
				defaultProfile: "direct",
				profiles: {
					direct: { provider: "direct" },
					"cf-tunnel": {
						provider: "cloudflared",
						options: { tunnel: "mc", timeoutSeconds: 45 },
						dns: { zone: "example.com", hostname: "mc.example.com", ttl: 120 },
					},
				},
			},
		});

	test("configToDraft flattens each profile into an editable row", () => {
		const [direct, tunnel] = configToDraft(tunnelled()).profiles;
		expect(direct?.name).toBe("direct");
		expect(direct?.dnsEnabled).toBe(false);
		expect(tunnel?.provider).toBe("cloudflared");
		expect(tunnel?.options).toBe("tunnel=mc, timeoutSeconds=45");
		expect(tunnel?.dnsEnabled).toBe(true);
		expect(tunnel?.dnsZone).toBe("example.com");
		expect(tunnel?.dnsTtl).toBe("120");
	});

	test("an untouched profile round-trips byte-for-byte", () => {
		const config = tunnelled();
		const written = Config.parse(
			draftToConfig(config, configToDraft(config), config.theme, config.icons),
		);
		expect(written.network.profiles).toEqual(config.network.profiles);
	});

	test("a profile removed from the draft is removed from the config", () => {
		const config = tunnelled();
		const draft = configToDraft(config);
		const written = Config.parse(
			draftToConfig(
				config,
				{
					...draft,
					profiles: draft.profiles.filter((p) => p.name !== "cf-tunnel"),
				},
				config.theme,
				config.icons,
			),
		);
		expect(Object.keys(written.network.profiles)).toEqual(["direct"]);
	});

	test("a renamed profile moves rather than duplicating", () => {
		const config = tunnelled();
		const draft = configToDraft(config);
		const written = Config.parse(
			draftToConfig(
				config,
				{
					...draft,
					profiles: draft.profiles.map((p) =>
						p.name === "cf-tunnel" ? { ...p, name: "cf" } : p,
					),
				},
				config.theme,
				config.icons,
			),
		);
		expect(Object.keys(written.network.profiles)).toEqual(["direct", "cf"]);
	});

	test("a new profile is written with its DNS block", () => {
		const config = baseConfig();
		const draft = configToDraft(config);
		const added = {
			...emptyProfile("cf"),
			provider: "cloudflared",
			options: "tunnel=mc",
			dnsEnabled: true,
			dnsZone: "example.com",
			dnsHostname: "mc.example.com",
		};
		const written = Config.parse(
			draftToConfig(
				config,
				{ ...draft, profiles: [...draft.profiles, added] },
				config.theme,
				config.icons,
			),
		);
		expect(written.network.profiles.cf).toEqual({
			provider: "cloudflared",
			options: { tunnel: "mc" },
			dns: {
				zone: "example.com",
				hostname: "mc.example.com",
				ttl: 60,
				proxied: false,
				srv: true,
			},
		});
	});
});

describe("profileIssues", () => {
	test("a stock config has none", () => {
		expect(profileIssues(configToDraft(baseConfig()).profiles)).toEqual([{}]);
	});

	test("flags a duplicate name on the second row, not the first", () => {
		const issues = profileIssues([
			emptyProfile("direct"),
			emptyProfile("direct"),
		]);
		expect(issues[0]?.name).toBeUndefined();
		expect(issues[1]?.name).toBe("already used");
	});

	test("flags an unusable name and unparseable options", () => {
		expect(profileIssues([emptyProfile("Cf Tunnel")])[0]?.name).toBeDefined();
		expect(
			profileIssues([{ ...emptyProfile("cf"), options: "tunnel" }])[0]?.options,
		).toBeDefined();
	});

	test("DNS fields are only required once DNS is on", () => {
		const off = { ...emptyProfile("cf"), dnsZone: "", dnsHostname: "" };
		expect(profileIssues([off])[0]).toEqual({});
		const on = { ...off, dnsEnabled: true, dnsTtl: "soon" };
		const issues = profileIssues([on])[0];
		expect(issues?.dnsZone).toBe("required");
		expect(issues?.dnsHostname).toBe("required");
		expect(issues?.dnsTtl).toBeDefined();
	});
});

describe("validateDraft — network invariants", () => {
	const draft = (patch: Partial<SettingsDraft>): SettingsDraft => ({
		...configToDraft(baseConfig()),
		...patch,
	});

	test("rolls a profile problem up so its tab can be flagged", () => {
		const issues = validateDraft(
			draft({ profiles: [emptyProfile("direct"), emptyProfile("Bad Name")] }),
		);
		expect(issues.profiles).toContain("Bad Name");
	});

	test("`direct` may not be deleted, and the default must exist", () => {
		expect(
			validateDraft(draft({ profiles: [emptyProfile("lan")], network: "lan" }))
				.profiles,
		).toContain("direct");
		expect(validateDraft(draft({ network: "gone" })).network).toBeDefined();
	});
});
