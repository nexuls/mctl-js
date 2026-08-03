/**
 * Filesystem leaf helpers: atomic writes, JSON read/write, directory creation.
 *
 * UI-free, provider-free, server-free — pure helpers over `node:fs`. Knows
 * nothing about servers, configs, or the shape of any JSON it moves; callers
 * validate contents with Zod at their own boundary.
 *
 * The **atomic write** (temp file + `rename`) is load-bearing: multiple `mctl`
 * instances write the same shared files (`config.json`, `servers.json`), and a
 * partial write must never be observed. `rename(2)` within one filesystem is
 * atomic, so a reader sees either the old file or the whole new file, never a
 * torn one. See artifacts/architecture.md § Statelessness ("all shared-file
 * writes are atomic").
 */

import {
	mkdir,
	rename,
	writeFile,
	readFile,
	readdir,
	chmod,
	appendFile,
	access,
	statfs,
	stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";

/** True if `path` exists and is accessible, false otherwise. Never throws. */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Create `path` (and parents) if absent. No-op when it already exists. */
export async function ensureDir(path: string, mode?: number): Promise<void> {
	await mkdir(path, { recursive: true, mode });
}

/**
 * Read a UTF-8 file, or return `undefined` when it does not exist. Any other
 * error (permission, is-a-directory) propagates — absence is expected, failure
 * is not.
 */
export async function readTextIfExists(
	path: string,
): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * Parse a JSON file into `unknown`, or `undefined` when the file is absent.
 * Returns raw parsed data — the caller is responsible for Zod validation.
 * Throws `SyntaxError` on malformed JSON (a corrupt file is a real error).
 */
export async function readJsonIfExists(path: string): Promise<unknown> {
	const text = await readTextIfExists(path);
	if (text === undefined) return undefined;
	return JSON.parse(text);
}

/**
 * List the names of entries directly inside `dir`, optionally filtered to a file
 * extension (e.g. `".json"`). Returns `[]` when the directory does not exist —
 * an absent optional directory (like `themes/`) is a normal, expected state, not
 * an error. Any other failure (permission) propagates.
 *
 * Names only, not full paths; the caller joins against `dir` as needed.
 */
export async function readDirIfExists(
	dir: string,
	ext?: string,
): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return ext ? names.filter((n) => n.endsWith(ext)) : names;
}

/** Free and total capacity of a filesystem, in bytes. */
export interface DiskUsage {
	/** Bytes available to an unprivileged process. */
	free: number;
	/** Total size of the filesystem. */
	total: number;
}

/**
 * Report the free/total bytes of the filesystem holding `path`. Because the
 * target (e.g. a not-yet-created data root) may not exist, this walks up to the
 * nearest existing ancestor before calling `statfs` — the free space of the
 * filesystem the path *will* live on is what the caller wants to show. Returns
 * `undefined` if no ancestor is stat-able (never throws), so a UI can degrade to
 * "unknown" rather than crash.
 */
export async function diskFree(path: string): Promise<DiskUsage | undefined> {
	let probe = path;
	while (!(await pathExists(probe))) {
		const parent = dirname(probe);
		if (parent === probe) break; // reached the filesystem root
		probe = parent;
	}
	try {
		// `bavail` is blocks available to non-root; `blocks` is the total. Both are
		// in units of `bsize` bytes.
		const s = await statfs(probe);
		return { free: s.bsize * s.bavail, total: s.bsize * s.blocks };
	} catch {
		return undefined;
	}
}

/** The result of walking a directory tree to add up what it holds. */
export interface DirSize {
	/** Total bytes of every regular file found. */
	bytes: number;
	/** Number of regular files counted. */
	files: number;
	/**
	 * True when the walk stopped early at `maxEntries`, so `bytes` is a lower
	 * bound. Callers should render it as "at least" rather than as a measurement.
	 */
	truncated: boolean;
}

/** Options for {@link dirSize}. */
export interface DirSizeOptions {
	/**
	 * Stop after visiting this many entries and report `truncated`. A guard
	 * against a pathological tree (a world with a million region files) turning a
	 * cosmetic size readout into a multi-second stall.
	 */
	maxEntries?: number;
	/** Subdirectory names to skip entirely, matched on the basename. */
	exclude?: ReadonlySet<string>;
}

