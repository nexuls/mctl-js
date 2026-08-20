/**
 * Tests for the `server.properties` writer.
 *
 * The whole value of this module is what it *does not* touch, so most of these
 * assert preservation rather than output: comments, blank lines, ordering, keys
 * MCTL has never heard of, and the file's own line endings. A serializer that
 * rewrote the file wholesale would pass a naive "the value changed" test and
 * still lose a user's hand-written comments.
 *
 * `applyPropertyEdits` is pure, so none of this needs a server directory; the
 * round-trip cases parse the result back with the real reader, which is the
 * property that actually matters.
 */

import { describe, expect, test } from "bun:test";
import { applyPropertyEdits, escapeProperty } from "./properties-write.ts";
import { parseProperties } from "./properties.ts";

const VANILLA = [
	"#Minecraft server properties",
	"#Sun Aug 03 12:00:00 UTC 2026",
	"enable-jmx-monitoring=false",
	"rcon.port=25575",
	"level-seed=",
	"gamemode=survival",
	"# a comment the user wrote",
	"motd=A Minecraft Server",
	"",
	"some-mod-setting=42",
].join("\n");

describe("escapeProperty", () => {
	test("escapes the separators Java escapes, in values as well as keys", () => {
		expect(escapeProperty("minecraft:normal")).toBe("minecraft\\:normal");
		expect(escapeProperty("a=b")).toBe("a\\=b");
		expect(escapeProperty("#1")).toBe("\\#1");
	});

	test("escapes non-ASCII as \\uXXXX, the way a coloured MOTD is stored", () => {
		expect(escapeProperty("§6Gold")).toBe("\\u00a76Gold");
	});

	test("escapes a leading space in a value but not an interior one", () => {
		expect(escapeProperty(" hi there")).toBe("\\ hi there");
	});

	test("escapes every space in a key, since a space is a legal separator", () => {
		expect(escapeProperty("odd key", true)).toBe("odd\\ key");
	});

	test("round-trips through the reader", () => {
		const motd = "A §6Fancy§r Server: 100% done";
		const text = `motd=${escapeProperty(motd)}\n`;
		expect(parseProperties(text).motd).toBe(motd);
	});
});

describe("applyPropertyEdits", () => {
	test("rewrites only the lines whose key changed", () => {
		const out = applyPropertyEdits(VANILLA, { gamemode: "creative" });
		expect(out.split("\n")).toEqual([
			"#Minecraft server properties",
			"#Sun Aug 03 12:00:00 UTC 2026",
			"enable-jmx-monitoring=false",
			"rcon.port=25575",
			"level-seed=",
			"gamemode=creative",
			"# a comment the user wrote",
			"motd=A Minecraft Server",
			"",
			"some-mod-setting=42",
			"",
		]);
	});

	test("leaves the file untouched when nothing changed", () => {
		expect(applyPropertyEdits(VANILLA, {})).toBe(VANILLA);
	});

	test("appends a key the file did not carry, in the order given", () => {
		const out = applyPropertyEdits(VANILLA, {
			"view-distance": "16",
			"simulation-distance": "8",
		});
		expect(out.endsWith("view-distance=16\nsimulation-distance=8\n")).toBe(
			true,
		);
		// And the original body is still all there, ahead of it.
		expect(out.startsWith(VANILLA.replace(/\n$/, ""))).toBe(true);
	});

	test("edits a mod's own key as readily as one it knows", () => {
		const out = applyPropertyEdits(VANILLA, { "some-mod-setting": "7" });
		expect(parseProperties(out)["some-mod-setting"]).toBe("7");
	});

	test("creates a file with Minecraft's header when there was none", () => {
		const out = applyPropertyEdits("", { "server-port": "25570" });
		const lines = out.split("\n");
		expect(lines[0]).toBe("#Minecraft server properties");
		expect(lines[1]?.startsWith("#")).toBe(true);
		expect(lines[2]).toBe("server-port=25570");
		expect(parseProperties(out)["server-port"]).toBe("25570");
	});

	test("keeps CRLF line endings rather than mixing the two", () => {
		const crlf = "#header\r\nmotd=old\r\n";
		const out = applyPropertyEdits(crlf, { motd: "new" });
		expect(out).toBe("#header\r\nmotd=new\r\n");
	});

	test("replaces every occurrence of a duplicated key", () => {
		// The reader resolves duplicates as last-wins; leaving an earlier line at
		// the old value would make the file disagree with itself about a value the
		// user just set.
		const out = applyPropertyEdits("pvp=true\npvp=false\n", { pvp: "true" });
		expect(out).toBe("pvp=true\npvp=true\n");
	});

	test("replaces a backslash-continued entry as one unit", () => {
		const text = "resource-pack=http://example\\\n  .com/pack.zip\nmotd=hi\n";
		const out = applyPropertyEdits(text, { "resource-pack": "" });
		expect(out).toBe("resource-pack=\nmotd=hi\n");
	});

	test("accepts `:` and bare-space separators when locating a key", () => {
		expect(applyPropertyEdits("pvp:true\n", { pvp: "false" })).toBe(
			"pvp=false\n",
		);
		expect(applyPropertyEdits("pvp true\n", { pvp: "false" })).toBe(
			"pvp=false\n",
		);
	});

	test("does not mistake a value containing the key for the key", () => {
		const out = applyPropertyEdits("motd=pvp=on\npvp=true\n", { pvp: "false" });
		expect(out).toBe("motd=pvp=on\npvp=false\n");
	});
});
