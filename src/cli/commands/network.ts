/**
 * `mctl network [status|up|down]` — inspect and drive the networking subsystem.
 *
 * Thin CLI bridge to `core/network/`: it resolves nothing itself and holds no
 * logic the TUI's Network page lacks (AGENTS.md § 3). Both render the same view
 * models — `ProviderReadiness`, `ProfileSummary`, `NetStatus`.
 *
 * `up` and `down` exist because exposing is otherwise a side effect of starting
 * a server, and there are two real cases where that is not enough: a tunnel that
 * dropped and needs bringing back without restarting the server, and a profile
 * the user just edited. Neither should require stopping Minecraft.
 *
 * `profile` is the keyboard peer of the Settings page's Network group, over the
 * same `core/network/profiles.ts` transforms — including its `key=value` option
 * format, so a profile written here and one written there are the same file.
 */

import {
	deleteProfile,
	describeOptions,
	formatOptions,
	parseOptions,
	saveProfile,
	setDefaultProfile,
} from "../../core/network/profiles.ts";
import { createProviderRegistry } from "../../providers/index.ts";
import { getServer, listServers } from "../../core/server/discover.ts";
import { readinessLabel } from "../../types/network.ts";
import {
	ArgError,
	boolFlag,
	intFlag,
	parseArgs,
	stringFlag,
	type ParsedArgs,
} from "../args.ts";
import { cliContext, reportError } from "../context.ts";
import { renderTable, toJson, wantsJson } from "../format.ts";

const HELP = `mctl network — join addresses, tunnels, and DNS

Usage:
  mctl network [--json]            providers this machine can use, and every profile
  mctl network status [<id>]       one server's networking (or all of them)
  mctl network up <id>             expose a running server through its profile
  mctl network down <id>           tear down a server's tunnel and DNS records

  mctl network profile [--json]        list the configured profiles
  mctl network profile show <name>     one profile in full
  mctl network profile set <name> …    create or update a profile
  mctl network profile rm <name>       delete a profile
  mctl network profile default <name>  use it for newly created servers

Flags:
  --json       machine-readable output
  -h, --help   show this help

\`profile set\` flags:
  --provider <id>          direct | cloudflared | playit | ngrok | tailscale
  --options "k=v, k2=v2"   provider options, replacing any already set
  --dns-zone <zone>        Cloudflare zone name or id
  --dns-hostname <host>    hostname players join, e.g. mc.example.com
  --dns-ttl <seconds>      record TTL (default 60; 1 = automatic)
  --dns-proxied            route through Cloudflare's proxy (breaks Minecraft)
  --no-dns-srv             skip the _minecraft._tcp SRV record
  --no-dns                 remove DNS automation from the profile

Tunnel binaries are never downloaded by MCTL. A missing one degrades that
profile to \`direct\` with an install hint — it never stops a server starting.`;

/**
 * Run `mctl network`.
 * @param argv arguments after `network`.
 */
export async function runNetwork(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		console.log(providerOptionsHelp());
		return 0;
	}

	const [subcommand, ...rest] = argv;
	try {
		if (subcommand === undefined || subcommand === "--json") {
			return await overview(argv);
		}
		if (subcommand === "status") return await status(rest);
		if (subcommand === "up") return await up(rest);
		if (subcommand === "down") return await down(rest);
		if (subcommand === "profile") return await profile(rest);
		throw new ArgError(`unknown network subcommand \`${subcommand}\``);
	} catch (err) {
		return reportError(err);
	}
}

/**
 * What each provider reads out of `--options`, built from the providers
 * themselves (`NetworkProvider.options`) rather than typed out here.
 *
 * It is the same declaration the Settings form renders as fields, which is the
 * point: a provider that gains an option gains it in both front-ends at once and
 * neither can go a phase stale. The registry is built directly because it needs
 * no config — `--help` still works before `mctl init`.
 */
function providerOptionsHelp(): string {
	const sections = createProviderRegistry()
		.networks()
		.map((provider) => {
			const lines = describeOptions(provider.options);
			return [
				`  ${provider.id}`,
				...(lines.length > 0
					? lines.map((line) => `    ${line}`)
					: ["    (no options)"]),
			].join("\n");
		});
	return `Provider options, for \`profile set --options\`:\n\n${sections.join("\n\n")}`;
}