/**
 * Recursively total the size of every regular file under `dir`. Returns zeroes
 * when the directory is absent, and never throws — an unreadable subtree is
 * skipped, because this exists to decorate a UI and must not be able to fail a
 * page.
 *
 * **Symlinks are not followed** (only `isFile()` entries are added, and a link
 * reports as neither file nor directory here), so a world symlinked onto another
 * drive is not double-counted and a link loop cannot hang the walk. This is
 * `du`-like, not `du -L`.
 *
 * Directories are walked level by level with each level read concurrently: the
 * cost is syscall latency rather than CPU, and a serial walk of a large world
 * directory is several times slower.
 */
export async function dirSize(
	dir: string,
	options: DirSizeOptions = {},
): Promise<DirSize> {
	const maxEntries = options.maxEntries ?? 200_000;
	let bytes = 0;
	let files = 0;
	let seen = 0;
	let truncated = false;
	let level = [dir];

	while (level.length > 0 && !truncated) {
		const next: string[] = [];
		await Promise.all(
			level.map(async (current) => {
				let entries: Dirent[];
				try {
					entries = await readdir(current, { withFileTypes: true });
				} catch {
					return; // Unreadable subtree: skip it rather than failing the walk.
				}
				for (const entry of entries) {
					if (seen >= maxEntries) {
						truncated = true;
						return;
					}
					seen += 1;
					const full = join(current, entry.name);
					if (entry.isDirectory()) {
						if (!options.exclude?.has(entry.name)) next.push(full);
					} else if (entry.isFile()) {
						try {
							bytes += (await stat(full)).size;
							files += 1;
						} catch {
							// Vanished between readdir and stat (a rotating log): ignore.
						}
					}
				}
			}),
		);
		level = next;
	}

	return { bytes, files, truncated };
}

/**
 * The temp filename an atomic write to `target` uses, e.g.
 * `.config.json.4711-k3f9a.tmp`. Leading dot (hidden), target basename, then a
 * pid+random suffix so concurrent instances never collide.
 */
export function tempNameFor(target: string): string {
	return `.${target}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
}

/**
 * Recover the target basename from a temp name produced by {@link tempNameFor},
 * or `undefined` when `name` is not one of our temp files. This is what lets a
 * directory watcher attribute an in-progress atomic write to the file it will
 * replace.
 */
export function targetOfTempName(name: string): string | undefined {
	const match = /^\.(.+)\.\d+-[0-9a-z]+\.tmp$/.exec(name);
	return match?.[1];
}

/** Options for the atomic-write helpers. */
export interface AtomicWriteOptions {
	/** File mode to apply to the final file, e.g. `0o600` for `secrets.json`. */
	mode?: number;
}

/**
 * Write `contents` to `path` atomically: write a sibling temp file, apply the
 * mode, then `rename` over the target. Parent directories are created first.
 * The temp file lives in the *same* directory so the rename stays within one
 * filesystem (cross-device rename is not atomic and would fall back to copy).
 */
export async function writeFileAtomic(
	path: string,
	contents: string | Uint8Array,
	options?: AtomicWriteOptions,
): Promise<void> {
	const dir = dirname(path);
	await ensureDir(dir);
	// Unique-enough temp name; collisions between instances are avoided by pid+random.
	//
	// The temp name **embeds the target's basename** because a directory watcher
	// cannot otherwise tell what an atomic write touched: Bun's `fs.watch` reports
	// a rename under the *source* name only, so `config.json` never appears in a
	// watch event even though it is what changed. `core/events/watch.ts` maps this
	// name back to the target — keep the two in sync (see {@link tempNameFor}).
	const tmp = join(dir, tempNameFor(basename(path)));
	await writeFile(tmp, contents);
	if (options?.mode !== undefined) await chmod(tmp, options.mode);
	await rename(tmp, path);
}

/**
 * Serialize `data` as pretty JSON (2-space, trailing newline) and write it
 * atomically. Used for every MCTL-owned JSON file.
 */
export async function writeJsonAtomic(
	path: string,
	data: unknown,
	options?: AtomicWriteOptions,
): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, options);
}

/**
 * Append one line to a file, creating it (and parents) if needed. Used for the
 * append-only `events.jsonl` log. A single `appendFile` call with `O_APPEND`
 * gives per-write atomicity for small lines, which is what cross-instance
 * tailing relies on; the caller passes exactly one JSON object per call and
 * must not embed newlines in it.
 */
export async function appendLine(path: string, line: string): Promise<void> {
	await ensureDir(dirname(path));
	await appendFile(path, line.endsWith("\n") ? line : `${line}\n`);
}
