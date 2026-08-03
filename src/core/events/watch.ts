/**
 * Hard-state filesystem watchers — the second sync mechanism alongside the
 * `events.jsonl` tail (architecture.md § Statelessness). `fs.watch` on the
 * config, the registry, and the runtime directory turns a raw file change
 * (including a user hand-editing `config.json`, which no instance would have
 * logged) into a local {@link MctlEvent} so hooks re-read the affected state.
 *
 * Core service — no UI, no providers. Emits **local-only** events (`bus.emit`,
 * not `publish`): these are reactions to a file already changed, not new state
 * to append to the log.
 *
 * **Why watch directories, not files.** MCTL writes shared JSON atomically
 * (temp + `rename`), which replaces the file's inode. A watch bound to the file
 * itself would go stale after the first atomic write; watching the *parent
 * directory* and filtering by name survives renames. See `lib/fs.ts`.
 *
 * **Why temp names are resolved to their target.** Bun's `fs.watch` reports a
 * rename under the **source** name only — writing `config.json` atomically
 * surfaces as `.config.json.<pid>-<rand>.tmp` and the target name never appears,
 * so a naive `name === "config.json"` filter silently never fires (measured on
 * Bun 1.3). `lib/fs.ts` therefore embeds the target basename in the temp name and
 * {@link targetOfTempName} maps it back before filtering.
 */

import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { configDir, stateDir, runtimeDir } from "../../lib/paths.ts";
import { ensureDir, targetOfTempName } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { EventType } from "../../types/events.ts";
import { INSTANCE_ID } from "./instance.ts";
import type { EventBus } from "./bus.ts";

const logger = log("watch");

/** Coalesce a burst of watch callbacks (editors/atomic writes fire several). */
const DEBOUNCE_MS = 60;

/**
 * Emit a local-only event. Tagged with our own {@link INSTANCE_ID} for a uniform
 * envelope; the tail's self-skip means this never round-trips through the log.
 */
function emitLocal(bus: EventBus, type: string, payload?: unknown): void {
	bus.emit({
		v: 1,
		id: `${INSTANCE_ID}:${Date.now()}:${type}`,
		ts: new Date().toISOString(),
		instance: INSTANCE_ID,
		type,
		payload,
	});
}

/**
 * Watch a directory and invoke `onFile(filename)` (debounced per filename) when
 * a watched entry changes. Returns a closer, or `undefined` if the directory
 * can't be watched (it is ensured first, so that is rare).
 */
function watchDir(
	dir: string,
	onFile: (filename: string) => void,
): FSWatcher | undefined {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	try {
		return watch(dir, (_event, filename) => {
			if (!filename) return;
			const raw = basename(filename.toString());
			// An in-progress atomic write is reported under its temp name; attribute it
			// to the file it is about to replace. Debouncing then keys on the target,
			// so the temp-write and the rename coalesce into one event.
			const name = targetOfTempName(raw) ?? raw;
			const existing = timers.get(name);
			if (existing) clearTimeout(existing);
			timers.set(
				name,
				setTimeout(() => {
					timers.delete(name);
					onFile(name);
				}, DEBOUNCE_MS),
			);
		});
	} catch (err) {
		logger.debug(
			{ dir, err: String(err) },
			"fs.watch on directory unavailable",
		);
		return undefined;
	}
}

/**
 * Start watching the hard-state files and emit local events on change:
 *  - `config.json`  → `ConfigChanged`
 *  - `servers.json` → `RegistryChanged`
 *  - `runtime/<id>.json` → `ServerStateChanged` `{ id }` (a session came/went)
 *
 * Directories are ensured first so the watches attach even on a fresh install.
 *
 * @returns a stop function that closes every watcher.
 */
export async function startWatchers(bus: EventBus): Promise<() => void> {
	await Promise.all([ensureDir(configDir()), ensureDir(runtimeDir())]);
	// stateDir is the parent of runtimeDir, so ensuring runtimeDir made it too.

	const watchers: (FSWatcher | undefined)[] = [];

	watchers.push(
		watchDir(configDir(), (name) => {
			if (name === "config.json") emitLocal(bus, EventType.ConfigChanged);
		}),
	);

	watchers.push(
		watchDir(stateDir(), (name) => {
			if (name === "servers.json") emitLocal(bus, EventType.RegistryChanged);
		}),
	);

	watchers.push(
		watchDir(runtimeDir(), (name) => {
			// A `<id>.json` descriptor appeared/changed/was reaped — a server's live
			// state changed. We don't know the new state here; the payload's id lets a
			// hook re-probe just that server (or the whole list).
			if (name.endsWith(".json")) {
				const id = name.slice(0, -".json".length);
				emitLocal(bus, EventType.ServerStateChanged, { id });
			}
		}),
	);

	return () => {
		for (const w of watchers) w?.close();
	};
}