/** Providers and their readiness, plus the configured profiles. */
async function overview(argv: string[]): Promise<number> {
	parseArgs(argv, { boolean: ["json"] });
	const context = await cliContext();
	const [readiness, profiles] = [
		await context.network.readiness(),
		context.network.profiles(),
	];

	if (wantsJson(argv)) {
		console.log(toJson({ providers: readiness, profiles }));
		return 0;
	}

	console.log(
		renderTable(
			["PROVIDER", "STATE", "DETAIL"],
			readiness.map((entry) => [
				entry.provider,
				entry.readiness.kind,
				readinessLabel(entry.readiness),
			]),
		),
	);
	// The install hint is the actionable part and is far too long for a table
	// cell, so it is printed under the table for exactly the providers that need it.
	for (const entry of readiness) {
		if (entry.readiness.kind === "missing") {
			console.log(`\n${entry.provider}: ${entry.readiness.hint}`);
		}
	}
	console.log("");
	console.log(
		renderTable(
			["PROFILE", "PROVIDER", "DNS"],
			profiles.map((profile) => [
				profile.name,
				profile.known ? profile.provider : `${profile.provider} (unknown)`,
				profile.dnsHostname ?? "—",
			]),
		),
	);
	return 0;
}

/** One server's networking, or every server's. */
async function status(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const context = await cliContext();
	const id = args.positionals[0];

	const servers = id
		? [await require_(id, context.paths.serversDir)]
		: await listServers(context.paths.serversDir);
	const rows = await Promise.all(
		servers.map(async (server) => ({
			id: server.id,
			...(await context.network.status(server)),
		})),
	);

	if (wantsJson(argv)) {
		console.log(toJson(id ? rows[0] : rows));
		return 0;
	}
	if (rows.length === 0) {
		console.log("No servers yet. Create one with `mctl create <name>`.");
		return 0;
	}
	console.log(
		renderTable(
			["ID", "PROFILE", "PROVIDER", "STATE", "JOIN ADDRESS"],
			rows.map((row) => [
				row.id,
				row.profile,
				row.provider,
				row.state,
				row.endpoint?.joinAddress ?? "—",
			]),
		),
	);
	// A note explains an address that will not work as typed (cloudflared) or a
	// state the address alone does not account for (degraded). Printing it only
	// for one server keeps the table readable while `status <id>` stays complete.
	if (id) {
		const row = rows[0];
		if (row?.detail) console.log(`\n${row.detail}`);
		if (row?.endpoint?.note) console.log(`\n${row.endpoint.note}`);
		for (const alternate of row?.endpoint?.alternates ?? []) {
			console.log(`${alternate.label}: ${alternate.address}`);
		}
	}
	return 0;
}

/** Expose a running server through its profile. */
async function up(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const id = args.positionals[0];
	if (id === undefined) throw new ArgError("network up needs a server id");

	const context = await cliContext();
	const server = await require_(id, context.paths.serversDir);
	if (server.state !== "running") {
		throw new ArgError(
			`server "${id}" is not running — there is no port to expose yet`,
		);
	}
	// The port the runtime actually recorded at start, not one re-read from
	// `server.properties`: an edit since the server booted has not taken effect.
	const port = server.session?.port;
	if (port === undefined) {
		throw new ArgError(
			`server "${id}" recorded no port; restart it so MCTL can see which port it bound`,
		);
	}

	// Whatever is up now is replaced, so `up` is also how a dropped tunnel is
	// restored and how a just-edited profile is applied.
	await context.network.teardown(server);
	const result = await context.network.expose(server, port);

	if (wantsJson(argv)) {
		console.log(toJson(result));
		return 0;
	}
	console.log(
		`${server.id} is reachable at ${result.endpoint.joinAddress} (${result.provider})`,
	);
	if (result.degradedReason) {
		console.log(`\nProfile degraded to direct: ${result.degradedReason}`);
	}
	if (result.dnsHostname) console.log(`DNS: ${result.dnsHostname}`);
	if (result.dnsError) console.log(`\nDNS not published: ${result.dnsError}`);
	if (result.dnsSkipped) console.log(`\nDNS not needed: ${result.dnsSkipped}`);
	if (result.endpoint.note) console.log(`\n${result.endpoint.note}`);
	return 0;
}

