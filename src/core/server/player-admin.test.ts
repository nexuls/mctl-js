/**
 * Tests for the player command builder.
 *
 * These are moderation commands: a wrong argument order bans the wrong account
 * or teleports the wrong player, and neither is discoverable by looking at the
 * TUI. So every command's exact wording is pinned here, `gamemode`'s reversed
 * argument order most of all.
 */

import { describe, expect, test } from "bun:test";
import {
	PLAYER_ACTIONS,
	commandFor,
	playerAction,
	type PlayerActionId,
} from "./player-admin.ts";
import type { PlayerProfile } from "./players.ts";

const player = (patch: Partial<PlayerProfile> = {}): PlayerProfile => ({
	key: "u",
	name: "Notch",
	uuid: "u",
	online: true,
	whitelisted: false,
	...patch,
});

describe("commandFor", () => {
	test("builds the moderation commands, with and without a reason", () => {
		expect(commandFor("kick", "Notch")).toBe("kick Notch");
		expect(commandFor("kick", "Notch", "afk")).toBe("kick Notch afk");
		expect(commandFor("ban", "Notch", "griefing spawn")).toBe(
			"ban Notch griefing spawn",
		);
		expect(commandFor("pardon", "Notch")).toBe("pardon Notch");
	});

	test("whitelist takes a sub-command, not a flag", () => {
		expect(commandFor("whitelistAdd", "Notch")).toBe("whitelist add Notch");
		expect(commandFor("whitelistRemove", "Notch")).toBe(
			"whitelist remove Notch",
		);
	});

	test("gamemode puts the mode BEFORE the player", () => {
		// The one command whose argument order is reversed relative to every other
		// one here. Getting it backwards silently targets a player named "creative".
		expect(commandFor("gamemode", "Notch", "creative")).toBe(
			"gamemode creative Notch",
		);
	});

	test("teleport passes the destination through untouched", () => {
		expect(commandFor("teleport", "Notch", "Herobrine")).toBe(
			"tp Notch Herobrine",
		);
		// Coordinates and relative forms must survive verbatim, so `~ ~10 ~` works
		// exactly as it does in-game.
		expect(commandFor("teleport", "Notch", "~ ~10 ~")).toBe("tp Notch ~ ~10 ~");
	});

	test("feed and heal are status effects, since Minecraft has no such commands", () => {
		expect(commandFor("feed", "Notch")).toBe(
			"effect give Notch minecraft:saturation 1 20 true",
		);
		expect(commandFor("heal", "Notch")).toBe(
			"effect give Notch minecraft:instant_health 1 4 true",
		);
	});

	test("shadow bans have no server-side command", () => {
		expect(commandFor("shadowBan", "Notch")).toBeUndefined();
		expect(commandFor("shadowPardon", "Notch")).toBeUndefined();
	});

	test("no command is ever emitted with a leading slash", () => {
		for (const action of PLAYER_ACTIONS) {
			const command = commandFor(action.id, "Notch", "x");
			expect(command?.startsWith("/") ?? false).toBe(false);
		}
	});

	test("every catalogue entry is buildable and resolvable by id", () => {
		for (const action of PLAYER_ACTIONS) {
			expect(playerAction(action.id).label).toBe(action.label);
			// A console-backed action must produce a command; only the two MCTL-side
			// marks may return undefined.
			const command = commandFor(action.id, "Notch", "arg");
			expect(command === undefined).toBe(!action.needsRunning);
		}
	});

	test("an unknown action id is an error, not a silent no-op", () => {
		expect(() => playerAction("nope" as PlayerActionId)).toThrow();
	});
});

describe("PLAYER_ACTIONS.applies", () => {
	test("offers ban to an unbanned player and pardon to a banned one", () => {
		const banned = player({ ban: { reason: "griefing" } });
		expect(playerAction("ban").applies?.(player())).toBe(true);
		expect(playerAction("ban").applies?.(banned)).toBe(false);
		expect(playerAction("pardon").applies?.(banned)).toBe(true);
		expect(playerAction("pardon").applies?.(player())).toBe(false);
	});

	test("in-world actions are offered only for online players", () => {
		const offline = player({ online: false });
		for (const id of ["kick", "kill", "feed", "heal", "teleport"] as const) {
			expect(playerAction(id).applies?.(player())).toBe(true);
			expect(playerAction(id).applies?.(offline)).toBe(false);
		}
	});

	test("shadow ban is the only pair that works on a stopped server", () => {
		const offlineOnly = PLAYER_ACTIONS.filter((a) => !a.needsRunning).map(
			(a) => a.id,
		);
		expect(offlineOnly).toEqual(["shadowBan", "shadowPardon"]);
	});
});
