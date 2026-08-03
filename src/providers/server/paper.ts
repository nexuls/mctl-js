/**
 * PaperProvider — PaperMC's high-performance Bukkit/Spigot fork.
 *
 * A concrete provider: `lib/` and `types/` only, never another provider.
 *
 * **Upstream shape — the v3 "Fill" API.** PaperMC's v3 API is served from
 * `fill.papermc.io`, *not* from the legacy `api.papermc.io` host (which fronts
 * v2 and rejects unknown clients through Cloudflare). Endpoints used:
 *
 *  - `GET /v3/projects/paper`
 *      → `{ versions: { "<minor>": ["<version>", …], … } }` — versions grouped by
 *        minor line, each group newest-first. Note this is an *object*, so the
 *        insertion order of the groups is the only ordering signal; we flatten it
 *        in the order given, which is newest-line-first.
 *  - `GET /v3/projects/paper/versions/<version>`
 *      → `{ version: { java: { version: { minimum, maximum? } } }, builds: [id…] }`
 *        Paper is the one kind in Phase 2 that declares a real Java *range*.
 *  - `GET /v3/projects/paper/versions/<version>/builds/latest`
 *      → `{ id, channel, downloads: { "server:default": { url, size,
 *          checksums: { sha256 }, name } } }`
 *
 * Two quirks worth knowing:
 *  - **The download key is `server:default`.** Some projects (Velocity, Folia)
 *    publish other keys; a missing `server:default` means the build is not a
 *    runnable server and is an error, not a fallback.
 *  - **`builds/latest` can be an unstable channel.** The build carries
 *    `channel: "STABLE" | "ALPHA" | …`; MCTL installs whatever `latest` reports
 *    but records the channel in the log so a surprising build is traceable.
 */

import { z } from "zod";
import { fetchJson } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import type {
	InstallRequest,
	InstallStrategy,
	LaunchSpec,
	LoaderVersion,
	VersionInfo,
} from "../../types/install.ts";
import type { JavaRequirement } from "../../types/java.ts";
import type { ServerProvider } from "../../types/provider.ts";
import { VersionNotFoundError } from "./vanilla.ts";

const logger = log("provider:paper");

/** v3 API base. `api.papermc.io` is the *v2* host and does not serve this. */
const FILL_BASE = "https://fill.papermc.io/v3";

/** Project index: versions grouped by minor line, each group newest-first. */
const ProjectResponse = z.looseObject({
	versions: z.record(z.string(), z.array(z.string())),
});

/** Per-version metadata; `java.version.minimum` is what makes Paper special. */
const VersionResponse = z.looseObject({
	version: z.looseObject({
		id: z.string().min(1),
		java: z
			.looseObject({
				version: z.looseObject({
					minimum: z.number().int().positive(),
					maximum: z.number().int().positive().optional(),
				}),
			})
			.optional(),
	}),
	builds: z.array(z.number().int()).optional(),
});

/** A single build, including its downloadable artefacts. */
const BuildResponse = z.looseObject({
	id: z.number().int(),
	channel: z.string().optional(),
	downloads: z.record(
		z.string(),
		z.looseObject({
			name: z.string().optional(),
			size: z.number().int().nonnegative().optional(),
			url: z.url(),
			checksums: z.looseObject({ sha256: z.string().optional() }).optional(),
		}),
	),
});

/** The artefact key for the runnable server jar. */
const SERVER_DOWNLOAD = "server:default";

export class PaperProvider implements ServerProvider {
	readonly id = "paper";
	readonly displayName = "Paper";

	/**
	 * Every Minecraft version Paper builds for, newest first.
	 *
	 * Paper publishes no release-type flag, so everything is reported as
	 * `release`; its pre-release builds are distinguished by the version string
	 * itself (`1.21.11-rc1`), which we surface as `snapshot` so the UI can filter
	 * them the same way it filters Mojang snapshots.
	 */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const project = ProjectResponse.parse(
			await fetchJson(`${FILL_BASE}/projects/paper`),
		);
		const out: VersionInfo[] = [];
		for (const group of Object.values(project.versions)) {
			for (const id of group) {
				out.push({ id, type: isPrerelease(id) ? "snapshot" : "release" });
			}
		}
		return out;
	}

	/** Paper is not a mod loader; its "builds" are versions of the server itself. */
	async loaderVersions(): Promise<LoaderVersion[]> {
		return [];
	}

	/**
	 * Paper declares an explicit Java range — the only Phase-2 kind that does — so
	 * this returns both bounds when upstream states them.
	 */
	async javaRequirement(
		minecraftVersion: string,
	): Promise<JavaRequirement | null> {
		const version = await this.#version(minecraftVersion);
		const java = version.version.java?.version;
		if (!java) {
			logger.info(
				{ minecraftVersion },
				"Paper declares no java version; caller must pin",
			);
			return null;
		}
		return { min: java.minimum, max: java.maximum, recommended: java.minimum };
	}

	/** The latest build's `server:default` jar, verified by its published SHA-256. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		// Resolve the version first so an unknown version fails with a clear error
		// rather than a 404 from the builds endpoint.
		await this.#version(request.minecraftVersion);

		const build = BuildResponse.parse(
			await fetchJson(
				`${FILL_BASE}/projects/paper/versions/${encodeURIComponent(request.minecraftVersion)}/builds/latest`,
			),
		);
		const download = build.downloads[SERVER_DOWNLOAD];
		if (!download) {
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				`build ${build.id} publishes no "${SERVER_DOWNLOAD}" artefact`,
			);
		}
		logger.info(
			{
				minecraftVersion: request.minecraftVersion,
				build: build.id,
				channel: build.channel,
			},
			"resolved Paper build",
		);
		return {
			kind: "directJar",
			url: download.url,
			sha256: download.checksums?.sha256,
			size: download.size,
			dest: "server.jar",
		};
	}

	/** `java -jar server.jar nogui`. */
	launchSpec(): LaunchSpec {
		return { kind: "jar", jar: "server.jar" };
	}

	/** Fetch and validate one version's metadata, mapping a 404 to a typed error. */
	async #version(version: string): Promise<z.infer<typeof VersionResponse>> {
		try {
			return VersionResponse.parse(
				await fetchJson(
					`${FILL_BASE}/projects/paper/versions/${encodeURIComponent(version)}`,
				),
			);
		} catch (err) {
			// `lib/http` throws HttpError for a 404; anything else (a schema change) is
			// a genuine surprise and is re-thrown untouched.
			if (err instanceof Error && err.name === "HttpError") {
				throw new VersionNotFoundError(
					this.id,
					version,
					"Paper publishes no builds for this Minecraft version",
				);
			}
			throw err;
		}
	}
}

/** Paper spells pre-releases into the version string itself (`1.21.11-rc1`). */
function isPrerelease(id: string): boolean {
	return /-(rc|pre)\d*/i.test(id);
}
