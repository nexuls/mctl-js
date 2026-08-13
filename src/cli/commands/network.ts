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
 */

import { getServer, listServers } from "../../core/server/discover.ts";
import { readinessLabel } from "../../types/network.ts";
import { ArgError, parseArgs } from "../args.ts";
import { cliContext, reportError } from "../context.ts";
import { renderTable, toJson, wantsJson } from "../format.ts";

const HELP = `mctl network — join addresses, tunnels, and DNS

Usage:
  mctl network [--json]            providers this machine can use, and every profile
  mctl network status [<id>]       one server's networking (or all of them)
  mctl network up <id>             expose a running server through its profile
  mctl network down <id>           tear down a server's tunnel and DNS records

Flags:
  --json       machine-readable output
  -h, --help   show this help

Tunnel binaries are never downloaded by MCTL. A missing one degrades that
profile to \`direct\` with an install hint — it never stops a server starting.`;

/**
 * Run `mctl network`.
 * @param argv arguments after `network`.
 */
export async function runNetwork(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
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
		throw new ArgError(`unknown network subcommand \`${subcommand}\``);
	} catch (err) {
		return reportError(err);
	}
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

/** Load a server or fail with a message a user can act on. */
async function require_(id: string, serversDir: string) {
	const server = await getServer(id, serversDir);
	if (!server) throw new ArgError(`no such server: ${id}`);
	return server;
}
