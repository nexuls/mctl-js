/**
 * sources — where a player's skin PNG comes from, in preference order.
 *
 * Core service. Network-facing but UI-free and server-free: a source is handed a
 * name and (when known) a uuid and returns skin bytes or nothing. Decoding is
 * `head.ts`'s job; caching and orchestration are `index.ts`'s.
 *
 * **The order is Mojang → TLauncher → Ely.by, and it is a fallback chain, not a
 * search.** Mojang is authoritative for a licensed account, so it answers first
 * and its answer is final. The other two are the skin systems the common
 * offline-mode launchers use, and they only know their *own* users — which is
 * exactly the population Mojang cannot answer for. A server running in offline
 * mode has players in all three groups at once.
 *
 * **A miss is not an error.** Every one of these answers "I don't know this
 * player" with a 404 (or, for Mojang, `204 No Content`), which is the *normal*
 * outcome for two of the three sources on every lookup. Sources therefore return
 * `undefined` rather than throwing, and only a genuinely broken response is
 * logged. Ely.by in particular rate-limits and answers `500` under load; the
 * chain simply moves on and the caller falls back to a built-in face.
 *
 * Endpoints:
 *  - https://api.mojang.com/users/profiles/minecraft/<name>  → `{ id }`
 *  - https://sessionserver.mojang.com/session/minecraft/profile/<uuid> →
 *    a base64 `textures` property holding the skin URL
 *  - https://auth.tlauncher.org/skin/profile/skin/<name>.png
 *  - http://skinsystem.ely.by/skins/<name>.png (documented at
 *    https://docs.ely.by/en/skins-system.html)
 */

import { z } from "zod";
import { log } from "../../lib/logger.ts";

const logger = log("skins");

/** How long any one upstream request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 6_000;

/** Sent on every request so upstream can attribute the traffic. */
const USER_AGENT = "mctl (+https://github.com/mctl)";

/** Who to look up. `name` is always known; `uuid` only sometimes. */
export interface SkinLookup {
	/** The player's name, as the server spelled it. */
	name: string;
	/** The player's uuid, dashed or not, when a source carried one. */
	uuid?: string;
}

/** One place a skin can come from. */
export interface SkinSource {
	/** Stable id, recorded in the cache so a hit says where it came from. */
	readonly id: string;
	/** Human name, for logs and for the UI if it ever wants to attribute a head. */
	readonly displayName: string;
	/**
	 * Fetch this player's skin texture.
	 * @returns the PNG bytes, or `undefined` when this source does not know the
	 *   player or is unreachable. Never throws.
	 */
	fetchSkin(lookup: SkinLookup): Promise<Uint8Array | undefined>;
}

/** GET a URL with a timeout, returning `undefined` for any non-200 or failure. */
async function get(url: string): Promise<Response | undefined> {
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.status === 200) return response;
		// 204/404 = "not this source's player", the expected miss. Anything else is
		// worth a line in the log but is still just a miss to the caller.
		if (response.status !== 204 && response.status !== 404) {
			logger.debug({ url, status: response.status }, "skin source declined");
		}
		return undefined;
	} catch (err) {
		logger.debug({ url, err: String(err) }, "skin source unreachable");
		return undefined;
	}
}

/** GET a URL and return its body as bytes, or `undefined`. */
async function getBytes(url: string): Promise<Uint8Array | undefined> {
	const response = await get(url);
	if (!response) return undefined;
	return new Uint8Array(await response.arrayBuffer());
}

/** Mojang serves uuids without dashes; a `mctl.json` roster may carry either. */
function undashed(uuid: string): string {
	return uuid.replace(/-/g, "").toLowerCase();
}

/** `{ id, name }` from the name→uuid endpoint. */
const MojangProfileSchema = z.object({ id: z.string() });

/** The session server's profile: the skin lives in a base64 `textures` property. */
const MojangSessionSchema = z.object({
	properties: z.array(z.object({ name: z.string(), value: z.string() })),
});

/** The decoded `textures` property. `SKIN` is absent for a default-skin account. */
const MojangTexturesSchema = z.object({
	textures: z.object({ SKIN: z.object({ url: z.string() }).optional() }),
});

/** Parse JSON and validate it, returning `undefined` on any failure. */
async function json<T>(
	response: Response,
	schema: z.ZodType<T>,
	what: string,
): Promise<T | undefined> {
	try {
		const parsed = schema.safeParse(await response.json());
		if (parsed.success) return parsed.data;
		logger.debug({ what, issues: parsed.error.issues }, "unexpected response");
	} catch (err) {
		logger.debug({ what, err: String(err) }, "unparseable response");
	}
	return undefined;
}

/**
 * The official source: a licensed Minecraft account's current skin.
 *
 * Two hops, because the session server keys on uuid alone. A uuid from an
 * **offline-mode** server is a locally derived v3 uuid that Mojang has never
 * heard of, so a uuid miss falls back to resolving the *name* — which is the
 * case that actually matters, since an offline server's players may still own
 * accounts.
 */
const mojang: SkinSource = {
	id: "mojang",
	displayName: "Minecraft",
	async fetchSkin(lookup) {
		const candidates: string[] = [];
		if (lookup.uuid) candidates.push(undashed(lookup.uuid));

		// Resolve the name too — either because no uuid was known, or because the
		// one we have is an offline-mode uuid the session server will not answer.
		const byName = await get(
			`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(lookup.name)}`,
		);
		if (byName) {
			const profile = await json(byName, MojangProfileSchema, "mojang profile");
			const resolved = profile && undashed(profile.id);
			if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
		}

		for (const uuid of candidates) {
			const response = await get(
				`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
			);
			if (!response) continue;
			const session = await json(
				response,
				MojangSessionSchema,
				"mojang session",
			);
			const property = session?.properties.find(
				(entry) => entry.name === "textures",
			);
			if (!property) continue;

			let decoded: unknown;
			try {
				decoded = JSON.parse(
					Buffer.from(property.value, "base64").toString("utf8"),
				);
			} catch {
				continue;
			}
			const textures = MojangTexturesSchema.safeParse(decoded);
			// No `SKIN` means the account is on a default Steve/Alex, which MCTL
			// draws from its own built-ins — better than fetching Mojang's copy.
			const url = textures.success
				? textures.data.textures.SKIN?.url
				: undefined;
			if (!url) continue;

			// The property spells the CDN as `http://`; the same host serves https.
			const bytes = await getBytes(url.replace(/^http:\/\//, "https://"));
			if (bytes) return bytes;
		}
		return undefined;
	},
};

/** TLauncher's skin system — name-keyed, for its own accounts. */
const tlauncher: SkinSource = {
	id: "tlauncher",
	displayName: "TLauncher",
	async fetchSkin(lookup) {
		return getBytes(
			`https://auth.tlauncher.org/skin/profile/skin/${encodeURIComponent(lookup.name)}.png`,
		);
	},
};

/** Ely.by's skin system — name-keyed, for its own accounts. */
const elyby: SkinSource = {
	id: "ely.by",
	displayName: "Ely.by",
	async fetchSkin(lookup) {
		return getBytes(
			`http://skinsystem.ely.by/skins/${encodeURIComponent(lookup.name)}.png`,
		);
	},
};

/**
 * The fallback chain, in order. Exported as data so the order is one obvious
 * line rather than a sequence of `if`s buried in the resolver.
 */
export const SKIN_SOURCES: readonly SkinSource[] = [mojang, tlauncher, elyby];
