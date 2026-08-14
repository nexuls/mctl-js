/**
 * Server content — what has actually been *added* to a server: the mods,
 * plugins and datapacks on disk, each read out of its own manifest, plus the one
 * mutation MCTL offers over them (enable / disable).
 *
 * Core service (AGENTS.md § 3): no UI, no argv, no provider imports. The
 * read half is the fourth of the read paths beside `discover.ts` (what servers
 * exist), `inspect.ts` (what they are doing) and `players.ts` (who is on them),
 * and follows the same rules — re-derived from disk on every call, cached
 * nowhere, so a jar dropped into `mods/` by hand appears without MCTL being told
 * (architecture.md § Statelessness). `inspect.ts` still *counts* these
 * directories for the dashboard; this module is the expensive tier that opens
 * every archive, so the two are deliberately separate calls.
 *
 * **Disabling is a rename, and that is the ecosystem's own convention.** Every
 * loader in use loads `mods/*.jar` and ignores anything else, so a mod is parked
 * by renaming it to `*.jar.disabled` — which is what every launcher, and CurseForge
 * itself, does. MCTL does the same, and it is worth being explicit that this is a
 * deliberate, narrow exception to "MCTL writes only `mctl.json` into a server
 * directory" (AGENTS.md § Secrets and user data): it renames a file the user
 * installed, never deletes or rewrites one, never touches a world, and refuses if
 * the target name is already taken so nothing can be clobbered. Any addition here
 * must keep that shape.
 *
 * **Datapacks are listed but not toggled.** Which datapacks are on is recorded
 * by the *world* (`level.dat`'s `DataPacks` tags) and changed with the in-game
 * `/datapack` command; renaming the folder underneath it would leave the world
 * naming a pack that no longer exists. Said out loud in the UI rather than
 * offered as a switch that quietly corrupts a world's state.
 */

import { rename, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathExists, readDirIfExists, readTextIfExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { readZipText } from "../../lib/zip.ts";
import type { Server } from "../../types/server.ts";
import {
	JAR_MANIFESTS,
	PACK_MANIFEST,
	parseJarMeta,
	parsePackMcmeta,
	type ContentLoader,
	type ContentMeta,
} from "./content-meta.ts";

const logger = log("content");

/** Suffix a parked jar carries. Loaders match `*.jar`, so this is simply not seen. */
export const DISABLED_SUFFIX = ".disabled";

/** Which list a piece of content belongs to. */
export type ContentSectionId = "mods" | "plugins" | "datapacks";

/** One installed mod, plugin or datapack. */
export interface ContentItem {
	/**
	 * Stable key for this item: section plus the *enabled* filename. Deliberately
	 * unchanged by enabling or disabling it, so a UI selection survives a toggle.
	 */
	key: string;
	/** Which list it is in. */
	section: ContentSectionId;
	/** The file as it is on disk right now, including `.disabled` when parked. */
	file: string;
	/** Absolute path to that file or directory. */
	path: string;
	/** Display name: from the manifest when it has one, else derived from the filename. */
	name: string;
	/**
	 * True when nothing described this item at all, so a UI can say the metadata
	 * is missing. **Not** simply "the name was derived": a `pack.mcmeta` carries a
	 * description and no name, so a datapack is legitimately named by its file
	 * while its manifest was read perfectly well.
	 */
	derivedName: boolean;
	/** Declared version, when the manifest carries one. */
	version?: string;
	/** Declared description, whitespace collapsed. */
	description?: string;
	/** Declared authors, in manifest order. */
	authors?: string[];
	/** Which manifest described it. */
	loader?: ContentLoader;
	/** Minecraft/API version the manifest declares, when it does. */
	minecraftVersion?: string;
	/** File size in bytes, or the directory entry's own size for an unpacked pack. */
	sizeBytes?: number;
	/** Last modification time, epoch ms — in practice, when it was installed. */
	modifiedAt?: number;
	/** False when the file is parked as `*.jar.disabled`. */
	enabled: boolean;
	/** True for an unpacked datapack (a directory rather than an archive). */
	directory: boolean;
}

/** One list on the Content tab. */
export interface ContentSection {
	id: ContentSectionId;
	/** Directory this section reads, relative to the server (for the UI to name). */
	directory: string;
	/**
	 * False when that directory does not exist at all — which is not the same as
	 * an empty one. A Paper server has no `mods/`, and showing it "0 mods" would
	 * imply mods are a thing it could have.
	 */
	present: boolean;
	/** Whether MCTL offers the enable/disable switch here (see the module note). */
	toggleable: boolean;
	/** The items, enabled first, then alphabetically by display name. */
	items: ContentItem[];
}

/** Everything installed on one server. */
export interface ServerContentListing {
	/** The server this describes. */
	id: string;
	/** Mods, plugins and datapacks, in that order. */
	sections: ContentSection[];
}

/** Thrown by {@link setContentEnabled} when the rename must not be attempted. */
export class ContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContentError";
	}
}

