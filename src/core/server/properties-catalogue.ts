/**
 * The catalogue of `server.properties` keys — what each one is called, what kind
 * of value it takes, what Minecraft's documented default is, and which screen of
 * the editor it belongs on.
 *
 * Pure data plus three pure helpers (AGENTS.md § 3): no I/O, no UI, no provider
 * imports. It exists so the Properties editor can be *generated* rather than
 * hand-written — 64 hand-laid-out fields would drift from the file the moment
 * Mojang added a key, and the editor's promise is that **every** field is
 * editable.
 *
 * This is deliberately a *different* view of the file from `properties.ts`. That
 * module coerces the handful of keys MCTL displays into a view model, applying
 * interpretations of its own (`hardcore` overrides the reported difficulty; the
 * MOTD is stripped of `§` colour codes). An editor must never do that: what it
 * shows has to be what is on disk, character for character, or Save writes back
 * a value the user never typed. So the editor works on the raw string map and
 * this catalogue only says how to *render* and *validate* each string.
 *
 * Keys, defaults and ranges are from https://minecraft.wiki/w/Server.properties
 * (checked against 1.21). Keys that a given server version does not know are
 * harmless: Minecraft ignores properties it does not recognise, and MCTL only
 * writes the ones the user actually changed — see `properties-write.ts`.
 */

/** Which screen of the editor a field belongs on. */
export type PropertyGroup =
	| "general"
	| "world"
	| "gameplay"
	| "players"
	| "network"
	| "performance"
	| "resources"
	| "rcon"
	| "other";

/** How a field's string value is rendered and validated. */
export type PropertyKind =
	| { readonly type: "boolean" }
	| { readonly type: "int"; readonly min?: number; readonly max?: number }
	| { readonly type: "enum"; readonly values: readonly string[] }
	| { readonly type: "string" };

/** One editable key of `server.properties`. */
export interface PropertyField {
	/** The key exactly as it appears on disk — also the field's stable id. */
	key: string;
	/** Human name, used where there is room for one beside the key. */
	label: string;
	/** The screen it belongs on. */
	group: PropertyGroup;
	/** How it is rendered and validated. */
	kind: PropertyKind;
	/** Minecraft's documented default, as it would be written on disk. */
	fallback: string;
	/**
	 * One short line, shown on the field's bottom border. Kept under ~50 cells:
	 * it shares that border with the frame and a longer one is simply cut.
	 */
	hint: string;
	/**
	 * A credential rather than a setting. Masked while the field does not hold
	 * the focus, so the page is safe to read over a shoulder or screenshot
	 * (AGENTS.md § Secrets and user data).
	 */
	secret?: boolean;
}

/** Group headings and their order, left to right in the editor's bar. */
export const PROPERTY_GROUPS: readonly {
	id: PropertyGroup;
	label: string;
	description: string;
}[] = [
	{
		id: "general",
		label: "General",
		description: "The handful of settings most servers actually change.",
	},
	{
		id: "world",
		label: "World",
		description: "Which world is loaded, how it generates, what spawns in it.",
	},
	{
		id: "gameplay",
		label: "Gameplay",
		description: "Rules applied to players once they are in the world.",
	},
	{
		id: "players",
		label: "Players",
		description: "Who may connect, what they may see, and what is logged.",
	},
	{
		id: "network",
		label: "Network",
		description: "How the server speaks to clients and to the outside world.",
	},
	{
		id: "performance",
		label: "Performance",
		description: "What the server spends its tick budget and its disk on.",
	},
	{
		id: "resources",
		label: "Resource packs",
		description: "The pack clients are asked for, and the built-in data packs.",
	},
	{
		id: "rcon",
		label: "RCON & query",
		description: "The two remote-administration listeners.",
	},
	{
		id: "other",
		label: "Other",
		description:
			"Keys found in this file that MCTL does not know — mod-added, or from an older Minecraft. Edited as text.",
	},
] as const;

const BOOL: PropertyKind = { type: "boolean" };
const TEXT: PropertyKind = { type: "string" };

/**
 * Every key MCTL knows, in the order each group's screen lists them.
 *
 * Ordering inside a group is by *how often it is changed*, not alphabetically:
 * the editor lays fields out in a two-column grid in declaration order, so this
 * list is also the reading order and the Tab order.
 */
