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
  chmod,
  appendFile,
  access,
} from "node:fs/promises";
import { dirname, join } from "node:path";

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
  const tmp = join(dir, `.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
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
