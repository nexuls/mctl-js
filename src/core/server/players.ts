/**
 * Player rosters — who this server knows about, and everything it records about
 * each of them.
 *
 * Core service (AGENTS.md § 3): read-only, no UI, no provider imports. A third
 * sibling of `discover.ts` ("what servers exist") and `inspect.ts` ("what is this
 * server doing"), answering "who plays here". Nothing is cached; every call
 * re-reads disk, so two MCTL instances show the same roster without talking
 * (architecture.md § Statelessness).
 *
 * **Five sources, each a different kind of truth:**
 *
 * | Source | Gives |
 * |---|---|
 * | `usercache.json` | names ⇄ uuids the server has resolved recently (Mojang lookups; entries expire after a month) |
 * | `ops.json` / `whitelist.json` / `banned-players.json` / `banned-ips.json` | the four rosters the server rewrites live |
 * | `<world>/stats/<uuid>.json` | lifetime counters: playtime, deaths, kills, distance |
 * | `<world>/playerdata/<uuid>.dat` | the player's *body* at last logout: health, hunger, XP, position, game mode (gzipped NBT) |
 * | a live list ping's sample | who is on right now |
 *
 * **What is genuinely unavailable, and is therefore absent rather than guessed:**
 * per-player *ping* and current session length. Both are known only to the
 * running server, which publishes neither over the list-ping protocol; reaching
 * them needs RCON (`TODO(phase-5)`) or a plugin. `latencyMs` on the server status
 * is MCTL's own round trip, not any player's.
 *
 * **The list ping only returns a *sample* of names** — vanilla caps it at 12 and
 * many servers disable it — so {@link PlayerRoster.onlineUnnamed} reports how
 * many connected players could not be named instead of letting the sample pass
 * for the whole list.
 */

import { join } from "node:path";
import { z } from "zod";
import {
	fileMtime,
	readBytesIfExists,
	readDirIfExists,
	readJsonIfExists,
} from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { nbtGet, nbtNumber, nbtString, parseNbt } from "../../lib/nbt.ts";
import type { Server, ShadowBan } from "../../types/server.ts";
import { MctlJson } from "../../types/server.ts";
import type { PlayerSample } from "./ping.ts";

const logger = log("players");

/**
 * How many `playerdata/*.dat` files are opened per read, most recently modified
 * first. A long-lived public server accumulates thousands of them, and each one
 * is a read plus a gunzip — so the detail tier is bounded and the roster degrades
 * to "known, no details" for the long tail rather than stalling the poll.
 * Online players are always read regardless of this cap.
 */
const MAX_DETAIL_READS = 64;

/** Ticks per second — Minecraft's fixed clock, used to turn playtime into time. */
const TICKS_PER_SECOND = 20;

/** Roster files Minecraft keeps at the top of the server directory. */
const ROSTER = {
	usercache: "usercache.json",
	ops: "ops.json",
	whitelist: "whitelist.json",
	bannedPlayers: "banned-players.json",
	bannedIps: "banned-ips.json",
} as const;

// ---------------------------------------------------------------------------
// Boundary schemas — every one of these files is written by the *server*, not by
// MCTL, and is edited by hand often enough that per-entry validation matters.
// ---------------------------------------------------------------------------

const UserCacheEntry = z.object({
	name: z.string(),
	uuid: z.string(),
	/** When the cached name↔uuid mapping stops being trusted. */
	expiresOn: z.string().optional(),
});

const OpEntry = z.object({
	uuid: z.string(),
	name: z.string(),
	/** 1–4; 4 is full operator. Absent on very old servers, which had no levels. */
	level: z.number().default(4),
	bypassesPlayerLimit: z.boolean().default(false),
});

const WhitelistEntry = z.object({ uuid: z.string(), name: z.string() });

const BanEntry = z.object({
	uuid: z.string().optional(),
	name: z.string().optional(),
	/** Minecraft's own format, e.g. `"2024-05-02 18:11:07 +0200"` — not ISO-8601. */
	created: z.string().optional(),
	/** Who issued it; `"Server"` for a console ban. */
	source: z.string().optional(),
	/** `"forever"` or a timestamp in the same non-ISO format as `created`. */
	expires: z.string().optional(),
	reason: z.string().optional(),
});

const IpBanEntry = BanEntry.extend({ ip: z.string() });

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** Operator status from `ops.json`. */
export interface OpStatus {
	/** Permission level 1–4; 4 is full operator. */
	level: number;
	/** Whether this player may join a full server. */
	bypassesPlayerLimit: boolean;
}