/** Tear down a server's tunnel and DNS records. */
async function down(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const id = args.positionals[0];
	if (id === undefined) throw new ArgError("network down needs a server id");

	const context = await cliContext();
	const server = await require_(id, context.paths.serversDir);
	await context.network.teardown(server);
	console.log(wantsJson(argv) ? toJson({ id, state: "down" }) : `${id}: down`);
	return 0;
}

// ---------------------------------------------------------------------------
// profile — the write side of config.network.profiles.
// ---------------------------------------------------------------------------

/** Flags `profile set` accepts. Declared once; `parseArgs` rejects anything else. */
const SET_FLAGS = {
	valued: [
		"provider",
		"options",
		"dns-zone",
		"dns-hostname",
		"dns-ttl",
	] as const,
	boolean: ["json", "dns-proxied", "dns-srv", "dns"] as const,
};

/** `mctl network profile …` — list, show, set, rm, default. */
async function profile(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;
	if (subcommand === undefined || subcommand === "--json") {
		return profileList(argv);
	}
	if (subcommand === "show") return profileShow(rest);
	if (subcommand === "set") return profileSet(rest);
	if (subcommand === "rm" || subcommand === "remove")
		return profileRemove(rest);
	if (subcommand === "default") return profileDefault(rest);
	throw new ArgError(`unknown profile subcommand \`${subcommand}\``);
}

/** Every configured profile, with the default marked. */
async function profileList(argv: string[]): Promise<number> {
	parseArgs(argv, { boolean: ["json"] });
	const context = await cliContext();
	const summaries = context.network.profiles();
	const fallback = context.config.network.defaultProfile;

	if (wantsJson(argv)) {
		console.log(
			toJson({
				defaultProfile: fallback,
				profiles: summaries.map((summary) => ({
					...summary,
					options: context.config.network.profiles[summary.name]?.options,
					dns: context.config.network.profiles[summary.name]?.dns,
				})),
			}),
		);
		return 0;
	}
	console.log(
		renderTable(
			["PROFILE", "PROVIDER", "DNS", "DEFAULT"],
			summaries.map((summary) => [
				summary.name,
				summary.known ? summary.provider : `${summary.provider} (unknown)`,
				summary.dnsHostname ?? "—",
				summary.name === fallback ? "yes" : "",
			]),
		),
	);
	return 0;
}

/** One profile in full — the options and DNS block the table cannot carry. */
async function profileShow(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const name = args.positionals[0];
	if (name === undefined) throw new ArgError("profile show needs a name");

	const context = await cliContext();
	const entry = context.config.network.profiles[name];
	if (!entry) throw new ArgError(`no such network profile: ${name}`);

	if (wantsJson(argv)) {
		console.log(toJson({ name, ...entry }));
		return 0;
	}
	console.log(`profile   ${name}`);
	console.log(`provider  ${entry.provider}`);
	console.log(`options   ${formatOptions(entry.options) || "—"}`);
	if (entry.dns) {
		console.log(
			`dns       ${entry.dns.hostname} (zone ${entry.dns.zone}, ttl ${entry.dns.ttl}, srv ${entry.dns.srv ? "on" : "off"}, proxied ${entry.dns.proxied ? "on" : "off"})`,
		);
	} else {
		console.log("dns       —");
	}
	if (name === context.config.network.defaultProfile) {
		console.log("\nThis is the default profile for newly created servers.");
	}
	return 0;
}

/**
 * Create or update a profile.
 *
 * An unknown provider id is **refused** rather than written: the forward-
 * compatibility rule (a free-string `provider`, so a config from a newer MCTL
 * still loads) is about *reading* a file this build did not write. Writing an id
 * nothing can resolve would only produce a profile that silently degrades to
 * direct at the next start, which is far harder to diagnose than an error here.
 */
