/**
 * Tests for the player roster read path, against a real fabricated server
 * directory — real JSON rosters and a real gzipped NBT player-data file, so the
 * merge is exercised end to end rather than against stubs.
 *
 * The merge is the part worth pinning: five sources disagree about who exists
 * and how they are identified (uuid here, bare name there), and a duplicate or a
 * dropped player is invisible in a UI that shows a grid of cards.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Server } from "../../types/server.ts";
import { readPlayers, resolvePlayerDirs } from "./players.ts";

let dir: string;

/** Minimal NBT encoding, matching `lib/nbt.test.ts`'s helpers. */
const str = (value: string): Buffer => {
	const bytes = Buffer.from(value, "utf8");
	const length = Buffer.alloc(2);
	length.writeUInt16BE(bytes.length);
	return Buffer.concat([length, bytes]);
};
const named = (type: number, name: string, payload: Buffer): Buffer =>
	Buffer.concat([Buffer.from([type]), str(name), payload]);
const i32 = (value: number) => {
	const b = Buffer.alloc(4);
	b.writeInt32BE(value);
	return b;
};
const f32 = (value: number) => {
	const b = Buffer.alloc(4);
	b.writeFloatBE(value);
	return b;
};
const f64 = (value: number) => {
	const b = Buffer.alloc(8);
	b.writeDoubleBE(value);
	return b;
};
const playerDataFile = (): Uint8Array =>
	new Uint8Array(
		gzipSync(
			Buffer.concat([
				Buffer.from([10]),
				str(""),
				named(5, "Health", f32(15)),
				named(1, "foodLevel", Buffer.from([13])),
				named(3, "XpLevel", i32(30)),
				named(3, "playerGameType", i32(1)),
				named(8, "Dimension", str("minecraft:the_nether")),
				named(
					9,
					"Pos",
					Buffer.concat([
						Buffer.from([6]),
						i32(3),
						f64(10.4),
						f64(70.9),
						f64(-3.2),
					]),
				),
				Buffer.from([0]),
			]),
		),
	);

const NOTCH = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const JEB = "853c80ef-3c37-49fd-aa49-938b674adae6";