/** A ban as the server recorded it, from `banned-players.json`. */
export interface BanRecord {
	/** When the ban was issued, verbatim from the file. */
	created?: string;
	/** Who issued it. */
	source?: string;
	/** `"forever"` or an expiry timestamp, verbatim. */
	expires?: string;
	/** The reason shown to the player on their next join attempt. */
	reason?: string;
}

/** A banned IP address, which is not tied to any one player. */
export interface IpBanRecord extends BanRecord {
	/** The banned address or range. */
	ip: string;
}

/** Lifetime counters from `<world>/stats/<uuid>.json`. */
export interface PlayerStats {
	/** Total time played, in milliseconds. */
	playTimeMs?: number;
	/** Time since this player last died, in milliseconds. */
	sinceDeathMs?: number;
	/** Deaths. */
	deaths?: number;
	/** Players killed. */
	playerKills?: number;
	/** Mobs killed. */
	mobKills?: number;
	/** Damage dealt, in half-hearts (Minecraft stores tenths; this is rescaled). */
	damageDealt?: number;
	/** Damage taken, in half-hearts. */
	damageTaken?: number;
	/** Total distance travelled by any means, in metres. */
	distanceM?: number;
	/** Blocks broken, summed across every block type. */
	blocksMined?: number;
	/** Items crafted, summed across every recipe. */
	itemsCrafted?: number;
}

/** The player's body as of their last logout, from `playerdata/<uuid>.dat`. */
export interface PlayerState {
	/** Current health in half-hearts, 0–20 by default. */
	health?: number;
	/** The player's maximum health, when it differs from the default 20. */
	maxHealth?: number;
	/** Hunger, 0–20. */
	food?: number;
	/** Saturation — the hidden buffer that drains before hunger does. */
	saturation?: number;
	/** Experience level. */
	xpLevel?: number;
	/** Progress through the current level, 0–1. */
	xpProgress?: number;
	/** Score, shown on the death screen. */
	score?: number;
	/** `survival` | `creative` | `adventure` | `spectator`, when recorded. */
	gameMode?: string;
	/** Dimension the player logged out in, e.g. `minecraft:overworld`. */
	dimension?: string;
	/** Last known position, rounded to whole blocks. */
	position?: { x: number; y: number; z: number };
	/** Number of occupied inventory slots. */
	inventoryItems?: number;
}

/** Everything MCTL can say about one player of one server. */
export interface PlayerProfile {
	/** Stable key for lists and selection: the uuid when known, else the name. */
	key: string;
	/** Player name, as the most authoritative source spelled it. */
	name: string;
	/** Player uuid, when any source carried one. */
	uuid?: string;
	/** True when a live list ping named this player as connected. */
	online: boolean;
	/** Operator status, when they are one. */
	op?: OpStatus;
	/** True when they appear in `whitelist.json`, regardless of enforcement. */
	whitelisted: boolean;
	/** The server's ban record, when they are banned. */
	ban?: BanRecord;
	/** MCTL's own shadow-ban marker; see {@link "../../types/server".ShadowBan}. */
	shadowBan?: ShadowBan;
	/**
	 * Last time this player's data was written, in epoch ms — effectively their
	 * last logout. Taken from the server implementation's own record when it keeps
	 * one (Bukkit/Paper write `lastPlayed`/`LastSeen`), else from the mtime of
	 * their `playerdata` file, which the server rewrites on logout and on save.
	 */
	lastSeen?: number;
	/** First join, in epoch ms, when the server implementation records it. */
	firstSeen?: number;
	/** Lifetime counters, when a stats file exists. */
	stats?: PlayerStats;
	/** Body state at last logout, when player data exists and could be parsed. */
	state?: PlayerState;
}

/** The composed roster of one server. */
export interface PlayerRoster {
	/** Every known player: online first, then most recently seen. */
	players: PlayerProfile[];
	/** IP bans, which belong to no player and are listed separately. */
	bannedIps: IpBanRecord[];
	/**
	 * Connected players the status ping did not name. Non-zero means the server
	 * truncated or disabled its sample — the online cards are then a subset, and
	 * the UI must say so rather than implying the list is complete.
	 */
	onlineUnnamed: number;
	/** True when the detail cap was hit, so some players have no stats or state. */
	detailsTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a JSON array file and validate each entry independently.
 *
 * Per-entry rather than whole-array validation on purpose: these files are
 * hand-edited often (adding an op by hand is standard practice), and one
 * malformed entry must cost that entry, not the whole roster.
 */
async function readRoster<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
	let data: unknown;
	try {
		data = await readJsonIfExists(path);
	} catch {
		// The server rewrites these live, so a read landing mid-write is ordinary.
		return [];
	}
	if (!Array.isArray(data)) return [];
	const out: T[] = [];
	for (const entry of data) {
		const parsed = schema.safeParse(entry);
		if (parsed.success) out.push(parsed.data);
	}
	return out;
}