/**
 * `sodium-fabric-0.6.0+mc1.21.4.jar` → `sodium-fabric 0.6.0+mc1.21.4`. Only used
 * when the archive carries no manifest MCTL understands: the filename is the one
 * thing every jar has, and showing it raw with its extension reads as a directory
 * listing rather than a list of mods.
 */
export function nameFromFile(file: string): string {
	return file
		.replace(new RegExp(`${DISABLED_SUFFIX}$`), "")
		.replace(/\.(jar|zip)$/i, "")
		.replace(/[_]+/g, " ")
		.trim();
}

/** The filename with any `.disabled` suffix removed — the item's stable identity. */
function enabledName(file: string): string {
	return file.endsWith(DISABLED_SUFFIX)
		? file.slice(0, -DISABLED_SUFFIX.length)
		: file;
}

/** Read a jar's manifests, or `undefined` for anything unreadable as a zip. */
async function readJarMeta(path: string): Promise<ContentMeta | undefined> {
	try {
		return parseJarMeta(await readZipText(path, JAR_MANIFESTS));
	} catch (err) {
		// A truncated download, a zip64 archive, a jar being written as we read it:
		// all mean "no metadata", never "fail the listing".
		logger.debug({ path, err: String(err) }, "unreadable jar manifest");
		return undefined;
	}
}

/** Read a datapack's `pack.mcmeta`, whether it is zipped or an unpacked folder. */
async function readPackMeta(
	path: string,
	directory: boolean,
): Promise<ContentMeta | undefined> {
	try {
		const text = directory
			? await readTextIfExists(join(path, PACK_MANIFEST))
			: (await readZipText(path, [PACK_MANIFEST])).get(PACK_MANIFEST);
		return text === undefined ? undefined : parsePackMcmeta(text);
	} catch (err) {
		logger.debug({ path, err: String(err) }, "unreadable pack.mcmeta");
		return undefined;
	}
}

/** Build one item from a directory entry, reading whatever describes it. */
async function readItem(
	section: ContentSectionId,
	dir: string,
	file: string,
): Promise<ContentItem | undefined> {
	const path = join(dir, file);
	let size: number | undefined;
	let modifiedAt: number | undefined;
	let directory = false;
	try {
		const info = await stat(path);
		directory = info.isDirectory();
		size = directory ? undefined : info.size;
		modifiedAt = info.mtimeMs;
	} catch {
		// Vanished between the listing and the stat: leave it out entirely.
		return undefined;
	}

	const meta =
		section === "datapacks"
			? await readPackMeta(path, directory)
			: directory
				? undefined
				: await readJarMeta(path);

	const name = meta?.name ?? meta?.id;
	return {
		key: `${section}:${enabledName(file)}`,
		section,
		file,
		path,
		name: name ?? nameFromFile(file),
		derivedName: meta === undefined,
		version: meta?.version,
		description: meta?.description,
		authors: meta?.authors,
		loader: meta?.loader,
		minecraftVersion: meta?.minecraftVersion,
		sizeBytes: size,
		modifiedAt,
		enabled: !file.endsWith(DISABLED_SUFFIX),
		directory,
	};
}

/**
 * Whether a directory entry is content of this kind.
 *
 * Jars only, enabled or parked. Everything else a `mods/` directory accumulates
 * — a loader's own `.connector` folder, a `README`, the `.index` CurseForge
 * leaves behind — is not a mod and is not listed.
 */
function isCandidate(section: ContentSectionId, file: string): boolean {
	if (file.startsWith(".")) return false;
	if (section === "datapacks") return true;
	const base = enabledName(file);
	return base.toLowerCase().endsWith(".jar");
}

