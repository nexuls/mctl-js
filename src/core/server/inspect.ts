/**
 * Server inspection — everything about a server that is *not* in `mctl.json`:
 * its Minecraft configuration, who is on it, what it is doing to the machine,
 * and how much disk it occupies.
 *
 * Core service — no UI, no argv, no provider imports. It is the read-only
 * counterpart to `discover.ts`: where discovery answers "what servers exist and
 * are they up", inspection answers "and what are they actually doing". Both
 * re-derive from disk and live probes on every call and cache nothing
 * (architecture.md § Statelessness), which is what lets two instances show the
 * same numbers without talking to each other.
 *
 * **Two tiers, deliberately split.** {@link inspectServer} is the cheap tier —
 * a few file reads, a directory listing, one procfs sample and one localhost
 * socket — and is safe to run for every server on a poll. {@link measureSize}
 * is the expensive tier: it walks the whole server directory, which on a large
 * world is thousands of `stat` calls, so it is a separate call the caller
 * schedules far less often.
 *
 * **What is deliberately absent:** TPS/MSPT, per-server network traffic, and JVM
 * heap *occupancy*. None can be obtained from outside the JVM — TPS needs an
 * RCON `/tps` (a Phase-5 subsystem) or a mod, per-process socket byte counters
 * are not exposed by the kernel, and heap usage needs JMX. Showing a guess for
 * any of them would be worse than showing nothing.
 */

import { join } from "node:path";
import {
	dirSize,
	pathExists,
	readDirIfExists,
	readJsonIfExists,
} from "../../lib/fs.ts";
import { lanAddress } from "../../lib/net.ts";
import { sampleUsage, type ProcessUsage } from "../../lib/proc.ts";
import { log } from "../../lib/logger.ts";
import type { Server } from "../../types/server.ts";
import { loadServerProperties, type ServerProperties } from "./properties.ts";
import { pingServer, type ServerStatus } from "./ping.ts";

const logger = log("inspect");

/** Directories whose jar count MCTL reports, keyed by what the count means. */
const CONTENT_DIRS = { mods: "mods", plugins: "plugins" } as const;

/**
 * Player-roster files Minecraft keeps in the server directory. Each is a JSON
 * array, so the roster size is the array length.
 */
const ROSTER_FILES = {
	known: "usercache.json",
	ops: "ops.json",
	whitelisted: "whitelist.json",
	banned: "banned-players.json",
} as const;

/** Counts of what a server directory holds. */
export interface ServerContent {
	/** Jars in `mods/`, or `undefined` when the directory does not exist. */
	mods?: number;
	/** Jars in `plugins/`, or `undefined` when the directory does not exist. */
	plugins?: number;
	/** Datapacks in the world's `datapacks/` directory. */
	datapacks?: number;
	/**
	 * Players the server has ever seen, from `usercache.json`. Minecraft expires
	 * entries after a month, so this is "recently known", not "all time".
	 */
	knownPlayers?: number;
	/** Operators, from `ops.json`. */
	ops?: number;
	/** Whitelisted players, from `whitelist.json` (regardless of enforcement). */
	whitelisted?: number;
	/** Banned players, from `banned-players.json`. */
	banned?: number;
}

/** Where players would connect, as far as this machine can tell. */
export interface ServerAddress {
	/** The port from `server.properties` (25565 when the file is absent). */
	port: number;
	/** The configured bind address; empty means every interface. */
	bindIp: string;
	/** This machine's LAN IPv4, when it has one. */
	lanIp?: string;
	/** The address to hand a player on the same network, e.g. `192.168.1.4:25565`. */
	joinAddress: string;
}

/** On-disk footprint of a server, from the expensive walk. */
export interface ServerSize {
	/** Total bytes under the server directory. */
	totalBytes: number;
	/** Bytes under the active world directory alone. */
	worldBytes: number;
	/** Files counted. */
	files: number;
	/** True when the walk hit its entry cap, so the totals are lower bounds. */
	truncated: boolean;
}

/**
 * The composed inspection of one server. Every field is optional because every
 * source can legitimately be absent: a server that has never booted has no
 * `server.properties`, a stopped one has no process to sample, and a booting one
 * does not answer a list ping yet.
 */
export interface ServerInsight {
	/** The server this describes. */
	id: string;
	/** Minecraft's own configuration, when the server has written it. */
	properties?: ServerProperties;
	/** Live list-ping status: MOTD, version, player count, latency. */
	status?: ServerStatus;
	/** CPU/memory/threads of the server process. */
	usage?: ProcessUsage;
	/** Where to connect. */
	address: ServerAddress;
	/** Counts of mods, plugins, and player rosters. */
	content: ServerContent;
}