/** Sum every value of a stats category, e.g. all blocks mined. */
function sumCategory(category: unknown): number | undefined {
	if (typeof category !== "object" || category === null) return undefined;
	let total = 0;
	for (const value of Object.values(category as Record<string, unknown>)) {
		if (typeof value === "number") total += value;
	}
	return total;
}

/**
 * Read one player's lifetime counters.
 *
 * Stat keys are namespaced ids and a few were renamed at 1.13 — `play_time` was
 * `play_one_minute` (and, despite the name, always counted ticks), so both are
 * accepted. Distances are stored in centimetres and damage in tenths of a
 * half-heart; both are rescaled here so the UI never has to know that.
 * https://minecraft.wiki/w/Statistics
 */
async function readStats(
	statsDir: string,
	uuid: string,
): Promise<PlayerStats | undefined> {
	let data: unknown;
	try {
		data = await readJsonIfExists(join(statsDir, `${uuid}.json`));
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null) return undefined;
	const root = data as Record<string, unknown>;
	const stats = (root.stats ?? {}) as Record<string, unknown>;
	const custom = (stats["minecraft:custom"] ?? {}) as Record<string, unknown>;
	const num = (key: string): number | undefined => {
		const value = custom[`minecraft:${key}`];
		return typeof value === "number" ? value : undefined;
	};
	const ticks = num("play_time") ?? num("play_one_minute");
	const sinceDeath = num("time_since_death");
	// Every "distance" statistic is one mode of travel; their sum is how far the
	// player has moved in total, which is the figure worth a line in a UI.
	let distanceCm = 0;
	let sawDistance = false;
	for (const [key, value] of Object.entries(custom)) {
		if (key.endsWith("_one_cm") && typeof value === "number") {
			distanceCm += value;
			sawDistance = true;
		}
	}

	return {
		playTimeMs:
			ticks === undefined ? undefined : (ticks / TICKS_PER_SECOND) * 1000,
		sinceDeathMs:
			sinceDeath === undefined
				? undefined
				: (sinceDeath / TICKS_PER_SECOND) * 1000,
		deaths: num("deaths"),
		playerKills: num("player_kills"),
		mobKills: num("mob_kills"),
		damageDealt:
			num("damage_dealt") === undefined
				? undefined
				: (num("damage_dealt") as number) / 10,
		damageTaken:
			num("damage_taken") === undefined
				? undefined
				: (num("damage_taken") as number) / 10,
		distanceM: sawDistance ? distanceCm / 100 : undefined,
		blocksMined: sumCategory(stats["minecraft:mined"]),
		itemsCrafted: sumCategory(stats["minecraft:crafted"]),
	};
}

/** Minecraft's `playerGameType` integer, in its documented order. */
const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;

/** What {@link readPlayerData} extracts, plus the timestamps found alongside it. */
interface PlayerDataResult {
	state: PlayerState;
	lastSeen?: number;
	firstSeen?: number;
}

/**
 * Read and decode one player's `playerdata/<uuid>.dat`.
 *
 * Returns `undefined` for an absent or undecodable file rather than throwing:
 * the file is rewritten by the server on every autosave, so a read can land
 * mid-write, and a player who has never joined has none at all.
 *
 * Bukkit-family servers add their own compounds to the same file — `bukkit`
 * carries `firstPlayed`/`lastPlayed` and Paper carries `Paper.LastSeen` — which
 * are the only *first join* / *last logout* timestamps that exist anywhere.
 * Vanilla records neither, so on a vanilla server those fall back to the file's
 * mtime (resolved by the caller).
 */
