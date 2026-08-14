/**
 * PurpurProvider — Purpur, a Paper fork adding gameplay configuration.
 *
 * A concrete provider: `lib/` and `types/` only. It does **not** extend
 * `FillProvider` — Purpur is not hosted on PaperMC's infrastructure and runs its
 * own API with a different shape.
 *
 * **Upstream shape — api.purpurmc.org v2.**
 *
 *  - `GET /v2/purpur`
 *      → `{ versions: ["1.14.1", …, "26.2"] }` — **oldest first**.
 *  - `GET /v2/purpur/<version>`
 *      → `{ builds: { latest: "2416", all: [...] } }`. Build numbers are
 *        **strings**, not numbers, in this API.
 *  - `GET /v2/purpur/<version>/<build>`
 *      → `{ build, result: "SUCCESS" | …, md5 }`
 *  - `GET /v2/purpur/<version>/<build>/download` → the jar.
 *
 * Two things to know:
 *  - **Purpur publishes MD5 and nothing else.** Weak as a security primitive, but
 *    it is a real integrity check against a truncated or corrupted transfer, which
 *    is what a checksum on a CDN download is actually guarding against here — so
 *    it is verified rather than skipped (`lib/download.ts` computes it alongside
 *    the others).
 *  - **A build can have `result` other than `SUCCESS`.** `builds.latest` points at
 *    the newest build whatever its result, so the result is checked and a failed
 *    build is refused rather than downloaded.
 *  - Purpur declares **no Java requirement**, so Minecraft's own is used. Purpur
 *    is a Paper fork and Paper's stated range would be a better answer, but that
 *    would mean one provider importing another — the arrow that must not reverse.
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
import { mojangJavaRequirement, VersionNotFoundError } from "./mojang-meta.ts";

const logger = log("provider:purpur");

const PURPUR_BASE = "https://api.purpurmc.org/v2/purpur";

/** `/v2/purpur` — every Minecraft version Purpur builds for, oldest first. */
const ProjectResponse = z.looseObject({
	versions: z.array(z.string().min(1)),
});

/** `/v2/purpur/<version>` — build numbers are strings in this API. */
const VersionResponse = z.looseObject({
	builds: z.looseObject({
		latest: z.string().min(1),
		all: z.array(z.string()).optional(),
	}),
});

/** `/v2/purpur/<version>/<build>` — the digest and whether the build succeeded. */
const BuildResponse = z.looseObject({
	build: z.string().min(1),
	result: z.string().optional(),
	md5: z.string().optional(),
});

export class PurpurProvider implements ServerProvider {
	readonly id = "purpur";
	readonly displayName = "Purpur";
	readonly description = "Paper fork adding gameplay tuning and config knobs";

	/** Every Minecraft version Purpur builds for, newest first. */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const project = ProjectResponse.parse(await fetchJson(PURPUR_BASE));
		// Upstream is oldest-first; every other provider reports newest-first.
		return [...project.versions]
			.reverse()
			.map((id) => ({ id, type: "release" as const }));
	}

	/** Purpur is not a mod loader; its builds are versions of the server itself. */
	async loaderVersions(): Promise<LoaderVersion[]> {
		return [];
	}

	/** Minecraft's own requirement — Purpur declares none of its own. */
	async javaRequirement(
		minecraftVersion: string,
	): Promise<JavaRequirement | null> {
		return mojangJavaRequirement(minecraftVersion, this.id);
	}

	/** The latest successful build, verified by its published MD5. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		const version = encodeURIComponent(request.minecraftVersion);
		let latest: string;
		try {
			latest = VersionResponse.parse(
				await fetchJson(`${PURPUR_BASE}/${version}`),
			).builds.latest;
		} catch (err) {
			if (err instanceof Error && err.name === "HttpError") {
				throw new VersionNotFoundError(
					this.id,
					request.minecraftVersion,
					"Purpur publishes no builds for this Minecraft version",
				);
			}
			throw err;
		}

		const build = BuildResponse.parse(
			await fetchJson(
				`${PURPUR_BASE}/${version}/${encodeURIComponent(latest)}`,
			),
		);
		if (build.result && build.result !== "SUCCESS") {
			// `builds.latest` is the newest build, not the newest *good* one.
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				`Purpur's latest build (${latest}) did not succeed (${build.result})`,
			);
		}

		logger.info(
			{ minecraftVersion: request.minecraftVersion, build: latest },
			"resolved Purpur build",
		);
		return {
			kind: "directJar",
			url: `${PURPUR_BASE}/${version}/${encodeURIComponent(latest)}/download`,
			md5: build.md5,
			dest: "server.jar",
		};
	}

	/** `java -jar server.jar nogui`. */
	launchSpec(): LaunchSpec {
		return { kind: "jar", jar: "server.jar" };
	}
}
