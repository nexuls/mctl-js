/**
 * `server.properties` — Minecraft's own configuration for a server directory,
 * read (never written) so MCTL can show what the server is actually configured
 * to do: its port, MOTD, difficulty, gamemode, player cap, and the rest.
 *
 * Core service — no UI, no provider imports. **This module reads and never
 * writes.** Editing the file is a separate, deliberate module
 * (`properties-write.ts`), because the two need opposite dispositions: the
 * reader coerces and interprets, the writer must preserve. Re-read from disk on
 * every call, so a value the user edited in another terminal — or in MCTL's own
 * Properties editor — shows up without MCTL knowing anything happened
 * (architecture.md § Statelessness).
 *
 * The format is Java's `.properties`, not JSON — which is why the parsing lives
 * here by hand rather than behind Zod. Zod still guards the *interpretation*
 * step: every field is coerced with an explicit fallback to Minecraft's
 * documented default, so a hand-mangled file yields a plausible view model
 * rather than `undefined` scattered through the UI.
 * Defaults per https://minecraft.wiki/w/Server.properties
 */

import { join } from "node:path";
import { readTextIfExists } from "../../lib/fs.ts";

/** Filename of Minecraft's own config inside a server directory. */
export const SERVER_PROPERTIES_FILE = "server.properties";

/** The subset of `server.properties` MCTL surfaces, already coerced and defaulted. */
export interface ServerProperties {
	/** Message of the day shown in the multiplayer list. */
	motd: string;
	/** TCP port the server binds. */
	port: number;
	/** Bound interface; empty string means "all interfaces". */
	bindIp: string;
	/** Player slots. */
	maxPlayers: number;
	/** `peaceful` | `easy` | `normal` | `hard`. */
	difficulty: string;
	/** Default gamemode for joining players. */
	gamemode: string;
	/** Hardcore mode: death is permanent and the difficulty is locked to hard. */
	hardcore: boolean;
	/** Player-versus-player combat allowed. */
	pvp: boolean;
	/** Mojang authentication required (false = cracked/offline server). */
	onlineMode: boolean;
	/** The whitelist is enforced. */
	whitelist: boolean;
	/** Chunks sent to clients. */
	viewDistance: number;
	/** Chunks that actually tick (entities, crops) — often below `viewDistance`. */
	simulationDistance: number;
	/** World folder name inside the server directory. */
	levelName: string;
	/** World generator type (`minecraft:normal`, `flat`, …). */
	levelType: string;
	/** Explicit world seed, or empty when random. */
	levelSeed: string;
	/** Radius, in blocks, non-ops cannot build within around spawn. */
	spawnProtection: number;
	/** Flight is not kicked as cheating. */
	allowFlight: boolean;
	/** The Nether is reachable. */
	allowNether: boolean;
	/** Command blocks are enabled. */
	commandBlocks: boolean;
	/** RCON is listening (what a future `mctl rcon` would connect to). */
	rconEnabled: boolean;
	/** RCON port, meaningful only when {@link rconEnabled}. */
	rconPort: number;
	/** The GameSpy4 query listener is enabled. */
	queryEnabled: boolean;
	/** Every key exactly as it appears on disk, for anything not modelled above. */
	raw: Readonly<Record<string, string>>;
}

/**
 * Numeric gamemode values used by `server.properties` before 1.13, still
 * accepted by the server today. A file written by an old launcher says `0`.
 */
const NUMERIC_GAMEMODES = ["survival", "creative", "adventure", "spectator"];

/**
 * Numeric difficulty values, likewise pre-1.13.
 */
const NUMERIC_DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];

/**
 * Decode the escape sequences Java's `Properties.store` writes: `\uXXXX` for
 * anything non-Latin-1 (a MOTD with emoji or CJK arrives this way), plus the
 * usual `\n`/`\t`/`\r` and a backslash-escaped separator.
 *
 * Exported for `properties-write.ts`, which has to recover a key from a line it
 * is about to rewrite — the inverse of the escaping it applies.
 */
export function unescapeValue(value: string): string {
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = value[++i];
		if (next === undefined) break;
		switch (next) {
			case "n":
				out += "\n";
				break;
			case "t":
				out += "\t";
				break;
			case "r":
				out += "\r";
				break;
			case "u": {
				const hex = value.slice(i + 1, i + 5);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 4;
				} else {
					out += next;
				}
				break;
			}
			default:
				// `\=`, `\:`, `\\`, `\ ` and anything else: the escaped character itself.
				out += next;
		}
	}
	return out;
}

/**
 * Index of the first *unescaped* key/value separator in a trimmed entry line, or
 * `-1` for a line that is a bare key.
 *
 * Minecraft always writes `=`, but the format allows `:` and bare whitespace and
 * the file is routinely hand-edited, so all four are accepted. Exported because
 * `properties-write.ts` has to find the same boundary to know which key a line
 * it is about to replace belongs to — two different answers there would mean the
 * writer rewriting a line the reader attributes to another key.
 */