export const PROPERTY_FIELDS: readonly PropertyField[] = [
	// ── General ───────────────────────────────────────────────────────────────
	{
		key: "motd",
		label: "MOTD",
		group: "general",
		kind: TEXT,
		fallback: "A Minecraft Server",
		hint: "shown in the multiplayer list",
	},
	{
		key: "server-port",
		label: "Port",
		group: "general",
		kind: { type: "int", min: 1, max: 65535 },
		fallback: "25565",
		hint: "TCP port the server binds",
	},
	{
		key: "server-ip",
		label: "Bind address",
		group: "general",
		kind: TEXT,
		fallback: "",
		hint: "empty binds every interface",
	},
	{
		key: "max-players",
		label: "Player slots",
		group: "general",
		kind: { type: "int", min: 0 },
		fallback: "20",
		hint: "how many may be online at once",
	},
	{
		key: "online-mode",
		label: "Online mode",
		group: "general",
		kind: BOOL,
		fallback: "true",
		hint: "off allows unauthenticated players",
	},
	{
		key: "difficulty",
		label: "Difficulty",
		group: "general",
		kind: { type: "enum", values: ["peaceful", "easy", "normal", "hard"] },
		fallback: "easy",
		hint: "hardcore overrides this to hard",
	},
	{
		key: "gamemode",
		label: "Gamemode",
		group: "general",
		kind: {
			type: "enum",
			values: ["survival", "creative", "adventure", "spectator"],
		},
		fallback: "survival",
		hint: "mode a joining player starts in",
	},
	{
		key: "hardcore",
		label: "Hardcore",
		group: "general",
		kind: BOOL,
		fallback: "false",
		hint: "death is permanent; locks difficulty",
	},
	{
		key: "pvp",
		label: "PvP",
		group: "general",
		kind: BOOL,
		fallback: "true",
		hint: "players can damage each other",
	},
	{
		key: "white-list",
		label: "Whitelist",
		group: "general",
		kind: BOOL,
		fallback: "false",
		hint: "only listed players may join",
	},

	// ── World ─────────────────────────────────────────────────────────────────
	{
		key: "level-name",
		label: "World folder",
		group: "world",
		kind: TEXT,
		fallback: "world",
		hint: "directory the world is saved in",
	},
	{
		key: "level-seed",
		label: "Seed",
		group: "world",
		kind: TEXT,
		fallback: "",
		hint: "empty is random; ignored once generated",
	},
	{
		key: "level-type",
		label: "Generator",
		group: "world",
		kind: TEXT,
		fallback: "minecraft:normal",
		hint: "normal, flat, amplified — or a mod's own",
	},
	{
		key: "generator-settings",
		label: "Generator settings",
		group: "world",
		kind: TEXT,
		fallback: "{}",
		hint: "JSON, for flat and single-biome worlds",
	},
	{
		key: "generate-structures",
		label: "Structures",
		group: "world",
		kind: BOOL,
		fallback: "true",
		hint: "villages, temples and the rest generate",
	},
	{
		key: "max-world-size",
		label: "World radius",
		group: "world",
		kind: { type: "int", min: 1, max: 29999984 },
		fallback: "29999984",
		hint: "world border ceiling, in blocks",
	},
	{
		key: "spawn-protection",
		label: "Spawn guard",
		group: "world",
		kind: { type: "int", min: 0 },
		fallback: "16",
		hint: "blocks around spawn only ops may edit",
	},
	{
		key: "allow-nether",
		label: "Nether",
		group: "world",
		kind: BOOL,
		fallback: "true",
		hint: "the Nether is reachable",
	},
	{
		key: "spawn-monsters",
		label: "Monsters",
		group: "world",
		kind: BOOL,
		fallback: "true",
		hint: "hostile mobs spawn",
	},
	{
		// Removed in 1.21.5, where mob spawning follows the difficulty and the
		// game rules instead. Kept: an older server still reads it, and a file
		// that has it must stay editable rather than fall through to "Other".
		key: "spawn-animals",
		label: "Animals",
		group: "world",
		kind: BOOL,
		fallback: "true",
		hint: "passive mobs spawn (pre-1.21.5)",
	},
	{
		key: "spawn-npcs",
		label: "Villagers",
		group: "world",
		kind: BOOL,
		fallback: "true",
		hint: "villagers spawn (pre-1.21.5)",
	},

	// ── Gameplay ──────────────────────────────────────────────────────────────
	{
		key: "force-gamemode",
		label: "Force gamemode",
		group: "gameplay",
		kind: BOOL,
		fallback: "false",
		hint: "reset players to the default on join",
	},
	{
		key: "allow-flight",
		label: "Allow flight",
		group: "gameplay",
		kind: BOOL,
		fallback: "false",
		hint: "flying is not kicked as cheating",
	},
	{
		key: "enable-command-block",
		label: "Command blocks",
		group: "gameplay",
		kind: BOOL,
		fallback: "false",
		hint: "command blocks run",
	},
	{
		key: "player-idle-timeout",
		label: "Idle kick",
		group: "gameplay",
		kind: { type: "int", min: 0 },
		fallback: "0",
		hint: "minutes before an idle player is kicked; 0 off",
	},
	{
		key: "function-permission-level",
		label: "Function permission",
		group: "gameplay",
		kind: { type: "int", min: 1, max: 4 },
		fallback: "2",
		hint: "op level datapack functions run at (1-4)",
	},
	{
		key: "op-permission-level",
		label: "Op level",
		group: "gameplay",
		kind: { type: "int", min: 0, max: 4 },
		fallback: "4",
		hint: "level granted by /op (0-4)",
	},
	{
		key: "max-chained-neighbor-updates",
		label: "Chained updates",
		group: "gameplay",
		kind: { type: "int" },
		fallback: "1000000",
		hint: "cap on cascading block updates; negative = none",
	},
	{
		key: "pause-when-empty-seconds",
		label: "Pause when empty",
		group: "gameplay",
		kind: { type: "int", min: 0 },
		fallback: "60",
		hint: "seconds empty before ticking stops (1.21.2+)",
	},

	// ── Players ───────────────────────────────────────────────────────────────
	{
		key: "enforce-whitelist",
		label: "Enforce whitelist",
		group: "players",
		kind: BOOL,
		fallback: "false",
		hint: "kick players removed from the whitelist",
	},
	{
		key: "enforce-secure-profile",
		label: "Secure profiles",
		group: "players",
		kind: BOOL,
		fallback: "true",
		hint: "require signed chat; off allows unsigned clients",
	},
	{
		key: "hide-online-players",
		label: "Hide player list",
		group: "players",
		kind: BOOL,
		fallback: "false",
		hint: "omit names from the server list ping",
	},
	{
		key: "broadcast-console-to-ops",
		label: "Echo console to ops",
		group: "players",
		kind: BOOL,
		fallback: "true",
		hint: "ops see commands run at the console",
	},
	{
		key: "log-ips",
		label: "Log IP addresses",
		group: "players",
		kind: BOOL,
		fallback: "true",
		hint: "write player IPs to the server log",
	},
	{
		key: "text-filtering-config",
		label: "Text filter",
		group: "players",
		kind: TEXT,
		fallback: "",
		hint: "chat-filter service config; empty is off",
	},
	{
		key: "text-filtering-version",
		label: "Text filter version",
		group: "players",
		kind: { type: "int", min: 0 },
		fallback: "0",
		hint: "filter protocol version (1.20.5+)",
	},
	{
		key: "accepts-transfers",
		label: "Accept transfers",
		group: "players",
		kind: BOOL,
		fallback: "false",
		hint: "allow players sent by /transfer (1.20.5+)",
	},

	// ── Network ───────────────────────────────────────────────────────────────
	{
		key: "network-compression-threshold",
		label: "Compression threshold",
		group: "network",
		kind: { type: "int", min: -1 },
		fallback: "256",
		hint: "bytes before packets compress; -1 disables",
	},
	{
		key: "prevent-proxy-connections",
		label: "Block proxies",
		group: "network",
		kind: BOOL,
		fallback: "false",
		hint: "refuse players whose IP fails Mojang's check",
	},
	{
		key: "rate-limit",
		label: "Rate limit",
		group: "network",
		kind: { type: "int", min: 0 },
		fallback: "0",
		hint: "packets/sec before a kick; 0 is unlimited",
	},
	{
		key: "use-native-transport",
		label: "Native transport",
		group: "network",
		kind: BOOL,
		fallback: "true",
		hint: "Linux epoll fast path; leave on",
	},
	{
		key: "enable-status",
		label: "Answer status pings",
		group: "network",
		kind: BOOL,
		fallback: "true",
		hint: "off hides the server from the list entirely",
	},
	{
		key: "bug-report-link",
		label: "Bug report link",
		group: "network",
		kind: TEXT,
		fallback: "",
		hint: "URL clients offer for reporting bugs (1.21+)",
	},

	// ── Performance ───────────────────────────────────────────────────────────
	{
		key: "view-distance",
		label: "View distance",
		group: "performance",
		kind: { type: "int", min: 2, max: 32 },
		fallback: "10",
		hint: "chunks sent to clients (2-32)",
	},
	{
		key: "simulation-distance",
		label: "Simulation distance",
		group: "performance",
		kind: { type: "int", min: 3, max: 32 },
		fallback: "10",
		hint: "chunks that tick — the costly one (3-32)",
	},
	{
		key: "entity-broadcast-range-percentage",
		label: "Entity range",
		group: "performance",
		kind: { type: "int", min: 10, max: 1000 },
		fallback: "100",
		hint: "% of normal distance entities are sent (10-1000)",
	},
	{
		key: "max-tick-time",
		label: "Watchdog",
		group: "performance",
		kind: { type: "int", min: -1 },
		fallback: "60000",
		hint: "ms a tick may hang before a crash; -1 off",
	},
	{
		key: "sync-chunk-writes",
		label: "Sync chunk writes",
		group: "performance",
		kind: BOOL,
		fallback: "true",
		hint: "off is faster but risks corruption on a crash",
	},
	{
		key: "region-file-compression",
		label: "Region compression",
		group: "performance",
		kind: { type: "enum", values: ["deflate", "lz4", "none"] },
		fallback: "deflate",
		hint: "how region files are packed (1.20.5+)",
	},
	{
		key: "status-heartbeat-interval",
		label: "Status heartbeat",
		group: "performance",
		kind: { type: "int", min: 0 },
		fallback: "0",
		hint: "seconds between status pushes; 0 off (1.21.2+)",
	},
	{
		key: "enable-jmx-monitoring",
		label: "JMX monitoring",
		group: "performance",
		kind: BOOL,
		fallback: "false",
		hint: "expose tick metrics over JMX",
	},

	// ── Resource packs ────────────────────────────────────────────────────────
	{
		key: "resource-pack",
		label: "Resource pack URL",
		group: "resources",
		kind: TEXT,
		fallback: "",
		hint: "URL clients download on join",
	},
	{
		key: "resource-pack-sha1",
		label: "Pack SHA-1",
		group: "resources",
		kind: TEXT,
		fallback: "",
		hint: "hex digest; without it clients re-download",
	},
	{
		key: "resource-pack-id",
		label: "Pack UUID",
		group: "resources",
		kind: TEXT,
		fallback: "",
		hint: "UUID identifying the pack (1.20.3+)",
	},
	{
		key: "resource-pack-prompt",
		label: "Pack prompt",
		group: "resources",
		kind: TEXT,
		fallback: "",
		hint: "JSON text shown when asking to accept",
	},
	{
		key: "require-resource-pack",
		label: "Require pack",
		group: "resources",
		kind: BOOL,
		fallback: "false",
		hint: "decline disconnects the player",
	},
	{
		key: "initial-enabled-packs",
		label: "Enabled data packs",
		group: "resources",
		kind: TEXT,
		fallback: "vanilla",
		hint: "comma-separated; applied at world creation",
	},
	{
		key: "initial-disabled-packs",
		label: "Disabled data packs",
		group: "resources",
		kind: TEXT,
		fallback: "",
		hint: "comma-separated; applied at world creation",
	},

	// ── RCON & query ──────────────────────────────────────────────────────────
	{
		key: "enable-rcon",
		label: "RCON",
		group: "rcon",
		kind: BOOL,
		fallback: "false",
		hint: "remote console listener",
	},
	{
		key: "rcon.port",
		label: "RCON port",
		group: "rcon",
		kind: { type: "int", min: 1, max: 65535 },
		fallback: "25575",
		hint: "only listens while RCON is on",
	},
	{
		key: "rcon.password",
		label: "RCON password",
		group: "rcon",
		kind: TEXT,
		fallback: "",
		hint: "required for RCON; masked until focused",
		secret: true,
	},
	{
		key: "broadcast-rcon-to-ops",
		label: "Echo RCON to ops",
		group: "rcon",
		kind: BOOL,
		fallback: "true",
		hint: "ops see commands run over RCON",
	},
	{
		key: "enable-query",
		label: "Query",
		group: "rcon",
		kind: BOOL,
		fallback: "false",
		hint: "GameSpy4 stats listener",
	},
	{
		key: "query.port",
		label: "Query port",
		group: "rcon",
		kind: { type: "int", min: 1, max: 65535 },
		fallback: "25565",
		hint: "UDP; only listens while Query is on",
	},
] as const;

