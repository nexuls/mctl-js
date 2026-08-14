/**
 * Content metadata — the manifests mods, plugins and datapacks describe
 * themselves with, reduced to one shape.
 *
 * Core service (AGENTS.md § 3): pure text-in, data-out. No filesystem, no UI, no
 * provider imports — {@link "./content"} does the reading and hands the bytes
 * here. Every function is total: a manifest that cannot be understood yields
 * `undefined` rather than throwing, because this decorates a listing and a
 * malformed jar must degrade to its filename, not blank the tab.
 *
 * **Six formats, because the ecosystem has six.** A jar names itself in whatever
 * its loader reads, and MCTL cannot ask the loader — the server is usually not
 * even running. So each manifest is recognised on its own terms:
 *
 * | File | Written by | Format |
 * |---|---|---|
 * | `fabric.mod.json` | Fabric | JSON — https://fabricmc.net/wiki/documentation:fabric_mod_json |
 * | `quilt.mod.json` | Quilt | JSON, nested under `quilt_loader` |
 * | `META-INF/neoforge.mods.toml` | NeoForge ≥ 20.5 | TOML |
 * | `META-INF/mods.toml` | Forge ≥ 1.13, NeoForge < 20.5 | TOML |
 * | `mcmod.info` | Forge ≤ 1.12 | JSON array |
 * | `plugin.yml` / `paper-plugin.yml` | Bukkit / Spigot / Paper | YAML |
 * | `pack.mcmeta` | datapacks and resource packs | JSON |
 *
 * **On parsing TOML and YAML here.** MCTL's own files are JSON only (plan.md
 * § 3) and that rule is untouched — nothing below ever *writes* either format.
 * These are foreign files owned by someone else's build system, and the readers
 * are deliberately narrow: they extract the handful of top-level keys a listing
 * shows and understand nothing else. They are not general parsers and must not
 * be reused as if they were.
 */

/** Which ecosystem a piece of content belongs to, as declared by its manifest. */
export type ContentLoader =
	| "fabric"
	| "quilt"
	| "forge"
	| "neoforge"
	| "bukkit"
	| "pack";

/** What a manifest says about itself, reduced to what a listing shows. */
export interface ContentMeta {
	/** The loader whose manifest this came from. */
	loader: ContentLoader;
	/** Mod/plugin id, when the manifest declares one. */
	id?: string;
	/** Human-readable name; absent when the manifest only carries an id. */
	name?: string;
	/** Declared version. */
	version?: string;
	/** One-line (or longer) description, whitespace collapsed by the caller. */
	description?: string;
	/** Declared authors/contributors, in manifest order. */
	authors?: string[];
	/** Minecraft or API version the manifest declares, when it does. */
	minecraftVersion?: string;
}

/** Entry names {@link parseJarMeta} asks a jar for, most specific first. */
export const JAR_MANIFESTS = [
	"fabric.mod.json",
	"quilt.mod.json",
	"META-INF/neoforge.mods.toml",
	"META-INF/mods.toml",
	"mcmod.info",
	"paper-plugin.yml",
	"plugin.yml",
	"META-INF/MANIFEST.MF",
] as const;

/** Entry name a zipped datapack or resource pack describes itself in. */
export const PACK_MANIFEST = "pack.mcmeta";

/** Collapse whitespace and trim — manifest descriptions are frequently multi-line. */
function oneLine(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed === "" ? undefined : collapsed;
}

/** Keep only non-empty strings, so a manifest's empty author entry is dropped. */
function stringList(value: unknown): string[] | undefined {
	const items = Array.isArray(value)
		? value
		: value === undefined
			? []
			: [value];
	const names = items
		.map((item) => {
			if (typeof item === "string") return item.trim();
			// Fabric allows `{"name": "…", "contact": {…}}` in place of a bare string.
			if (item && typeof item === "object" && "name" in item) {
				const name = (item as { name?: unknown }).name;
				return typeof name === "string" ? name.trim() : "";
			}
			return "";
		})
		.filter((name) => name.length > 0);
	return names.length > 0 ? names : undefined;
}

/** Parse JSON, or `undefined` when the text is not JSON at all. */
function json(text: string): Record<string, unknown> | unknown[] | undefined {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Read a string property, ignoring anything that is not one. */
function str(source: unknown, key: string): string | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: undefined;
}

/** `fabric.mod.json` — Fabric's manifest, and the most common one by far. */
export function parseFabricMod(text: string): ContentMeta | undefined {
	const data = json(text);
	if (!data || Array.isArray(data)) return undefined;
	if (str(data, "id") === undefined && str(data, "name") === undefined) {
		return undefined;
	}
	return {
		loader: "fabric",
		id: str(data, "id"),
		name: str(data, "name"),
		version: str(data, "version"),
		description: oneLine(str(data, "description")),
		authors: stringList(data.authors),
		// `depends.minecraft` is a version *range* (`">=1.21.4"`), which is what the
		// mod actually promises — a single version would be a stronger claim than
		// the manifest makes.
		minecraftVersion: str(
			(data.depends as Record<string, unknown>) ?? {},
			"minecraft",
		),
	};
}