async function profileSet(argv: string[]): Promise<number> {
	const args = parseArgs(argv, SET_FLAGS);
	const name = args.positionals[0];
	if (name === undefined) throw new ArgError("profile set needs a name");

	const context = await cliContext();
	const provider = stringFlag(args, "provider");
	if (
		provider !== undefined &&
		!context.providers.networkIds().includes(provider)
	) {
		throw new ArgError(
			`unknown network provider "${provider}" — this build has: ${context.providers.networkIds().join(", ")}`,
		);
	}

	const rawOptions = stringFlag(args, "options");
	const written = await saveProfile(context.config, name, {
		provider,
		options: rawOptions === undefined ? undefined : parseOptions(rawOptions),
		dns: dnsFrom(args, context.config.network.profiles[name]?.dns),
	});

	const saved = written.network.profiles[name];
	console.log(
		wantsJson(argv)
			? toJson({ name, ...saved })
			: `${name}: ${saved?.provider}${saved?.dns ? ` + dns ${saved.dns.hostname}` : ""}`,
	);
	return 0;
}

/**
 * The `dns` value a `profile set` implies: `null` to clear, `undefined` to leave
 * as it is, or a merged block.
 *
 * Merging over what the profile already has is what makes `--dns-ttl 300` on its
 * own work — the alternative would demand the zone and hostname be retyped on
 * every tweak.
 */
function dnsFrom(
	args: ParsedArgs,
	current:
		| {
				zone: string;
				hostname: string;
				ttl: number;
				srv: boolean;
				proxied: boolean;
		  }
		| undefined,
): unknown | null | undefined {
	if (boolFlag(args, "dns") === false) return null;
	const zone = stringFlag(args, "dns-zone");
	const hostname = stringFlag(args, "dns-hostname");
	const ttl = intFlag(args, "dns-ttl");
	const proxied = boolFlag(args, "dns-proxied");
	const srv = boolFlag(args, "dns-srv");
	if (
		zone === undefined &&
		hostname === undefined &&
		ttl === undefined &&
		proxied === undefined &&
		srv === undefined
	) {
		return undefined;
	}
	// Left to the schema to reject when neither a flag nor an existing value
	// supplies the zone or hostname — one definition of what a valid DNS block is.
	return {
		...(current ?? {}),
		...(zone !== undefined ? { zone } : {}),
		...(hostname !== undefined ? { hostname } : {}),
		...(ttl !== undefined ? { ttl } : {}),
		...(proxied !== undefined ? { proxied } : {}),
		...(srv !== undefined ? { srv } : {}),
	};
}

/** Delete a profile. Servers still naming it fall back to `direct`. */
async function profileRemove(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const name = args.positionals[0];
	if (name === undefined) throw new ArgError("profile rm needs a name");

	const context = await cliContext();
	await deleteProfile(context.config, name);

	// Named rather than left to be discovered: a server pointing at a profile that
	// no longer exists still starts, on direct networking, which is easy to read as
	// a broken tunnel if nobody said so.
	const orphans = (await listServers(context.paths.serversDir))
		.filter((server) => server.network === name)
		.map((server) => server.id);

	if (wantsJson(argv)) {
		console.log(toJson({ name, removed: true, affected: orphans }));
		return 0;
	}
	console.log(`removed profile ${name}`);
	if (orphans.length > 0) {
		console.log(
			`\nThese servers still name it and will use direct networking at their next start: ${orphans.join(", ")}`,
		);
		console.log(`Repoint one with \`mctl edit <id> --network <profile>\`.`);
	}
	return 0;
}

/** Make a profile the default for newly created servers. */
async function profileDefault(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const name = args.positionals[0];
	if (name === undefined) throw new ArgError("profile default needs a name");

	const context = await cliContext();
	await setDefaultProfile(context.config, name);
	console.log(
		wantsJson(argv)
			? toJson({ defaultProfile: name })
			: `new servers will use the ${name} profile`,
	);
	return 0;
}

/** Load a server or fail with a message a user can act on. */
async function require_(id: string, serversDir: string) {
	const server = await getServer(id, serversDir);
	if (!server) throw new ArgError(`no such server: ${id}`);
	return server;
}
