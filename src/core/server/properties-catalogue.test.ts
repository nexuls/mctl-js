/**
 * Tests for the `server.properties` field catalogue.
 *
 * Three things are worth pinning down: the catalogue is internally consistent
 * (no duplicate keys, every field on a real screen), the unknown-key path is
 * what makes "every field is editable" true rather than aspirational, and the
 * one piece of rewriting the editor does — legacy numeric enums — does not
 * touch anything else.
 */

import { describe, expect, test } from "bun:test";
import {
	PROPERTY_FIELDS,
	PROPERTY_GROUPS,
	normalizeProperty,
	propertyField,
	propertyFieldsFor,
	validateProperty,
} from "./properties-catalogue.ts";

describe("the catalogue", () => {
	test("has no duplicate keys", () => {
		const keys = PROPERTY_FIELDS.map((field) => field.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("puts every field on a declared screen, and none on Other", () => {
		const groups = new Set(PROPERTY_GROUPS.map((group) => group.id));
		for (const field of PROPERTY_FIELDS) {
			expect(groups.has(field.group)).toBe(true);
			// "Other" is built at runtime from the file; a catalogued key landing
			// there would be a key MCTL knows about but describes as unknown.
			expect(field.group).not.toBe("other");
		}
	});

	test("covers the keys `properties.ts` reads back", () => {
		for (const key of [
			"motd",
			"server-port",
			"server-ip",
			"max-players",
			"difficulty",
			"gamemode",
			"hardcore",
			"pvp",
			"online-mode",
			"white-list",
			"view-distance",
			"simulation-distance",
			"level-name",
			"level-type",
			"level-seed",
			"spawn-protection",
			"allow-flight",
			"allow-nether",
			"enable-command-block",
			"enable-rcon",
			"rcon.port",
			"enable-query",
		]) {
			expect(propertyField(key)).toBeDefined();
		}
	});

	test("marks the RCON password, and nothing else, as a secret", () => {
		const secrets = PROPERTY_FIELDS.filter((field) => field.secret).map(
			(field) => field.key,
		);
		expect(secrets).toEqual(["rcon.password"]);
	});
});

describe("propertyFieldsFor", () => {
	test("offers a text field for a key the catalogue does not know", () => {
		const fields = propertyFieldsFor({ "some-mod:tick-rate": "3" });
		const extra = fields.find((field) => field.key === "some-mod:tick-rate");
		expect(extra?.group).toBe("other");
		expect(extra?.kind.type).toBe("string");
	});

	test("does not duplicate a key it already knows", () => {
		const fields = propertyFieldsFor({ pvp: "false" });
		expect(fields.filter((field) => field.key === "pvp")).toHaveLength(1);
	});

	test("is the whole catalogue for a server that has never booted", () => {
		expect(propertyFieldsFor({})).toHaveLength(PROPERTY_FIELDS.length);
	});
});

describe("normalizeProperty", () => {
	test("renders a pre-1.13 numeric gamemode as its modern name", () => {
		const gamemode = propertyField("gamemode");
		if (!gamemode) throw new Error("gamemode is catalogued");
		expect(normalizeProperty(gamemode, "0")).toBe("survival");
		expect(normalizeProperty(gamemode, "1")).toBe("creative");
	});

	test("passes an unrecognised enum value through rather than guessing", () => {
		const difficulty = propertyField("difficulty");
		if (!difficulty) throw new Error("difficulty is catalogued");
		expect(normalizeProperty(difficulty, "brutal")).toBe("brutal");
	});

	test("leaves a string byte for byte, spacing and colour codes included", () => {
		const motd = propertyField("motd");
		if (!motd) throw new Error("motd is catalogued");
		expect(normalizeProperty(motd, "  §6Hi  ")).toBe("  §6Hi  ");
	});
});

describe("validateProperty", () => {
	const port = propertyField("server-port");
	if (!port) throw new Error("server-port is catalogued");

	test("rejects a non-integer and an out-of-range port", () => {
		expect(validateProperty(port, "abc")).toBeDefined();
		expect(validateProperty(port, "0")).toBeDefined();
		expect(validateProperty(port, "70000")).toBeDefined();
		expect(validateProperty(port, "25565")).toBeUndefined();
	});

	test("accepts a negative integer where the range allows one", () => {
		const watchdog = propertyField("max-tick-time");
		if (!watchdog) throw new Error("max-tick-time is catalogued");
		expect(validateProperty(watchdog, "-1")).toBeUndefined();
	});

	test("lets any string through — a mod's syntax is not MCTL's business", () => {
		const generator = propertyField("level-type");
		if (!generator) throw new Error("level-type is catalogued");
		expect(validateProperty(generator, "terralith:overworld")).toBeUndefined();
	});
});