/** Count the entries of a JSON array file, or `undefined` when unreadable. */
async function countJsonArray(path: string): Promise<number | undefined> {
	try {
		const data = await readJsonIfExists(path);
		return Array.isArray(data) ? data.length : undefined;
	} catch {
		// A half-written roster (the server rewrites these live) is not an error.
		return undefined;
	}
}

/** Count `.jar` files in a server subdirectory, or `undefined` when it is absent. */
async function countJars(
	dir: string,
	name: string,
): Promise<number | undefined> {
	// "No `mods/` directory" and "an empty `mods/`" must not look the same: a
	// Paper server should show nothing for mods, not "0 mods". `readDirIfExists`
	// returns `[]` for both, so existence is checked separately.
	if (!(await pathExists(join(dir, name)))) return undefined;
	const entries = await readDirIfExists(join(dir, name));
	// Disabled mods are conventionally renamed `*.jar.disabled`; they are present
	// but not loaded, so they are not counted.
	return entries.filter((entry) => entry.endsWith(".jar")).length;
}

/** Read the roster counts and content directories for a server directory. */
async function readContent(
	dir: string,
	levelName: string,
): Promise<ServerContent> {
	const [mods, plugins, datapacks, known, ops, whitelisted, banned] =
		await Promise.all([
			countJars(dir, CONTENT_DIRS.mods),
			countJars(dir, CONTENT_DIRS.plugins),
			readDirIfExists(join(dir, levelName, "datapacks")).then((entries) =>
				entries.length === 0 ? undefined : entries.length,
			),
			countJsonArray(join(dir, ROSTER_FILES.known)),
			countJsonArray(join(dir, ROSTER_FILES.ops)),
			countJsonArray(join(dir, ROSTER_FILES.whitelisted)),
			countJsonArray(join(dir, ROSTER_FILES.banned)),
		]);
	return {
		mods,
		plugins,
		datapacks,
		knownPlayers: known,
		ops,
		whitelisted,
		banned,
	};
}

/**
 * Inspect one server: read its Minecraft configuration and rosters, and — when
 * it is running — sample the process and ask it for a live status.
 *
 * Never throws. Every source degrades to an absent field, because this decorates
 * a listing: one unreadable `usercache.json` must not blank a whole row, and a
 * server that is mid-boot must not read as broken.
 *
 * The port is resolved from the runtime session descriptor first and
 * `server.properties` second — the descriptor records what the process actually
 * bound, which is the truth if the properties file was edited after start.
 */
export async function inspectServer(server: Server): Promise<ServerInsight> {
	if (!server.available) {
		return {
			id: server.id,
			address: { port: 0, bindIp: "", joinAddress: "" },
			content: {},
		};
	}

	let properties: ServerProperties | undefined;
	try {
		properties = await loadServerProperties(server.path);
	} catch (err) {
		logger.warn(
			{ id: server.id, err: String(err) },
			"unreadable server.properties",
		);
	}

	const port = server.session?.port ?? properties?.port ?? 25565;
	const lanIp = lanAddress();
	const content = await readContent(
		server.path,
		properties?.levelName ?? "world",
	).catch(() => ({}) as ServerContent);

	// Only a running server has a process to sample or a socket to ping. Both are
	// run concurrently because the usage sample deliberately spans ~220 ms.
	const [usage, status] =
		server.state === "running" && server.session
			? await Promise.all([
					sampleUsage(server.session.pid),
					// Ping the loopback rather than the LAN address: the server may be
					// bound to 127.0.0.1 only, and a local probe is what we can be sure
					// is reachable from here.
					pingServer("127.0.0.1", port),
				])
			: [undefined, undefined];

	return {
		id: server.id,
		properties,
		status,
		usage,
		address: {
			port,
			bindIp: properties?.bindIp ?? "",
			lanIp,
			joinAddress: `${lanIp ?? "localhost"}:${port}`,
		},
		content,
	};
}

/**
 * Measure a server's on-disk footprint: the whole directory, and the active
 * world within it.
 *
 * **Expensive** — it walks the entire tree, which for a long-lived world means
 * thousands of `stat` calls. Keep it off any per-keystroke path and refresh it
 * on a much slower cadence than {@link inspectServer}.
 */
export async function measureSize(
	server: Server,
	levelName = "world",
): Promise<ServerSize | undefined> {
	if (!server.available) return undefined;
	const [total, world] = await Promise.all([
		dirSize(server.path),
		dirSize(join(server.path, levelName)),
	]);
	return {
		totalBytes: total.bytes,
		worldBytes: world.bytes,
		files: total.files,
		truncated: total.truncated || world.truncated,
	};
}