/** `quilt.mod.json` — the same information one level down, under `quilt_loader`. */
export function parseQuiltMod(text: string): ContentMeta | undefined {
	const data = json(text);
	if (!data || Array.isArray(data)) return undefined;
	const loader = data.quilt_loader;
	if (!loader || typeof loader !== "object") return undefined;
	const metadata = (loader as Record<string, unknown>).metadata;
	// Quilt writes contributors as `{"Name": "Role"}`, so the *keys* are the people.
	const contributors =
		metadata && typeof metadata === "object"
			? Object.keys(
					((metadata as Record<string, unknown>).contributors as
						| Record<string, unknown>
						| undefined) ?? {},
				)
			: [];
	return {
		loader: "quilt",
		id: str(loader, "id"),
		name: str(metadata, "name"),
		version: str(loader, "version"),
		description: oneLine(str(metadata, "description")),
		authors: contributors.length > 0 ? contributors : undefined,
	};
}

/** Strip TOML quoting from a single-line value, resolving the escapes that occur. */
function unquote(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'") && value.endsWith(first)) {
			const body = value.slice(1, -1);
			// Literal (single-quoted) strings take no escapes at all in TOML.
			return first === "'"
				? body
				: body.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
	}
	return value;
}

/**
 * The first `[[mods]]` table of a Forge/NeoForge `mods.toml`.
 *
 * A **narrow** reader, not a TOML parser: it walks lines, tracks the current
 * table header, and takes `key = value` pairs out of the first `[[mods]]` block
 * only — a jar that ships several mods is described by the first, which is the
 * one the file is named for. Multi-line strings (`'''…'''`) are supported
 * because Forge's own template uses one for `description`.
 */
export function parseModsToml(
	text: string,
	loader: "forge" | "neoforge",
): ContentMeta | undefined {
	const lines = text.split(/\r?\n/);
	const fields = new Map<string, string>();
	let inMods = false;
	let index = 0;

	while (index < lines.length) {
		const line = (lines[index] ?? "").trim();
		index += 1;
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			// A new table header after the first `[[mods]]` ends the block we want.
			if (inMods) break;
			inMods = line.replace(/\s+/g, "") === "[[mods]]";
			continue;
		}
		if (!inMods) continue;

		const equals = line.indexOf("=");
		if (equals < 0) continue;
		const key = line.slice(0, equals).trim();
		let raw = line.slice(equals + 1).trim();

		const fence = raw.startsWith("'''")
			? "'''"
			: raw.startsWith('"""')
				? '"""'
				: undefined;
		if (fence) {
			let body = raw.slice(3);
			const closes = body.includes(fence);
			if (closes) {
				body = body.slice(0, body.indexOf(fence));
			} else {
				const collected = [body];
				while (index < lines.length) {
					const next = lines[index] ?? "";
					index += 1;
					const end = next.indexOf(fence);
					if (end >= 0) {
						collected.push(next.slice(0, end));
						break;
					}
					collected.push(next);
				}
				body = collected.join("\n");
			}
			raw = body;
		} else {
			// Trailing comment on a value line, e.g. `version="1.0" # bumped`.
			const comment = raw.indexOf(" #");
			if (comment >= 0 && !raw.startsWith('"') && !raw.startsWith("'")) {
				raw = raw.slice(0, comment);
			}
			raw = unquote(raw);
		}
		fields.set(key, raw.trim());
	}

	const id = fields.get("modId");
	const name = fields.get("displayName");
	if (!id && !name) return undefined;
	return {
		loader,
		id,
		name,
		version: fields.get("version"),
		description: oneLine(fields.get("description")),
		authors: stringList(
			fields
				.get("authors")
				?.split(",")
				.map((author) => author.trim()),
		),
	};
}

/** `mcmod.info` — the Forge 1.12-and-earlier manifest, a JSON array of mods. */
export function parseMcmodInfo(text: string): ContentMeta | undefined {
	const data = json(text);
	// Some 1.7 mods wrap the array in `{"modList": [...]}`.
	const list = Array.isArray(data)
		? data
		: Array.isArray((data as Record<string, unknown>)?.modList)
			? ((data as Record<string, unknown>).modList as unknown[])
			: undefined;
	const first = list?.[0];
	if (!first || typeof first !== "object") return undefined;
	if (str(first, "modid") === undefined && str(first, "name") === undefined) {
		return undefined;
	}
	return {
		loader: "forge",
		id: str(first, "modid"),
		name: str(first, "name"),
		version: str(first, "version"),
		description: oneLine(str(first, "description")),
		authors: stringList(
			(first as Record<string, unknown>).authorList ??
				(first as Record<string, unknown>).authors,
		),
		minecraftVersion: str(first, "mcversion"),
	};
}

/**
 * `plugin.yml` / `paper-plugin.yml` — the Bukkit family's manifest.
 *
 * A **narrow** reader, not a YAML parser: only unindented `key: value` pairs are
 * taken, plus the indented `- item` lines that follow an empty `authors:`. That
 * is the whole of what a plugin manifest's top level looks like in practice, and
 * anything nested (`commands:`, `permissions:`) is deliberately skipped.
 */