async function readPlayerData(
	file: string,
): Promise<PlayerDataResult | undefined> {
	const bytes = await readBytesIfExists(file);
	if (!bytes) return undefined;

	let root: ReturnType<typeof parseNbt>;
	try {
		root = parseNbt(bytes);
	} catch (err) {
		logger.debug({ file, err: String(err) }, "undecodable player data");
		return undefined;
	}

	const pos = root.Pos;
	const position =
		Array.isArray(pos) && pos.length === 3
			? {
					x: Math.round(nbtNumber(pos[0]) ?? 0),
					y: Math.round(nbtNumber(pos[1]) ?? 0),
					z: Math.round(nbtNumber(pos[2]) ?? 0),
				}
			: undefined;

	// 1.20.5 moved max health into the attribute list; before that it was
	// `Attributes`. Both spell the id differently ("minecraft:generic.max_health"
	// vs "generic.max_health"), so the suffix is what is matched.
	let maxHealth: number | undefined;
	const attributes = root.attributes ?? root.Attributes;
	if (Array.isArray(attributes)) {
		for (const attribute of attributes) {
			if (typeof attribute !== "object" || Array.isArray(attribute)) continue;
			const id = nbtString(
				(attribute as Record<string, unknown>).id as never,
			)?.replace("minecraft:", "");
			if (id === "generic.max_health" || id === "max_health") {
				maxHealth = nbtNumber(
					(attribute as Record<string, unknown>).base as never,
				);
			}
		}
	}

	const gameType = nbtNumber(root.playerGameType);
	const inventory = root.Inventory;

	return {
		state: {
			health: nbtNumber(root.Health),
			maxHealth,
			food: nbtNumber(root.foodLevel),
			saturation: nbtNumber(root.foodSaturationLevel),
			xpLevel: nbtNumber(root.XpLevel),
			xpProgress: nbtNumber(root.XpP),
			score: nbtNumber(root.Score),
			gameMode: gameType !== undefined ? GAME_MODES[gameType] : undefined,
			dimension: nbtString(root.Dimension),
			position,
			inventoryItems: Array.isArray(inventory) ? inventory.length : undefined,
		},
		lastSeen:
			nbtNumber(nbtGet(root, "Paper", "LastSeen")) ??
			nbtNumber(nbtGet(root, "Paper", "LastLogin")) ??
			nbtNumber(nbtGet(root, "bukkit", "lastPlayed")),
		firstSeen: nbtNumber(nbtGet(root, "bukkit", "firstPlayed")),
	};
}

/** A profile under construction, keyed while the sources are merged. */
type Draft = Omit<PlayerProfile, "key"> & { key: string };

/**
 * Read every roster and per-player record of one server and compose them into
 * one list.
 *
 * Never throws: every source degrades to an absent field. A server that has
 * never booted has no roster files at all and yields an empty roster, which is
 * the honest answer rather than an error.
 *
 * @param server the server view model (its `path` is the directory read).
 * @param options.online the sample from a live list ping, when the server is up.
 *   Names are matched case-insensitively, because the sample is whatever the
 *   server echoed and the rosters are whatever Mojang resolved.
 * @param options.onlineCount the ping's total connected count, used to report
 *   how many players the sample failed to name.
 * @param options.levelName the world directory holding `stats/` and
 *   `playerdata/`; defaults to `"world"`.
 */