/** Look a catalogued key up. `undefined` for anything not in the list above. */
export function propertyField(key: string): PropertyField | undefined {
	return PROPERTY_FIELDS.find((field) => field.key === key);
}

/**
 * Pre-1.13 numeric spellings, still accepted by the server and still written by
 * some old launchers. A file saying `gamemode=0` has to render as *Survival* in
 * a dropdown, or the control falls back to its first option and Save silently
 * rewrites the value the user never touched.
 */
const NUMERIC_ENUMS: Record<string, readonly string[]> = {
	gamemode: ["survival", "creative", "adventure", "spectator"],
	difficulty: ["peaceful", "easy", "normal", "hard"],
};

/**
 * Normalise one raw value into what the field's control can bind to.
 *
 * The only rewriting done anywhere in the editor, and deliberately narrow: a
 * legacy numeric enum becomes its modern name, and a boolean is lower-cased.
 * Everything else is passed through byte for byte — an editor that tidied its
 * input would report itself dirty the moment it loaded a hand-written file.
 */
export function normalizeProperty(field: PropertyField, raw: string): string {
	if (field.kind.type === "boolean") return raw.trim().toLowerCase();
	if (field.kind.type === "enum") {
		const trimmed = raw.trim();
		const numeric = NUMERIC_ENUMS[field.key]?.[Number(trimmed)];
		return numeric ?? trimmed;
	}
	return raw;
}