/** Read one section's directory. `present: false` when it does not exist. */
async function readSection(
	section: ContentSectionId,
	dir: string,
	relative: string,
	toggleable: boolean,
): Promise<ContentSection> {
	if (!(await pathExists(dir))) {
		return {
			id: section,
			directory: relative,
			present: false,
			toggleable,
			items: [],
		};
	}
	const files = (await readDirIfExists(dir)).filter((file) =>
		isCandidate(section, file),
	);
	// Archives are opened concurrently: the cost is I/O latency, and a `mods/`
	// directory of a hundred jars read one after another is a visible stall.
	const items = (
		await Promise.all(files.map((file) => readItem(section, dir, file)))
	).filter((item): item is ContentItem => item !== undefined);

	// Enabled first, then by display name: a parked mod is still installed, but it
	// is not what the list is about, and interleaving the two hides how many of
	// each there are.
	items.sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return { id: section, directory: relative, present: true, toggleable, items };
}

/**
 * List everything installed on a server: `mods/`, `plugins/`, and the active
 * world's `datapacks/`.
 *
 * **Expensive** relative to {@link "./inspect".inspectServer}, which only counts
 * these directories: this one opens every archive to read its manifest. Poll it
 * on a slow cadence, or on demand.
 *
 * Never throws. An unreadable directory or archive degrades to an absent
 * section or a filename-only item, because this renders a page.
 *
 * @param server the server view model.
 * @param levelName the active world directory, from `server.properties`;
 *   datapacks live inside it and `world` is Minecraft's own default.
 */
export async function readServerContent(
	server: Server,
	levelName = "world",
): Promise<ServerContentListing> {
	if (!server.available) return { id: server.id, sections: [] };
	const sections = await Promise.all([
		readSection("mods", join(server.path, "mods"), "mods/", true),
		readSection("plugins", join(server.path, "plugins"), "plugins/", true),
		readSection(
			"datapacks",
			join(server.path, levelName, "datapacks"),
			`${levelName}/datapacks/`,
			// See the module note: enablement lives in the world, not the filename.
			false,
		),
	]);
	return { id: server.id, sections };
}

/**
 * Enable or disable one installed item by renaming it to or from
 * `<file>.disabled`.
 *
 * The **only** write MCTL performs inside a server directory besides
 * `mctl.json` and the create-time `eula.txt`, and deliberately the narrowest one
 * that can express the operation: a rename never destroys the file, and the
 * user's own mod is exactly where they left it under a name every launcher
 * recognises.
 *
 * Refuses rather than risking data:
 *  - a target name that already exists (a rename would replace it),
 *  - a path that is not inside the server directory,
 *  - a section MCTL does not toggle (datapacks — see the module note).
 *
 * Takes effect at the server's **next start**: loaders read `mods/` once during
 * boot, so toggling a mod on a running server changes nothing until it restarts.
 * Callers should say so rather than implying the change is live.
 *
 * @returns the item's new filename on disk.
 * @throws {@link ContentError} for any of the refusals above; filesystem errors
 *   (permissions, a read-only mount) propagate as they are.
 */
export async function setContentEnabled(
	server: Server,
	item: ContentItem,
	enabled: boolean,
): Promise<string> {
	if (item.section === "datapacks") {
		throw new ContentError(
			"Datapacks are enabled by the world, not by their filename — use the /datapack command.",
		);
	}
	// The item comes from our own listing, but this is the one call that writes
	// into a user's server directory: verify rather than assume.
	const root = resolve(server.path);
	const current = resolve(item.path);
	if (current !== root && !current.startsWith(root + sep)) {
		throw new ContentError(`${item.file} is not inside ${server.path}`);
	}
	if (item.enabled === enabled) return item.file;

	const base = enabledName(item.file);
	const next = enabled ? base : `${base}${DISABLED_SUFFIX}`;
	const target = join(server.path, item.section, next);
	if (await pathExists(target)) {
		throw new ContentError(
			`${next} already exists — rename or remove it first, so nothing is overwritten.`,
		);
	}
	await rename(current, target);
	logger.info(
		{ id: server.id, file: item.file, next, enabled },
		"content toggled",
	);
	return next;
}
