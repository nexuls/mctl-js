/**
 * FabricProvider — the Fabric mod loader.
 *
 * A concrete provider: `lib/`, `types/`, and the shared `mojang-meta.ts` client
 * only; it imports no other provider.
 *
 * **Upstream shape — meta.fabricmc.net v2.** Three endpoints:
 *
 *  - `GET /v2/versions/game`
 *      → `[{ version, stable }, …]`, newest first. `stable: false` marks a
 *        snapshot; Fabric supports snapshots as first-class targets, unlike
 *        Paper.
 *  - `GET /v2/versions/loader/<game>`
 *      → `[{ loader: { version, stable, … }, intermediary, launcherMeta }, …]`,
 *        newest loader first. `launcherMeta.min_java_version` is the loader's own
 *        floor and is folded into the Java requirement below.
 *  - `GET /v2/versions/installer`
 *      → `[{ version, stable, url }, …]`, newest first.
 *
 * **The server jar is generated on demand**, not published:
 *
 *     GET /v2/versions/loader/<game>/<loader>/<installer>/server/jar
 *
 * That endpoint *builds* a launcher jar for the triple and streams it, so there
 * is no digest to verify against — which is precisely what `loaderJar` means as
 * distinct from `directJar`. Two consequences worth knowing:
 *
 *  - **The jar is a launcher, not a server.** On first boot it downloads the
 *    vanilla server jar and the loader's libraries into the server directory. A
 *    Fabric server therefore needs network access the first time it starts, and
 *    its directory looks nearly empty until then.
 *  - The installer version is part of the URL and is *not* the loader version.
 *    MCTL always uses the newest stable installer; it is the tool that builds the
 *    launcher, and an older one buys nothing.
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

const logger = log("provider:fabric");

const FABRIC_BASE = "https://meta.fabricmc.net/v2";

/** `/versions/game` — every Minecraft version Fabric has intermediary for. */
const GameVersions = z.array(
	z.looseObject({ version: z.string().min(1), stable: z.boolean() }),
);

/** `/versions/loader/<game>` — loader builds for one Minecraft version. */
const LoaderVersions = z.array(
	z.looseObject({
		loader: z.looseObject({
			version: z.string().min(1),
			stable: z.boolean().optional(),
		}),
		launcherMeta: z
			.looseObject({ min_java_version: z.number().int().positive().optional() })
			.optional(),
	}),
);

/** `/versions/installer` — the tool that builds a server launcher jar. */
const InstallerVersions = z.array(
	z.looseObject({
		version: z.string().min(1),
		stable: z.boolean().optional(),
		url: z.url().optional(),
	}),
);

/** The launcher jar Fabric's own launch scripts use. */
const SERVER_JAR = "fabric-server-launch.jar";

export class FabricProvider implements ServerProvider {
	readonly id = "fabric";
	readonly displayName = "Fabric";
	readonly description = "Lightweight mod loader — fast to update, needs mods";

	/**
	 * Every Minecraft version Fabric supports, newest first.
	 *
	 * Fabric's `stable` flag maps directly onto our channel: it is false for
	 * Mojang snapshots and for the April Fools' releases, which is exactly what a
	 * user filtering out snapshots wants hidden.
	 */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const versions = GameVersions.parse(
			await fetchJson(`${FABRIC_BASE}/versions/game`),
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
			stable: entry.loader.stable === true,
		}));
	}

	/**
	 * Minecraft's own requirement, raised to the loader's floor when the loader
	 * declares a higher one.
	 *
	 * Fabric publishes no *upper* bound and its `min_java_version` is usually well
	 * below Minecraft's (8, for a game needing 21) — it describes the loader's own
	 * bytecode, not the game's. Taking the maximum of the two is therefore almost
	 * always Minecraft's answer, and is correct in the rare case it is not.
	 */
	async javaRequirement(
		minecraftVersion: string,
		loaderVersion?: string,
	): Promise<JavaRequirement | null> {
		const game = await mojangJavaRequirement(minecraftVersion, this.id);
		const loaders = await this.#loaders(minecraftVersion);
		const entry = loaderVersion
			? loaders.find((l) => l.loader.version === loaderVersion)
			: loaders[0];
		const loaderMin = entry?.launcherMeta?.min_java_version;
		if (!game)
			return loaderMin ? { min: loaderMin, recommended: loaderMin } : null;
		if (!loaderMin || loaderMin <= game.min) return game;
		return { min: loaderMin, max: game.max, recommended: loaderMin };
	}

	/** The generated launcher jar for (game, loader, installer). */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		const loaders = await this.#loaders(request.minecraftVersion);
		const loader = request.loaderVersion
			? loaders.find((l) => l.loader.version === request.loaderVersion)
			: // Newest first, and Fabric ships stable loaders far more often than not;
				// preferring a stable build when one exists avoids handing a user a beta
				// loader just because it is newer.
				(loaders.find((l) => l.loader.stable) ?? loaders[0]);
		if (!loader) {
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				request.loaderVersion
					? `Fabric loader ${request.loaderVersion} does not support this Minecraft version`
					: "Fabric publishes no loader for this Minecraft version",
			);
		}

		const installer = await this.#installer();
		const url =
			`${FABRIC_BASE}/versions/loader/${encodeURIComponent(request.minecraftVersion)}` +
			`/${encodeURIComponent(loader.loader.version)}/${encodeURIComponent(installer)}/server/jar`;
		logger.info(
			{
				minecraftVersion: request.minecraftVersion,
				loader: loader.loader.version,
				installer,
			},
			"resolved Fabric launcher",
		);
		return { kind: "loaderJar", url, dest: SERVER_JAR };
	}

	/** `java -jar fabric-server-launch.jar nogui`. */
	launchSpec(): LaunchSpec {
		return { kind: "jar", jar: SERVER_JAR };
	}

	/** Loader builds for a version, mapping "no builds" to a typed error. */
	async #loaders(
		minecraftVersion: string,
	): Promise<z.infer<typeof LoaderVersions>> {
		const loaders = LoaderVersions.parse(
			await fetchJson(
				`${FABRIC_BASE}/versions/loader/${encodeURIComponent(minecraftVersion)}`,
			),
		);
		if (loaders.length === 0) {
			// Fabric answers `[]` rather than 404 for an unknown or unsupported game
			// version, so an empty list is the only signal there is.
			throw new VersionNotFoundError(
				this.id,
				minecraftVersion,
				"Fabric does not support this Minecraft version",
			);
		}
		return loaders;
	}

	/** The newest stable installer version — the tool, not the loader. */
	async #installer(): Promise<string> {
		const installers = InstallerVersions.parse(
			await fetchJson(`${FABRIC_BASE}/versions/installer`),
		);
		const chosen = installers.find((i) => i.stable) ?? installers[0];
		if (!chosen) {
			throw new VersionNotFoundError(
				this.id,
				"installer",
				"Fabric publishes no installer versions",
			);
		}
		return chosen.version;
	}
}