/**
 * A key present on disk that the catalogue does not know: a mod's own setting, a
 * property from a Minecraft older or newer than this catalogue, or a typo. It is
 * offered as a plain text field rather than hidden, because the promise of the
 * editor is that nothing in the file is unreachable.
 */
export function unknownField(key: string): PropertyField {
	return {
		key,
		label: key,
		group: "other",
		kind: TEXT,
		fallback: "",
		hint: "not a key MCTL knows — edited as text",
	};
}

/**
 * The full field list for one server: the catalogue, plus a text field for every
 * key found on disk that it does not cover.
 *
 * @param raw the parsed `server.properties` map, or `{}` when the file does not
 *   exist yet (a server that has never booted) — the catalogue alone is still a
 *   usable editor there, since Minecraft merges whatever it finds at startup.
 */
export function propertyFieldsFor(
	raw: Readonly<Record<string, string>>,
): PropertyField[] {
	const known = new Set(PROPERTY_FIELDS.map((field) => field.key));
	const extra = Object.keys(raw)
		.filter((key) => !known.has(key))
		.sort()
		.map(unknownField);
	return [...PROPERTY_FIELDS, ...extra];
}

/**
 * Validate one field's edited value, so Save can be refused before the write is
 * attempted.
 *
 * @returns a short message naming what is wrong, or `undefined` when the value
 *   is acceptable. Deliberately permissive for strings: Minecraft accepts almost
 *   anything there, and a text field that rejects a mod's syntax is worse than
 *   one that lets it through.
 */
export function validateProperty(
	field: PropertyField,
	value: string,
): string | undefined {
	if (field.kind.type === "int") {
		const { min, max } = field.kind;
		if (!/^-?\d+$/.test(value.trim())) return "a whole number";
		const parsed = Number.parseInt(value.trim(), 10);
		if (min !== undefined && parsed < min) return `at least ${min}`;
		if (max !== undefined && parsed > max) return `at most ${max}`;
	}
	if (field.kind.type === "boolean" && !["true", "false"].includes(value)) {
		return "true or false";
	}
	return undefined;
}
