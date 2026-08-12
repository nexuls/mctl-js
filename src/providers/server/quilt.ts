/**
 * QuiltProvider — the Quilt mod loader (a Fabric fork).
 *
 * A concrete provider: `lib/`, `types/`, and the shared `mojang-meta.ts` client
 * only; it imports no other provider — including Fabric, which it deliberately
 * does not extend despite the family resemblance.
 *
 * **Why Quilt is an `installer` and Fabric is a `loaderJar`.** They look alike
 * and are not. Fabric's meta service has a `.../server/jar` endpoint that builds
 * a launcher on demand; Quilt's has no such route (verified: it answers 404) and
 * ships a GUI/CLI installer jar instead. So Quilt downloads a program and runs
 * it, which also means a Quilt create needs a JVM present — see
 * `core/server/install.ts`.
 *
 * **Upstream shape — meta.quiltmc.org v3.**
 *  - `GET /v3/versions/game` → `[{ version, stable }, …]`, newest first.
 *  - `GET /v3/versions/loader/<game>` → `[{ loader: { version, … }, … }, …]`.
 *  - `GET /v3/versions/installer` → `[{ version, url, hashes: { sha256 }, … }, …]`.
 *
 * **The installer's CLI, verified against v0.15.1** (`quilt-installer help`):
 *
 *     java -jar quilt-installer.jar install server <mc> [<loader>] \
 *          --install-dir=. --download-server
 *
 *  - **`--install-dir=.` is not optional.** Without it the installer creates a
 *    `server/` *subdirectory* and installs there, which would bury the server one
 *    level below its own `mctl.json`.
 *  - **`--download-server` is what fetches Minecraft itself.** Unlike Fabric's
 *    launcher, which downloads the game on first boot, Quilt's installer does it
 *    at install time — so a Quilt server is complete on disk when the install
 *    finishes.
 *  - The loader version is passed only when the caller asked for one; omitted,
 *    the installer picks its own default, which is a released loader rather than
 *    the newest entry in meta (which is routinely a beta).
 *
 * It produces `quilt-server-launch.jar`, `server.jar` and `libraries/`.
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

const logger = log("provider:quilt");

const QUILT_BASE = "https://meta.quiltmc.org/v3";

/** `/versions/game` — Minecraft versions Quilt has mappings for. */
const GameVersions = z.array(
	z.looseObject({ version: z.string().min(1), stable: z.boolean() }),
);

/** `/versions/loader/<game>` — loader builds for one Minecraft version. */
const LoaderVersions = z.array(
	z.looseObject({
		loader: z.looseObject({ version: z.string().min(1) }),
	}),
);

/** `/versions/installer` — the installer jar MCTL downloads and runs. */
const InstallerVersions = z.array(
	z.looseObject({
		version: z.string().min(1),
		url: z.url(),
		file_size: z.number().int().nonnegative().optional(),
		hashes: z.looseObject({ sha256: z.string().optional() }).optional(),
	}),
);

/** What the installer generates and what the server is launched from. */
const SERVER_JAR = "quilt-server-launch.jar";

/** Quilt spells its pre-release loaders into the version string. */
function isPrerelease(version: string): boolean {
	return /-(beta|alpha|rc|pre)/i.test(version);
}

export class QuiltProvider implements ServerProvider {
	readonly id = "quilt";
	readonly displayName = "Quilt";

	/** Every Minecraft version Quilt supports, newest first. */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const versions = GameVersions.parse(
			await fetchJson(`${QUILT_BASE}/versions/game`),
		);
		return versions.map((v) => ({
			id: v.version,
			type: v.stable ? "release" : "snapshot",
		}));
	}

	/** Loader builds for a Minecraft version, newest first. */
	async loaderVersions(minecraftVersion: string): Promise<LoaderVersion[]> {
		const loaders = await this.#loaders(minecraftVersion);
		return loaders.map((entry) => ({
			version: entry.loader.version,
			stable: !isPrerelease(entry.loader.version),
		}));
	}

	/**
	 * Minecraft's own requirement. Quilt declares nothing of its own — it runs
	 * inside the Minecraft server, so the game's floor is the loader's floor
	 * (plan.md § Java Manager).
	 */
	async javaRequirement(
		minecraftVersion: string,
	): Promise<JavaRequirement | null> {
		return mojangJavaRequirement(minecraftVersion, this.id);
	}

	/** Download the newest installer and run it against the staging directory. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		// Resolved first so an unsupported Minecraft version fails before anything is
		// downloaded, rather than as an installer stack trace minutes later.
		const loaders = await this.#loaders(request.minecraftVersion);
		if (
			request.loaderVersion &&
			!loaders.some((l) => l.loader.version === request.loaderVersion)
		) {
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				`Quilt loader ${request.loaderVersion} does not support this Minecraft version`,
			);
		}

		const installer = await this.#installer();
		const args = [
			"install",
			"server",
			request.minecraftVersion,
			...(request.loaderVersion ? [request.loaderVersion] : []),
			"--install-dir=.",
			"--download-server",
		];
		logger.info(
			{
				minecraftVersion: request.minecraftVersion,
				loaderVersion: request.loaderVersion,
				installer: installer.version,
			},
			"resolved Quilt installer",
		);
		return {
			kind: "installer",
			url: installer.url,
			dest: "quilt-installer.jar",
			sha256: installer.hashes?.sha256,
			size: installer.file_size,
			args,
			produces: { kind: "jar", jar: SERVER_JAR },
			cleanup: ["quilt-installer.jar"],
		};
	}

	/** `java -jar quilt-server-launch.jar nogui`. */
	launchSpec(): LaunchSpec {
		return { kind: "jar", jar: SERVER_JAR };
	}

	/** Loader builds for a version; an empty list means "not supported". */
	async #loaders(
		minecraftVersion: string,
	): Promise<z.infer<typeof LoaderVersions>> {
		const loaders = LoaderVersions.parse(
			await fetchJson(
				`${QUILT_BASE}/versions/loader/${encodeURIComponent(minecraftVersion)}`,
			),
		);
		if (loaders.length === 0) {
			throw new VersionNotFoundError(
				this.id,
				minecraftVersion,
				"Quilt does not support this Minecraft version",
			);
		}
		return loaders;
	}

	/** The newest installer release. */
	async #installer(): Promise<z.infer<typeof InstallerVersions>[number]> {
		const installers = InstallerVersions.parse(
			await fetchJson(`${QUILT_BASE}/versions/installer`),
		);
		const chosen = installers[0];
		if (!chosen) {
			throw new VersionNotFoundError(
				this.id,
				"installer",
				"Quilt publishes no installer versions",
			);
		}
		return chosen;
	}
}
