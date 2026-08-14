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

import { createHash } from "node:crypto";
import { rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
	ensureDir,
	pathExists,
	readDirIfExists,
	readTextIfExists,
} from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { contentIconCacheDir } from "../../lib/paths.ts";
import { readZipEntry, readZipText } from "../../lib/zip.ts";
import type { ContentSectionId, ContentSupport } from "../../types/content.ts";
import type { Server } from "../../types/server.ts";
import type { ProviderRegistry } from "../registry/provider-registry.ts";
import {
	JAR_MANIFESTS,
	PACK_MANIFEST,
	parseJarMeta,
	parsePackMcmeta,
	pickIconEntry,
	type ContentLoader,
	type ContentMeta,
} from "./content-meta.ts";

const logger = log("content");

/** Suffix a parked jar carries. Loaders match `*.jar`, so this is simply not seen. */
export const DISABLED_SUFFIX = ".disabled";

// Re-exported so the front-ends keep importing their content vocabulary from
// the service that produces it; the type itself lives in `types/content.ts`,
// where `types/provider.ts` can reach it without importing `core/`.
export type { ContentSectionId, ContentSupport };

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
	/**
	 * Absolute path to this item's icon as a PNG **on disk**, when it has one and
	 * it could be extracted — for an unpacked datapack the pack's own `pack.png`,
	 * for an archive a copy in `~/.cache/mctl/content-icons/`.
	 *
	 * A path rather than the bytes on purpose: it is a stable string across the
	 * polls that rebuild this listing, so a front-end's image does not reload
	 * every time. Absent for anything that ships no icon, and for one too large to
	 * be worth reading — never a reason for the item not to be listed.
	 */
	icon?: string;
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
	/**
	 * Whether this *kind of server* loads this sort of content at all, from the
	 * provider's {@link ServerProvider.content}. Distinct from `present`, which is
	 * only about the directory: a Fabric server with no `mods/` yet is
	 * `supported: true, present: false`, while a Paper server is
	 * `supported: false` however many jars someone drops into a `mods/` folder —
	 * and those jars are still listed, because files that will never load are
	 * worth saying out loud rather than hiding.
	 */
	supported: boolean;
	/** The items, alphabetically by display name — never grouped by state. */
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

/**
 * Largest icon worth extracting, in bytes.
 *
 * Mod logos are routinely a megabyte of 512×512 PNG (Create Aeronautics ships
 * exactly that) and are drawn here into a handful of terminal cells. The cap is
 * generous enough to admit every real logo and mean enough to refuse a texture
 * atlas someone parked at a jar's root; over it the item simply has no icon.
 */
const MAX_ICON_BYTES = 4 * 1024 * 1024;

/**
 * Extract an item's icon into the cache and return its path, or `undefined`.
 *
 * The cache key is the jar's own path, size and mtime, so a *replaced* jar
 * (an update keeping the same filename) re-extracts while an unchanged one is
 * only ever read once however often the listing is rebuilt. That matters: this
 * runs for every jar in `mods/` on a poll, and inflating a megabyte of PNG
 * twice a minute for a picture that has not changed is exactly the cost the
 * cache exists to remove.
 *
 * Never throws — an icon is decoration, and a jar that will not give one up
 * still gets listed.
 */
async function readIcon(
	path: string,
	meta: ContentMeta | undefined,
	sizeBytes: number | undefined,
	modifiedAt: number | undefined,
): Promise<string | undefined> {
	const key = createHash("sha256")
		.update(`${path}\0${sizeBytes ?? 0}\0${modifiedAt ?? 0}`)
		.digest("hex");
	const cached = join(contentIconCacheDir(), `${key}.png`);
	try {
		if (await pathExists(cached)) return cached;
		const found = await readZipEntry(path, (names) => {
			// A declared logo wins, but only if the archive actually holds it: a
			// `logoFile` left over from a template names a file that was never
			// shipped, and the root-PNG convention still finds the real one.
			const declared = meta?.icon;
			if (declared && names.includes(declared)) return declared;
			return pickIconEntry(names);
		});
		if (!found || found.bytes.byteLength > MAX_ICON_BYTES) return undefined;
		await ensureDir(contentIconCacheDir());
		await writeFile(cached, found.bytes);
		return cached;
	} catch (err) {
		logger.debug({ path, err: String(err) }, "no icon extracted");
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

	// An unpacked datapack keeps its `pack.png` beside its `pack.mcmeta`, so it is
	// already a file on disk and needs no extraction or cache entry at all.
	const packPng = join(path, "pack.png");
	const icon = directory
		? (await pathExists(packPng))
			? packPng
			: undefined
		: await readIcon(path, meta, size, modifiedAt);

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
		icon,
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
	supported: boolean,
): Promise<ContentSection> {
	if (!(await pathExists(dir))) {
		return {
			id: section,
			directory: relative,
			present: false,
			toggleable,
			supported,
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

	// By display name, and by nothing else. Grouping the enabled ones first makes
	// a row *move* when it is toggled, so the thing the user just clicked jumps
	// out from under the pointer; a stable alphabetical order keeps it where it
	// is, and the checkbox already says which state it is in.
	items.sort((a, b) => a.name.localeCompare(b.name));
	return {
		id: section,
		directory: relative,
		present: true,
		toggleable,
		supported,
		items,
	};
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
 * Every section is read whether or not the kind supports it, and carries
 * {@link ContentSection.supported} saying which it is — a jar sitting in a Paper
 * server's `mods/` is a real file that will never load, and a listing that
 * silently omitted it would leave the user with no way to find out.
 *
 * @param server the server view model.
 * @param levelName the active world directory, from `server.properties`;
 *   datapacks live inside it and `world` is Minecraft's own default.
 * @param providers the registry, to resolve the kind's content support. Omit it
 *   — as the tests and any caller without one do — and every section is reported
 *   as supported, which is also what an *unknown* kind gets: a build that has
 *   never heard of this server cannot claim it loads nothing.
 */
export async function readServerContent(
	server: Server,
	levelName = "world",
	providers?: ProviderRegistry,
): Promise<ServerContentListing> {
	if (!server.available) return { id: server.id, sections: [] };
	const support = contentSupport(server.kind, providers);
	const sections = await Promise.all([
		readSection("mods", join(server.path, "mods"), "mods/", true, support.mods),
		readSection(
			"plugins",
			join(server.path, "plugins"),
			"plugins/",
			true,
			support.plugins,
		),
		readSection(
			"datapacks",
			join(server.path, levelName, "datapacks"),
			`${levelName}/datapacks/`,
			// See the module note: enablement lives in the world, not the filename.
			false,
			support.datapacks,
		),
	]);
	return { id: server.id, sections };
}

/** What a build that cannot resolve the kind assumes: show everything. */
const ALL_SUPPORTED: ContentSupport = {
	mods: true,
	plugins: true,
	datapacks: true,
};

/**
 * What the given kind loads, from its provider.
 *
 * Exported because both front-ends need the same answer *before* there is a
 * listing — the create form and `mctl content` alike — and because resolving it
 * in one place is what stops "does Paper take mods?" from being answered twice.
 *
 * Never throws: an unregistered kind (a `mctl.json` written by a newer MCTL, the
 * same forward-compatibility rule `kind` and the network profile follow) reports
 * everything as supported rather than declaring the server takes nothing.
 */
export function contentSupport(
	kind: string,
	providers?: ProviderRegistry,
): ContentSupport {
	if (!providers) return ALL_SUPPORTED;
	try {
		return providers.server(kind).content;
	} catch {
		return ALL_SUPPORTED;
	}
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
