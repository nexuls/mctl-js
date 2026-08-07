/**
 * Tests for the `server.properties` reader: the Java `.properties` parser and
 * the coercion of its strings into a view model.
 *
 * Both halves are pure, so this needs no server directory. The cases worth
 * pinning down are the ones a hand-edited or old file produces — numeric
 * gamemodes, `\uXXXX` escapes, `key = value` spacing — because each of them
 * silently yields a *plausible wrong answer* rather than an error.
 */

import { describe, expect, test } from "bun:test";
import { parseProperties, readProperties } from "./properties.ts";

describe("parseProperties", () => {
	test("reads the shape Minecraft actually writes", () => {
		const parsed = parseProperties(
			[
				"#Minecraft server properties",
				"#Sun Aug 03 12:00:00 UTC 2026",
				"server-port=25566",
				"motd=A Minecraft Server",
				"enable-rcon=false",
			].join("\n"),
		);
		expect(parsed).toEqual({
			"server-port": "25566",
			motd: "A Minecraft Server",
			"enable-rcon": "false",
		});
	});

	test("ignores comments and blank lines", () => {
		expect(parseProperties("\n# a\n! b\n\nkey=value\n")).toEqual({
			key: "value",
		});
	});

	test("accepts `:` and bare whitespace as separators, and loose spacing", () => {
		expect(parseProperties("a:1\nb 2\nc = 3")).toEqual({
			a: "1",
			b: "2",
			c: "3",
		});
	});

	test("decodes the escapes Java writes", () => {
		// `§` is the section sign a coloured MOTD is stored with.
		const parsed = parseProperties("motd=A \\u00a76Fancy\\u00a7r Server");
		expect(parsed.motd).toBe("A §6Fancy§r Server");
		expect(parseProperties("a=line\\nbreak").a).toBe("line\nbreak");
	});

	test("joins a backslash-continued line", () => {
		expect(
			parseProperties("resource-pack=http://example\\\n  .com/pack.zip"),
		).toEqual({ "resource-pack": "http://example.com/pack.zip" });
	});

	test("keeps an empty value rather than dropping the key", () => {
		expect(parseProperties("level-seed=\nserver-ip=")).toEqual({
			"level-seed": "",
			"server-ip": "",
		});
	});
});

describe("readProperties", () => {
	test("applies Minecraft's documented defaults to an empty file", () => {
		const properties = readProperties({});
		expect(properties.port).toBe(25565);
		expect(properties.maxPlayers).toBe(20);
		expect(properties.motd).toBe("A Minecraft Server");
		expect(properties.difficulty).toBe("easy");
		expect(properties.gamemode).toBe("survival");
		expect(properties.pvp).toBe(true);
		expect(properties.onlineMode).toBe(true);
		expect(properties.whitelist).toBe(false);
		expect(properties.levelName).toBe("world");
	});

	test("translates the pre-1.13 numeric gamemode and difficulty", () => {
		const properties = readProperties({ gamemode: "1", difficulty: "3" });
		expect(properties.gamemode).toBe("creative");
		expect(properties.difficulty).toBe("hard");
	});

	test("reports hardcore's effective difficulty, not the file's", () => {
		// The server locks a hardcore world to hard whatever the key says, so
		// echoing `peaceful` back at the user would be actively misleading.
		const properties = readProperties({
			hardcore: "true",
			difficulty: "peaceful",
		});
		expect(properties.hardcore).toBe(true);
		expect(properties.difficulty).toBe("hard");
	});

	test("strips legacy colour codes from the displayed MOTD but keeps them raw", () => {
		const properties = readProperties({ motd: "A §6Fancy§r Server" });
		expect(properties.motd).toBe("A Fancy Server");
		expect(properties.raw.motd).toBe("A §6Fancy§r Server");
	});

	test("falls back rather than yielding NaN on a mangled number", () => {
		expect(readProperties({ "server-port": "nonsense" }).port).toBe(25565);
		expect(readProperties({ "max-players": "" }).maxPlayers).toBe(20);
	});

	test("treats anything but `true` as false, as the server does", () => {
		expect(readProperties({ pvp: "yes" }).pvp).toBe(false);
		expect(readProperties({ pvp: "TRUE" }).pvp).toBe(true);
	});
});
