/**
 * The PaperMC "Fill" v3 API — one client, several projects.
 *
 * Not a provider itself: a base class the PaperMC-hosted kinds extend, because
 * Paper, Velocity and Folia are the *same API* with a different project id. The
 * alternative — three copies of the same three endpoints — is how they drift.
 *
 * Depends on `lib/` and `types/` only.
 *
 * **Upstream shape.** The v3 API is served from `fill.papermc.io`, *not* from
 * the legacy `api.papermc.io` host (which fronts v2 and rejects unknown clients
 * through Cloudflare). Endpoints used:
 *
 *  - `GET /v3/projects/<project>`
 *      → `{ versions: { "<line>": ["<version>", …], … } }` — versions grouped by
 *        release line, each group newest-first. Note this is an *object*, so the
 *        insertion order of the groups is the only ordering signal; we flatten it
 *        in the order given, which is newest-line-first.
 *  - `GET /v3/projects/<project>/versions/<version>`
 *      → `{ version: { java: { version: { minimum, maximum? } } }, builds: [id…] }`
 *        These projects are the ones that declare a real Java *range*.
 *  - `GET /v3/projects/<project>/versions/<version>/builds/latest`
 *      → `{ id, channel, downloads: { "server:default": { url, size,
 *          checksums: { sha256 }, name } } }`
 *
 * Two quirks worth knowing:
 *  - **The download key is `server:default`.** Some projects publish other keys;
 *    a missing `server:default` means the build is not a runnable server and is
 *    an error, not a fallback.
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
import { VersionNotFoundError } from "./mojang-meta.ts";

const logger = log("provider:fill");

/** v3 API base. `api.papermc.io` is the *v2* host and does not serve this. */
const FILL_BASE = "https://fill.papermc.io/v3";

/** Project index: versions grouped by release line, each group newest-first. */
const ProjectResponse = z.looseObject({
	versions: z.record(z.string(), z.array(z.string())),
});

/** Per-version metadata; `java.version.minimum` is what makes these kinds special. */
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

/** These projects spell pre-releases into the version string (`1.21.11-rc1`). */
function isPrerelease(id: string): boolean {
	return /-(rc|pre|snapshot)/i.test(id);
}

/**
 * A server kind published through the Fill API. Subclasses supply the project id
 * and the name the jar is installed as; everything else is identical.
 */
export abstract class FillProvider implements ServerProvider {
	abstract readonly id: string;
	abstract readonly displayName: string;

	/** The `fill.papermc.io` project id, e.g. `"paper"`. */
	protected abstract readonly project: string;

	/** Filename the downloaded jar is stored under, and launched from. */
	protected readonly jarName: string = "server.jar";

	/**
	 * Program arguments passed after the jar. `nogui` suppresses Mojang's Swing
	 * console on a *server*; a proxy has no such console and is given none.
	 */
	protected readonly programArgs: string[] | undefined = undefined;

	/**
	 * Every version this project builds for, newest first.
	 *
	 * The API publishes no release-type flag, so everything is reported as
	 * `release` unless the version string itself says otherwise (`1.21.11-rc1`),
	 * which is surfaced as `snapshot` so the UI can filter these the same way it
	 * filters Mojang snapshots.
	 */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const project = ProjectResponse.parse(
			await fetchJson(`${FILL_BASE}/projects/${this.project}`),
		);
		const out: VersionInfo[] = [];
		for (const group of Object.values(project.versions)) {
			for (const id of group) {
				out.push({ id, type: isPrerelease(id) ? "snapshot" : "release" });
			}
		}
		return out;
	}

	/** None of these kinds is a mod loader; their "builds" are server versions. */
	async loaderVersions(): Promise<LoaderVersion[]> {
		return [];
	}

	/** These projects declare an explicit Java range, so both bounds are reported. */
	async javaRequirement(version: string): Promise<JavaRequirement | null> {
		const meta = await this.version(version);
		const java = meta.version.java?.version;
		if (!java) {
			logger.info(
				{ project: this.project, version },
				"no java version declared; caller must pin",
			);
			return null;
		}
		return { min: java.minimum, max: java.maximum, recommended: java.minimum };
	}

	/** The latest build's `server:default` jar, verified by its published SHA-256. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		// Resolve the version first so an unknown version fails with a clear error
		// rather than a 404 from the builds endpoint.
		await this.version(request.minecraftVersion);

		const build = BuildResponse.parse(
			await fetchJson(
				`${FILL_BASE}/projects/${this.project}/versions/${encodeURIComponent(request.minecraftVersion)}/builds/latest`,
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
				project: this.project,
				version: request.minecraftVersion,
				build: build.id,
				channel: build.channel,
			},
			"resolved build",
		);
		return {
			kind: "directJar",
			url: download.url,
			sha256: download.checksums?.sha256,
			size: download.size,
			dest: this.jarName,
		};
	}

	/** `java -jar <jar> [nogui]`. */
	launchSpec(): LaunchSpec {
		return { kind: "jar", jar: this.jarName, args: this.programArgs };
	}

	/** Fetch and validate one version's metadata, mapping a 404 to a typed error. */
	protected async version(
		version: string,
	): Promise<z.infer<typeof VersionResponse>> {
		try {
			return VersionResponse.parse(
				await fetchJson(
					`${FILL_BASE}/projects/${this.project}/versions/${encodeURIComponent(version)}`,
				),
			);
		} catch (err) {
			// `lib/http` throws HttpError for a 404; anything else (a schema change) is
			// a genuine surprise and is re-thrown untouched.
			if (err instanceof Error && err.name === "HttpError") {
				throw new VersionNotFoundError(
					this.id,
					version,
					`${this.displayName} publishes no builds for this version`,
				);
			}
			throw err;
		}
	}
}