export function parsePluginYml(text: string): ContentMeta | undefined {
	const lines = text.split(/\r?\n/);
	const fields = new Map<string, string>();
	const authors: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		index += 1;
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		// Indentation means we are inside a block that is not the top level.
		if (/^\s/.test(line)) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();

		if ((key === "authors" || key === "author") && value === "") {
			// A block list: consume the indented `- Name` lines that follow.
			while (index < lines.length) {
				const item = lines[index] ?? "";
				const match = /^\s+-\s*(.+?)\s*$/.exec(item);
				if (!match) break;
				index += 1;
				authors.push(unquote(match[1] ?? ""));
			}
			continue;
		}
		fields.set(key, value);
	}

	const inline = fields.get("authors") ?? fields.get("author");
	if (inline) {
		for (const author of inline.replace(/^\[|\]$/g, "").split(",")) {
			const name = unquote(author);
			if (name !== "") authors.push(name);
		}
	}

	const name = fields.get("name");
	if (!name) return undefined;
	return {
		loader: "bukkit",
		id: unquote(name),
		name: unquote(name),
		version: fields.get("version")
			? unquote(fields.get("version") ?? "")
			: undefined,
		description: oneLine(
			fields.get("description")
				? unquote(fields.get("description") ?? "")
				: undefined,
		),
		authors: authors.length > 0 ? authors : undefined,
		minecraftVersion: fields.get("api-version")
			? unquote(fields.get("api-version") ?? "")
			: undefined,
	};
}

/**
 * `pack.mcmeta` — how a datapack or resource pack describes itself.
 *
 * `description` is either a plain string or a raw JSON **text component**
 * (`{"text": "…"}`, or an array of them), because Minecraft renders it in-game
 * with formatting; both shapes are flattened to their text here.
 */
export function parsePackMcmeta(text: string): ContentMeta | undefined {
	const data = json(text);
	if (!data || Array.isArray(data)) return undefined;
	const pack = data.pack;
	if (!pack || typeof pack !== "object") return undefined;
	const format = (pack as Record<string, unknown>).pack_format;
	return {
		loader: "pack",
		description: oneLine(
			componentText((pack as Record<string, unknown>).description),
		),
		// The pack format is a schema number, not a Minecraft version, and is shown
		// as such — mapping one to the other is a table that rots every release.
		version: typeof format === "number" ? `format ${format}` : undefined,
	};
}

/** Flatten a Minecraft raw text component (or a plain string) to its text. */
function componentText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((part) => componentText(part) ?? "").join("");
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const own = typeof record.text === "string" ? record.text : "";
		const extra = Array.isArray(record.extra)
			? (componentText(record.extra) ?? "")
			: "";
		const joined = own + extra;
		return joined === "" ? undefined : joined;
	}
	return undefined;
}

/**
 * `Implementation-Version` out of a jar's `META-INF/MANIFEST.MF`.
 *
 * Forge's `mods.toml` conventionally declares `version="${file.jarVersion}"`,
 * which the loader substitutes from the manifest at runtime. Left unresolved,
 * every Forge mod in the list would show that literal placeholder as its
 * version.
 */
export function manifestVersion(text: string): string | undefined {
	const match = /^Implementation-Version:[ \t]*(.+)$/m.exec(text);
	const version = match?.[1]?.trim();
	return version === "" ? undefined : version;
}

/**
 * Choose the metadata for a jar from whichever manifests it turned out to carry,
 * and resolve Forge's `${file.jarVersion}` placeholder against its manifest.
 *
 * Order matters: a Fabric mod bundling a `plugin.yml` for a companion plugin is
 * a Fabric mod, and a NeoForge jar carries both `neoforge.mods.toml` and (for
 * older loaders) `mods.toml`, of which the first is authoritative.
 *
 * @param entries manifest name → its text, as returned by `readZipText`.
 */
export function parseJarMeta(
	entries: ReadonlyMap<string, string>,
): ContentMeta | undefined {
	const read = (
		name: string,
		parse: (text: string) => ContentMeta | undefined,
	) => {
		const text = entries.get(name);
		return text === undefined ? undefined : parse(text);
	};

	const meta =
		read("fabric.mod.json", parseFabricMod) ??
		read("quilt.mod.json", parseQuiltMod) ??
		read("META-INF/neoforge.mods.toml", (text) =>
			parseModsToml(text, "neoforge"),
		) ??
		read("META-INF/mods.toml", (text) => parseModsToml(text, "forge")) ??
		read("mcmod.info", parseMcmodInfo) ??
		read("paper-plugin.yml", parsePluginYml) ??
		read("plugin.yml", parsePluginYml);
	if (!meta) return undefined;

	if (meta.version?.includes("${")) {
		const manifest = entries.get("META-INF/MANIFEST.MF");
		meta.version = manifest ? manifestVersion(manifest) : undefined;
	}
	return meta;
}