const server = (): Server => ({
	id: "survival",
	name: "Survival",
	kind: "paper",
	minecraftVersion: "1.21.4",
	memory: "2G",
	runtime: "foreground",
	network: "direct",
	path: dir,
	state: "running",
	available: true,
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-players-"));
	await mkdir(join(dir, "world", "stats"), { recursive: true });
	await mkdir(join(dir, "world", "playerdata"), { recursive: true });

	await writeFile(
		join(dir, "usercache.json"),
		JSON.stringify([
			{ name: "Notch", uuid: NOTCH, expiresOn: "2099-01-01 00:00:00 +0000" },
			{ name: "jeb_", uuid: JEB },
		]),
	);
	await writeFile(
		join(dir, "ops.json"),
		JSON.stringify([
			{ uuid: NOTCH, name: "Notch", level: 4, bypassesPlayerLimit: true },
		]),
	);
	await writeFile(
		join(dir, "whitelist.json"),
		JSON.stringify([{ uuid: JEB, name: "jeb_" }]),
	);
	// A ban carrying only a name — what an offline-mode ban looks like, and the
	// case the uuid-keyed merge has to fold in by name instead.
	await writeFile(
		join(dir, "banned-players.json"),
		JSON.stringify([
			{
				name: "Griefer",
				created: "2026-01-02 10:00:00 +0000",
				source: "Server",
				expires: "forever",
				reason: "griefing spawn",
			},
		]),
	);
	await writeFile(
		join(dir, "banned-ips.json"),
		JSON.stringify([{ ip: "10.0.0.9", source: "Server", reason: "bot" }]),
	);
	await writeFile(
		join(dir, "world", "playerdata", `${NOTCH}.dat`),
		playerDataFile(),
	);
	await writeFile(
		join(dir, "world", "stats", `${NOTCH}.json`),
		JSON.stringify({
			stats: {
				"minecraft:custom": {
					"minecraft:play_time": 72_000, // 1 hour of ticks
					"minecraft:deaths": 3,
					"minecraft:player_kills": 2,
					"minecraft:mob_kills": 40,
					"minecraft:damage_dealt": 1234,
					"minecraft:walk_one_cm": 150_000,
					"minecraft:sprint_one_cm": 50_000,
				},
				"minecraft:mined": { "minecraft:stone": 100, "minecraft:dirt": 40 },
			},
		}),
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readPlayers", () => {
	test("merges five sources into one entry per player", async () => {
		const roster = await readPlayers(server(), {
			online: [{ name: "Notch", id: NOTCH }],
			onlineCount: 1,
		});

		expect(roster.players.map((p) => p.name).sort()).toEqual([
			"Griefer",
			"Notch",
			"jeb_",
		]);
		// Online first, whatever order the sources listed them in.
		expect(roster.players[0]?.name).toBe("Notch");

		const notch = roster.players.find((p) => p.name === "Notch");
		expect(notch?.online).toBe(true);
		expect(notch?.op).toEqual({ level: 4, bypassesPlayerLimit: true });
		expect(notch?.whitelisted).toBe(false);

		const jeb = roster.players.find((p) => p.name === "jeb_");
		expect(jeb?.online).toBe(false);
		expect(jeb?.whitelisted).toBe(true);
		expect(jeb?.op).toBeUndefined();
	});

	test("folds a name-only ban in without inventing a second player", async () => {
		// Same player, spelled differently by the two sources: the ban file has no
		// uuid, so only a case-insensitive name match keeps them one row.
		await writeFile(
			join(dir, "usercache.json"),
			JSON.stringify([{ name: "griefer", uuid: JEB }]),
		);
		await writeFile(join(dir, "whitelist.json"), "[]");
		await writeFile(join(dir, "ops.json"), "[]");
		// A `playerdata` file is itself a player, so Notch's has to go too for this
		// to be a one-player fixture.
		await rm(join(dir, "world", "playerdata", `${NOTCH}.dat`));
		const roster = await readPlayers(server());
		expect(roster.players).toHaveLength(1);
		expect(roster.players[0]?.ban?.reason).toBe("griefing spawn");
		expect(roster.players[0]?.uuid).toBe(JEB);
	});

	test("reads health, hunger, game mode and position out of the NBT", async () => {
		const roster = await readPlayers(server());
		const state = roster.players.find((p) => p.name === "Notch")?.state;
		expect(state?.health).toBeCloseTo(15, 3);
		expect(state?.food).toBe(13);
		expect(state?.xpLevel).toBe(30);
		expect(state?.gameMode).toBe("creative");
		expect(state?.dimension).toBe("minecraft:the_nether");
		expect(state?.position).toEqual({ x: 10, y: 71, z: -3 });
	});

	test("rescales the stat counters out of ticks, centimetres and tenths", async () => {
		const roster = await readPlayers(server());
		const stats = roster.players.find((p) => p.name === "Notch")?.stats;
		expect(stats?.playTimeMs).toBe(3_600_000); // 72000 ticks at 20/s
		expect(stats?.deaths).toBe(3);
		expect(stats?.playerKills).toBe(2);
		expect(stats?.damageDealt).toBeCloseTo(123.4, 3);
		// Every "_one_cm" statistic is a mode of travel; their sum is the distance.
		expect(stats?.distanceM).toBe(2000);
		expect(stats?.blocksMined).toBe(140);
	});

	test("reports connected players the ping did not name", async () => {
		const roster = await readPlayers(server(), {
			online: [{ name: "Notch", id: NOTCH }],
			onlineCount: 7,
		});
		expect(roster.onlineUnnamed).toBe(6);
	});

	test("a level name other than 'world' is honoured", async () => {
		await mkdir(join(dir, "big_world", "playerdata"), { recursive: true });
		await writeFile(
			join(dir, "big_world", "playerdata", `${JEB}.dat`),
			playerDataFile(),
		);
		const roster = await readPlayers(server(), { levelName: "big_world" });
		expect(roster.players.find((p) => p.name === "jeb_")?.state?.food).toBe(13);
		// The default world's data must not leak in from the other directory.
		expect(
			roster.players.find((p) => p.name === "Notch")?.state,
		).toBeUndefined();
	});

	// Minecraft 26.1 regrouped the per-player files under `<world>/players/`.
	// Reading only the pre-26.1 paths is what made a modern server's Players tab
	// render every card as "no player data" with a dash for every counter.
	describe("the 26.1+ <world>/players/ layout", () => {
		beforeEach(async () => {
			await mkdir(join(dir, "world", "players", "data"), { recursive: true });
			await mkdir(join(dir, "world", "players", "stats"), { recursive: true });
			await rm(join(dir, "world", "playerdata"), { recursive: true });
			await rm(join(dir, "world", "stats"), { recursive: true });
			await writeFile(
				join(dir, "world", "players", "data", `${NOTCH}.dat`),
				playerDataFile(),
			);
			await writeFile(
				join(dir, "world", "players", "stats", `${NOTCH}.json`),
				JSON.stringify({
					stats: { "minecraft:custom": { "minecraft:deaths": 3 } },
				}),
			);
		});

		test("player data and stats are found under players/", async () => {
			const roster = await readPlayers(server());
			const notch = roster.players.find((p) => p.name === "Notch");
			expect(notch?.state?.food).toBe(13);
			expect(notch?.stats?.deaths).toBe(3);
			// The file itself is proof of a join, so it also carries "last seen".
			expect(notch?.lastSeen).toBeGreaterThan(0);
		});

		test("`.dat_old` siblings are not mistaken for players", async () => {
			// The server writes one beside every save; picking it up would double
			// every card and key the copy by a uuid ending in "_old".
			await writeFile(
				join(dir, "world", "players", "data", `${JEB}.dat_old`),
				playerDataFile(),
			);
			const roster = await readPlayers(server());
			expect(roster.players.map((p) => p.name).sort()).toEqual([
				"Griefer",
				"Notch",
				"jeb_",
			]);
		});
	});

	test("resolvePlayerDirs falls back to the legacy paths when players/ is absent", async () => {
		expect(await resolvePlayerDirs(join(dir, "world"))).toEqual({
			statsDir: join(dir, "world", "stats"),
			dataDir: join(dir, "world", "playerdata"),
		});
		// A world that was never booted has neither layout; the legacy paths are
		// the fallback and simply read as empty.
		expect(await resolvePlayerDirs(join(dir, "nothing-here"))).toEqual({
			statsDir: join(dir, "nothing-here", "stats"),
			dataDir: join(dir, "nothing-here", "playerdata"),
		});
	});

	test("a malformed roster entry costs that entry, not the whole file", async () => {
		await writeFile(
			join(dir, "ops.json"),
			JSON.stringify([{ nope: true }, { uuid: JEB, name: "jeb_", level: 2 }]),
		);
		const roster = await readPlayers(server());
		expect(roster.players.find((p) => p.name === "jeb_")?.op?.level).toBe(2);
		expect(roster.players.find((p) => p.name === "Notch")?.op).toBeUndefined();
	});

	test("survives a server directory with no roster files at all", async () => {
		const bare = await mkdtemp(join(tmpdir(), "mctl-players-bare-"));
		try {
			const roster = await readPlayers({ ...server(), path: bare });
			expect(roster.players).toEqual([]);
			expect(roster.bannedIps).toEqual([]);
		} finally {
			await rm(bare, { recursive: true, force: true });
		}
	});

	test("an unavailable server yields an empty roster rather than throwing", async () => {
		const roster = await readPlayers({ ...server(), available: false });
		expect(roster.players).toEqual([]);
	});

	test("IP bans are listed apart, since they belong to no player", async () => {
		const roster = await readPlayers(server());
		expect(roster.bannedIps).toEqual([
			{
				ip: "10.0.0.9",
				created: undefined,
				source: "Server",
				expires: undefined,
				reason: "bot",
			},
		]);
	});
});
