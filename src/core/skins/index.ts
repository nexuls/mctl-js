/**
 * skins — resolve a player's 8×8 head face, from upstream or from cache.
 *
 * Core service (`core/skins/`), the third read path on a player after
 * `core/server/players.ts` and the rosters. UI-free: it returns a
 * {@link HeadSkin} view model and knows nothing about frame buffers.
 *
 * ```
 * resolveHeadSkin  →  cache hit?  →  yes: done
 *                       │ no
 *                       ▼
 *                  Mojang → TLauncher → Ely.by   (sources.ts, in order)
 *                       │
 *                       ▼
 *                  decode PNG, crop the 8×8 head (head.ts)
 *                       │
 *                       ▼
 *                  write the cache entry (hit or miss)
 * ```
 *
 * **Misses are cached too, and that is the point.** Two of the three sources
 * answer "not my player" for almost every lookup, and the Players tab re-reads
 * its roster every five seconds. Without a negative entry, one offline-mode
 * server with twenty players would issue sixty upstream requests every poll —
 * enough to get rate-limited by all three. A miss is held for
 * {@link MISS_TTL_MS} (short, because a player may set a skin) and a hit for
 * {@link HIT_TTL_MS}.
 *
 * The cache lives under `~/.cache/mctl/skins/` and is safe to delete at any
 * time (architecture.md § Paths): losing it costs one refetch, and a failed
 * refetch costs nothing at all, because the caller falls back to a built-in
 * face.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { skinCacheDir } from "../../lib/paths.ts";
import { HeadSkinSchema, type HeadSkin } from "../../types/skin.ts";
import { headSkinFromPng } from "./head.ts";
import { SKIN_SOURCES, type SkinLookup } from "./sources.ts";

export { headSkinFromImage, headSkinFromPng, SkinFormatError } from "./head.ts";
export { SKIN_SOURCES, type SkinLookup, type SkinSource } from "./sources.ts";

const logger = log("skins");

/** How long a resolved face is reused before MCTL asks upstream again. */
export const HIT_TTL_MS = 24 * 60 * 60_000; // 1 day

/** How long "no source has a skin for this player" is remembered. */
export const MISS_TTL_MS = 6 * 60 * 60_000; // 6 hours

/** One cache file: the resolved face, or the recorded absence of one. */
interface CacheEntry {
	/** The lookup key this entry answers, kept so a hash collision is visible. */
	key: string;
	/** Epoch ms of the lookup that produced this entry. */
	fetchedAt: number;
	/** Which source answered. Absent on a miss. */
	source?: string;
	/** The face. Absent means every source declined. */
	skin?: HeadSkin;
}

/**
 * Cache key for a lookup. The uuid identifies a player across renames, so it
 * wins when present; a name-only player (an offline-mode ban record) keys on its
 * lower-cased name.
 */
function keyFor(lookup: SkinLookup): string {
	return lookup.uuid
		? `uuid:${lookup.uuid.replace(/-/g, "").toLowerCase()}`
		: `name:${lookup.name.toLowerCase()}`;
}

/** Cache file for a key — hashed so any name is filesystem-safe. */
function cacheFile(key: string): string {
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return join(skinCacheDir(), `${hash}.json`);
}

/** Read and validate a cache entry, treating anything unexpected as a miss. */
async function readEntry(key: string): Promise<CacheEntry | undefined> {
	try {
		const raw = (await readJsonIfExists(cacheFile(key))) as
			| Record<string, unknown>
			| undefined;
		if (!raw || raw.key !== key || typeof raw.fetchedAt !== "number") {
			return undefined;
		}
		if (raw.skin === undefined) {
			return { key, fetchedAt: raw.fetchedAt };
		}
		// Zod at the boundary: a hand-edited or truncated face must not reach the
		// renderer, where a missing palette code would paint `undefined`.
		const skin = HeadSkinSchema.safeParse(raw.skin);
		if (!skin.success) return undefined;
		return {
			key,
			fetchedAt: raw.fetchedAt,
			source: typeof raw.source === "string" ? raw.source : undefined,
			skin: skin.data,
		};
	} catch {
		// A corrupt cache file is disposable — treat it as a miss.
		return undefined;
	}
}

/**
 * Persist an entry, swallowing any failure. The cache is an optimisation — an
 * unwritable cache directory must cost a refetch, never a lookup.
 */
async function writeEntry(entry: CacheEntry): Promise<void> {
	try {
		await writeJsonAtomic(cacheFile(entry.key), entry);
	} catch (err) {
		logger.debug(
			{ key: entry.key, err: String(err) },
			"skin cache not written",
		);
	}
}

/** Is this entry still within its (hit or miss) time to live? */
function fresh(entry: CacheEntry): boolean {
	const ttl = entry.skin ? HIT_TTL_MS : MISS_TTL_MS;
	return Date.now() - entry.fetchedAt < ttl;
}

/**
 * In-flight lookups, so N cards asking for the same player at once produce one
 * round of requests. Concurrency control, not state: the map holds promises for
 * work this process is currently doing and nothing is read back out of it.
 */
const inFlight = new Map<string, Promise<HeadSkin | undefined>>();

/** Options for {@link resolveHeadSkin}. */
export interface ResolveSkinOptions {
	/** Ignore any cached entry and ask upstream again. */
	refresh?: boolean;
}

/**
 * Resolve one player's head face, trying each source in {@link SKIN_SOURCES}
 * order and caching whatever comes back.
 *
 * **Never throws and never rejects.** A skin is decoration: every failure mode —
 * offline, rate-limited, an unparseable PNG, an image that is not skin-shaped —
 * resolves to `undefined`, and the caller draws a built-in face instead.
 *
 * @returns the face, or `undefined` when no source has one.
 */
export async function resolveHeadSkin(
	lookup: SkinLookup,
	options: ResolveSkinOptions = {},
): Promise<HeadSkin | undefined> {
	if (lookup.name === "" && lookup.uuid === undefined) return undefined;
	const key = keyFor(lookup);

	const running = inFlight.get(key);
	if (running) return running;

	const work = (async (): Promise<HeadSkin | undefined> => {
		if (!options.refresh) {
			const cached = await readEntry(key);
			if (cached && fresh(cached)) return cached.skin;
		}

		for (const source of SKIN_SOURCES) {
			const bytes = await source.fetchSkin(lookup);
			if (!bytes || bytes.length === 0) continue;
			try {
				const skin = headSkinFromPng(bytes);
				await writeEntry({
					key,
					fetchedAt: Date.now(),
					source: source.id,
					skin,
				});
				return skin;
			} catch (err) {
				// The source answered with something that is not a usable skin. Log it
				// and keep going down the chain rather than failing the whole lookup.
				logger.debug(
					{ source: source.id, player: lookup.name, err: String(err) },
					"skin could not be decoded",
				);
			}
		}

		await writeEntry({ key, fetchedAt: Date.now() });
		return undefined;
	})().finally(() => inFlight.delete(key));

	inFlight.set(key, work);
	return work;
}
