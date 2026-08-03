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
} from "node:fs/promises";
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