export async function readPlayers(
	server: Server,
	options: {
		online?: PlayerSample[];
		onlineCount?: number;
		levelName?: string;
	} = {},
): Promise<PlayerRoster> {
	if (!server.available) {
		return {
			players: [],
			bannedIps: [],
			onlineUnnamed: 0,
			detailsTruncated: false,
		};
	}

	const dir = server.path;
	const worldDir = join(dir, options.levelName ?? "world");
	const statsDir = join(worldDir, "stats");
	const dataDir = join(worldDir, "playerdata");

	const [usercache, ops, whitelist, bans, ipBans, shadowBans, dataFiles] =
		await Promise.all([
			readRoster(join(dir, ROSTER.usercache), UserCacheEntry),
			readRoster(join(dir, ROSTER.ops), OpEntry),
			readRoster(join(dir, ROSTER.whitelist), WhitelistEntry),
			readRoster(join(dir, ROSTER.bannedPlayers), BanEntry),
			readRoster(join(dir, ROSTER.bannedIps), IpBanEntry),
			readShadowBans(dir),
			readDirIfExists(dataDir, ".dat"),
		]);

	// Merge by uuid where there is one and by lower-cased name where there is
	// not: `banned-players.json` may carry only a name (a ban issued against an
	// offline-mode player), and the same player must not appear twice.
	const byKey = new Map<string, Draft>();
	const nameIndex = new Map<string, string>();

	const upsert = (
		name: string | undefined,
		uuid: string | undefined,
	): Draft => {
		const existingKey =
			(uuid && byKey.has(uuid) ? uuid : undefined) ??
			(name ? nameIndex.get(name.toLowerCase()) : undefined);
		if (existingKey) {
			const draft = byKey.get(existingKey) as Draft;
			// A later source may know a uuid the first one lacked; adopt it, but never
			// re-key, so references taken by earlier sources stay valid.
			if (uuid && !draft.uuid) draft.uuid = uuid;
			if (name) {
				draft.name = name;
				nameIndex.set(name.toLowerCase(), existingKey);
			}
			return draft;
		}
		const key = uuid ?? `name:${(name ?? "unknown").toLowerCase()}`;
		const draft: Draft = {
			key,
			name: name ?? uuid ?? "unknown",
			uuid,
			online: false,
			whitelisted: false,
		};
		byKey.set(key, draft);
		if (name) nameIndex.set(name.toLowerCase(), key);
		return draft;
	};

	for (const entry of usercache) upsert(entry.name, entry.uuid);
	for (const entry of ops) {
		upsert(entry.name, entry.uuid).op = {
			level: entry.level,
			bypassesPlayerLimit: entry.bypassesPlayerLimit,
		};
	}
	for (const entry of whitelist)
		upsert(entry.name, entry.uuid).whitelisted = true;
	for (const entry of bans) {
		upsert(entry.name, entry.uuid).ban = {
			created: entry.created,
			source: entry.source,
			expires: entry.expires,
			reason: entry.reason,
		};
	}
	for (const mark of shadowBans) upsert(mark.name, mark.uuid).shadowBan = mark;
	// A `playerdata` file proves a player has actually joined, which the rosters
	// do not — a whitelist may name someone who never showed up.
	for (const file of dataFiles) upsert(undefined, file.replace(/\.dat$/, ""));

	for (const sample of options.online ?? []) {
		const draft = upsert(sample.name, sample.id || undefined);
		draft.online = true;
	}

	// Detail reads are bounded, so they go to the players most worth showing:
	// everyone online first, then the most recently written data files.
	const mtimes = new Map<string, number>();
	await Promise.all(
		dataFiles.map(async (file) => {
			const at = await fileMtime(join(dataDir, file));
			if (at !== undefined) mtimes.set(file.replace(/\.dat$/, ""), at);
		}),
	);

	const drafts = [...byKey.values()];
	const detailOrder = [...drafts]
		.filter((draft) => draft.uuid !== undefined)
		.sort((a, b) => {
			if (a.online !== b.online) return a.online ? -1 : 1;
			return (
				(mtimes.get(b.uuid as string) ?? 0) -
				(mtimes.get(a.uuid as string) ?? 0)
			);
		});
	const detailed = detailOrder.slice(0, MAX_DETAIL_READS);

	await Promise.all(
		detailed.map(async (draft) => {
			const uuid = draft.uuid as string;
			const [stats, data] = await Promise.all([
				readStats(statsDir, uuid),
				readPlayerData(join(dataDir, `${uuid}.dat`)),
			]);
			draft.stats = stats;
			if (data) {
				draft.state = data.state;
				draft.firstSeen = data.firstSeen;
			}
			draft.lastSeen = data?.lastSeen ?? mtimes.get(uuid);
		}),
	);

	// Online first, then most recently seen, then alphabetically — so the list is
	// stable between polls even for players with no timestamp at all.
	const players = drafts.sort((a, b) => {
		if (a.online !== b.online) return a.online ? -1 : 1;
		if ((b.lastSeen ?? 0) !== (a.lastSeen ?? 0)) {
			return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
		}
		return a.name.localeCompare(b.name);
	});

	const named = players.filter((player) => player.online).length;
	return {
		players,
		bannedIps: ipBans.map((entry) => ({
			ip: entry.ip,
			created: entry.created,
			source: entry.source,
			expires: entry.expires,
			reason: entry.reason,
		})),
		onlineUnnamed: Math.max(0, (options.onlineCount ?? named) - named),
		detailsTruncated: detailOrder.length > detailed.length,
	};
}

/**
 * Read MCTL's own shadow-ban markers out of the server's `mctl.json`.
 * Absent or unparseable file ⇒ no marks; this decorates a roster, so it must
 * never be the thing that fails the read.
 */
export async function readShadowBans(dir: string): Promise<ShadowBan[]> {
	try {
		const parsed = MctlJson.safeParse(
			await readJsonIfExists(join(dir, "mctl.json")),
		);
		return parsed.success ? (parsed.data.shadowBans ?? []) : [];
	} catch {
		return [];
	}
}
