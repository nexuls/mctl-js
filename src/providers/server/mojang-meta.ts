/**
 * Mojang's version metadata — the upstream source **five** providers need.
 *
 * Not a provider: a shared client for one origin, living beside the providers
 * that use it. That distinction matters, because "no provider imports another
 * provider" (AGENTS.md § 3) exists so a backup provider cannot reach into a
 * runtime — not to stop Fabric and Forge sharing an HTTP client. Without this
 * module, Fabric would have to import `VanillaProvider` to answer "what Java
 * does Minecraft 1.21.4 need", which is exactly the arrow the rule forbids.
 *
 * Depends on `lib/` and `types/` only.
 *
 * **Upstream shape (two hops).**
 *  1. The version manifest lists every version and, for each, the URL of that
 *     version's own JSON:
 *     https://launchermeta.mojang.com/mc/game/version_manifest_v2.json
 *  2. That per-version JSON carries both the server download and the Java
 *     requirement:
 *     https://piston-meta.mojang.com/v1/packages/<sha1>/<version>.json
 *     → `downloads.server = { url, sha1, size }`
 *     → `javaVersion.majorVersion` (e.g. 21 for 1.21.4)
 *
 * Both requests go through `lib/http.ts`, so the manifest is fetched at most
 * once per TTL window however many versions are inspected — which is why every
 * function here re-reads it rather than passing one around.
 */

import { z } from "zod";
import { fetchJson } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import type { VersionInfo } from "../../types/install.ts";
import type { JavaRequirement } from "../../types/java.ts";

const logger = log("mojang-meta");

/** Mojang's version manifest (v2 adds `sha1`/`complianceLevel` over v1). */
const VERSION_MANIFEST_URL =
	"https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

/** One entry of the version manifest. Loose: Mojang adds fields over time. */
const ManifestVersion = z.looseObject({
	id: z.string().min(1),
	type: z.string().min(1),
	url: z.url(),
	releaseTime: z.string().optional(),
});

const VersionManifest = z.looseObject({
	latest: z.looseObject({ release: z.string(), snapshot: z.string() }),
	versions: z.array(ManifestVersion),
});

/** The per-version package JSON, narrowed to the two fields MCTL needs. */
const VersionPackage = z.looseObject({
	downloads: z.looseObject({
		server: z
			.looseObject({
				url: z.url(),
				sha1: z.string().min(1),
				size: z.number().int().nonnegative(),
			})
			.optional(),
	}),
	javaVersion: z
		.looseObject({ majorVersion: z.number().int().positive() })
		.optional(),
});
export type MojangVersionPackage = z.infer<typeof VersionPackage>;

/** Thrown when a requested Minecraft version is unknown or has no server jar. */
export class VersionNotFoundError extends Error {
	constructor(
		readonly kind: string,
		readonly version: string,
		detail: string,
	) {
		super(`${kind}: ${detail} (version "${version}")`);
		this.name = "VersionNotFoundError";
	}
}

/** Map Mojang's `type` string onto our three-way channel. */
function channelOf(type: string): VersionInfo["type"] {
	if (type === "release") return "release";
	if (type === "snapshot") return "snapshot";
	return "other"; // old_alpha / old_beta
}

/**
 * Every Minecraft version Mojang publishes, newest first — the manifest's own
 * order, which is the order the launcher shows.
 */
export async function mojangVersions(): Promise<VersionInfo[]> {
	const manifest = VersionManifest.parse(await fetchJson(VERSION_MANIFEST_URL));
	return manifest.versions.map((v) => ({
		id: v.id,
		type: channelOf(v.type),
		releaseTime: v.releaseTime,
	}));
}

/**
 * Fetch and validate one version's package JSON.
 *
 * @param kind the calling provider's id, so the error names the right thing.
 * @throws {VersionNotFoundError} when the manifest does not list the version.
 */
export async function mojangVersionPackage(
	version: string,
	kind: string,
): Promise<MojangVersionPackage> {
	const manifest = VersionManifest.parse(await fetchJson(VERSION_MANIFEST_URL));
	const entry = manifest.versions.find((v) => v.id === version);
	if (!entry) {
		throw new VersionNotFoundError(kind, version, "unknown Minecraft version");
	}
	return VersionPackage.parse(await fetchJson(entry.url));
}

/**
 * The Java version Minecraft itself declares for a version, as a `{ min }`.
 *
 * **This is the fallback every loader relies on.** Fabric, Quilt, Forge and
 * NeoForge publish no Java requirement of their own — they run *inside* the
 * Minecraft server, so Minecraft's requirement is theirs (plan.md § Java
 * Manager). `null` means Mojang declared nothing either (roughly pre-1.17),
 * which is the case where MCTL must ask the user and pin the answer rather than
 * guess.
 *
 * No `max` is ever returned: Mojang declares the runtime it ships, never an
 * upper bound, and `core/java/` applies MCTL's own LTS ceiling.
 */
export async function mojangJavaRequirement(
	version: string,
	kind: string,
): Promise<JavaRequirement | null> {
	const pkg = await mojangVersionPackage(version, kind);
	const major = pkg.javaVersion?.majorVersion;
	if (major === undefined) {
		logger.info(
			{ version, kind },
			"no javaVersion in package JSON; caller must pin",
		);
		return null;
	}
	return { min: major, recommended: major };
}