export function separatorIndex(trimmed: string): number {
	for (let j = 0; j < trimmed.length; j += 1) {
		const ch = trimmed[j];
		if (ch === "\\") {
			j += 1;
			continue;
		}
		if (ch === "=" || ch === ":" || ch === " " || ch === "\t") return j;
	}
	return -1;
}

/**
 * Parse a Java `.properties` document into a flat record. Handles `#`/`!`
 * comments, `=`/`:`/whitespace as the key-value separator, backslash line
 * continuation, and the escape sequences above.
 *
 * Exported for testing — it is the only part of this module with edge cases
 * worth pinning down, and it is pure.
 */
export function parseProperties(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	const lines = text.split(/\r\n|\r|\n/);

	for (let i = 0; i < lines.length; i += 1) {
		let line = lines[i] ?? "";
		// A line ending in an *odd* number of backslashes continues onto the next.
		while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
			line = line.slice(0, -1) + (lines[++i] ?? "").replace(/^\s+/, "");
		}
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
			continue;
		}

		const separator = separatorIndex(trimmed);

		if (separator === -1) {
			out[unescapeValue(trimmed)] = "";
			continue;
		}
		const key = unescapeValue(trimmed.slice(0, separator)).trim();
		// Skip the separator plus any surrounding whitespace, and tolerate the
		// `key = value` spacing a hand edit produces.
		const value = trimmed
			.slice(separator + 1)
			.replace(/^[ \t]*[=:]?[ \t]*/, "");
		if (key !== "") out[key] = unescapeValue(value);
	}

	return out;
}

/** Read a boolean property, falling back to `fallback` for anything unparseable. */
function bool(
	raw: Record<string, string>,
	key: string,
	fallback: boolean,
): boolean {
	const value = raw[key];
	if (value === undefined) return fallback;
	return value.trim().toLowerCase() === "true";
}

/** Read an integer property, falling back to `fallback`. */
function int(
	raw: Record<string, string>,
	key: string,
	fallback: number,
): number {
	const value = Number.parseInt(raw[key] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

/** Read a string property, falling back to `fallback` when absent (not when empty). */
function str(
	raw: Record<string, string>,
	key: string,
	fallback: string,
): string {
	return raw[key] ?? fallback;
}

/**
 * Interpret a parsed property record as {@link ServerProperties}, applying
 * Minecraft's documented defaults for anything missing. Pure; exported so the
 * mapping can be tested without a server directory.
 */
export function readProperties(raw: Record<string, string>): ServerProperties {
	const gamemodeRaw = str(raw, "gamemode", "survival").trim();
	const difficultyRaw = str(raw, "difficulty", "easy").trim();
	const hardcore = bool(raw, "hardcore", false);
	return {
		// `§` plus one character is Minecraft's legacy colour/format escape. It is
		// meaningless outside a Minecraft client and renders as mojibake in a
		// terminal, so it is stripped for display; `raw.motd` keeps the original.
		motd: str(raw, "motd", "A Minecraft Server").replace(/§./g, ""),
		port: int(raw, "server-port", 25565),
		bindIp: str(raw, "server-ip", "").trim(),
		maxPlayers: int(raw, "max-players", 20),
		// Hardcore locks the *effective* difficulty to hard regardless of the key,
		// so reporting the file's value there would be actively misleading.
		difficulty: hardcore
			? "hard"
			: (NUMERIC_DIFFICULTIES[Number(difficultyRaw)] ?? difficultyRaw),
		gamemode: NUMERIC_GAMEMODES[Number(gamemodeRaw)] ?? gamemodeRaw,
		hardcore,
		pvp: bool(raw, "pvp", true),
		onlineMode: bool(raw, "online-mode", true),
		whitelist: bool(raw, "white-list", false),
		viewDistance: int(raw, "view-distance", 10),
		simulationDistance: int(raw, "simulation-distance", 10),
		levelName: str(raw, "level-name", "world"),
		levelType: str(raw, "level-type", "minecraft:normal"),
		levelSeed: str(raw, "level-seed", "").trim(),
		spawnProtection: int(raw, "spawn-protection", 16),
		allowFlight: bool(raw, "allow-flight", false),
		allowNether: bool(raw, "allow-nether", true),
		commandBlocks: bool(raw, "enable-command-block", false),
		rconEnabled: bool(raw, "enable-rcon", false),
		rconPort: int(raw, "rcon.port", 25575),
		queryEnabled: bool(raw, "enable-query", false),
		raw,
	};
}

/**
 * Load and interpret `<dir>/server.properties`, or `undefined` when the file is
 * not there — which is the normal state of a freshly created server that has
 * never booted, since Minecraft writes the file on its first run.
 */
export async function loadServerProperties(
	dir: string,
): Promise<ServerProperties | undefined> {
	const text = await readTextIfExists(join(dir, SERVER_PROPERTIES_FILE));
	if (text === undefined) return undefined;
	return readProperties(parseProperties(text));
}
