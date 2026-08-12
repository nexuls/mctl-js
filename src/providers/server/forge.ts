/**
 * ForgeProvider — Minecraft Forge.
 *
 * A concrete provider: `lib/`, `types/`, and the shared `mojang-meta.ts` client
 * only; it imports no other provider.
 *
 * **Upstream shape — a Maven repository, not an API.** Forge publishes no
 * versions endpoint. Its maven is Reposilite, whose HTTP API is used instead of
 * parsing `maven-metadata.xml`:
 *
 *  - `GET https://maven.minecraftforge.net/api/maven/versions/releases/net/minecraftforge/forge`
 *      → `{ versions: ["1.21.4-54.1.0", …] }` — **oldest first**, and every entry
 *        is the pair `<minecraft>-<forge>` joined by a hyphen. That composite is
 *        the artefact's Maven version, so it is also the directory name below.
 *  - `GET https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`
 *      → `{ promos: { "1.21.4-latest": "54.1.0", "1.21.4-recommended": …, … } }` —
 *        Forge's own notion of which build to use. `recommended` lags `latest` by
 *        weeks and is absent for recent versions, so `latest` is the fallback.
 *  - Installer jar:
 *      `…/forge/<mc>-<forge>/forge-<mc>-<forge>-installer.jar`
 *
 * **Forge 1.17+ ships no runnable jar at all.** `--installServer` generates a
 * `libraries/` tree plus `run.sh`, `user_jvm_args.txt` and an `@argfile` at
 * `libraries/net/minecraftforge/forge/<mc>-<forge>/unix_args.txt`. Launching the
 * *installer* jar directly — the obvious mistake — silently re-runs the installer
 * instead of starting a server, which is why this provider states an `argFile`
 * launch spec rather than a jar. Pre-1.17 Forge does produce a runnable
 * `forge-<mc>-<forge>.jar`, and the version cutoff is handled below.
 *
 * The predicted argfile path is **verified after the install** by
 * `core/server/install.ts`, which falls back to the generated `run.sh` if Forge
 * ever moves it.
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
import { argFileName, compareMinecraftVersions } from "./forge-common.ts";

const logger = log("provider:forge");

const MAVEN_BASE = "https://maven.minecraftforge.net";
const VERSIONS_URL = `${MAVEN_BASE}/api/maven/versions/releases/net/minecraftforge/forge`;
const PROMOTIONS_URL =
	"https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

/** Reposilite's version listing for one artefact. */
const MavenVersions = z.looseObject({ versions: z.array(z.string().min(1)) });

/** Forge's promotion index: `"<mc>-latest"` / `"<mc>-recommended"` → forge version. */
const Promotions = z.looseObject({
	promos: z.record(z.string(), z.string()),
});

/**
 * The first Minecraft version whose Forge install has no runnable jar and must
 * be launched through an argfile. 1.17 is where Forge adopted the modular JVM
 * launch; everything before it produces `forge-<mc>-<forge>.jar`.
 */
const ARGFILE_FROM = "1.17";

export class ForgeProvider implements ServerProvider {
	readonly id = "forge";
	readonly displayName = "Forge";

	/**
	 * Every Minecraft version Forge builds for, newest first.
	 *
	 * Derived by splitting the composite Maven versions — Forge has no version
	 * list of its own — and de-duplicating. Reposilite returns oldest-first, so
	 * the result is reversed to match every other provider.
	 */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const seen = new Set<string>();
		for (const composite of await this.#versions()) {
			const mc = splitComposite(composite)?.minecraft;
			if (mc) seen.add(mc);
		}
		// Forge only ever builds for releases, so everything here is a release.
		return [...seen].reverse().map((id) => ({ id, type: "release" as const }));
	}

	/** Forge builds for one Minecraft version, newest first. */
	async loaderVersions(minecraftVersion: string): Promise<LoaderVersion[]> {
		const promos = await this.#promotions();
		const recommended = promos[`${minecraftVersion}-recommended`];
		const builds = await this.#buildsFor(minecraftVersion);
		return builds
			.map((forge) => ({ version: forge, stable: forge === recommended }))
			.reverse();
	}

	/**
	 * Minecraft's own requirement — Forge declares none. It runs inside the
	 * Minecraft server, so the game's floor is Forge's floor (plan.md § Java
	 * Manager, "Forge / NeoForge: no declaration → Vanilla requirement").
	 */
	async javaRequirement(
		minecraftVersion: string,
	): Promise<JavaRequirement | null> {
		return mojangJavaRequirement(minecraftVersion, this.id);
	}

	/** Download the installer and run `--installServer` in the staging directory. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		const forge =
			request.loaderVersion ??
			(await this.#preferredBuild(request.minecraftVersion));
		const builds = await this.#buildsFor(request.minecraftVersion);
		if (!builds.includes(forge)) {
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				`Forge ${forge} is not published for this Minecraft version`,
			);
		}

		const composite = `${request.minecraftVersion}-${forge}`;
		const jar = `forge-${composite}-installer.jar`;
		logger.info(
			{ minecraftVersion: request.minecraftVersion, forge },
			"resolved Forge build",
		);
		return {
			kind: "installer",
			url: `${MAVEN_BASE}/net/minecraftforge/forge/${composite}/${jar}`,
			dest: "forge-installer.jar",
			args: ["--installServer"],
			produces: producedLaunch(request.minecraftVersion, composite),
			// The installer writes its log beside itself; both are noise in a server
			// directory once the install has been verified.
			cleanup: ["forge-installer.jar", "forge-installer.jar.log"],
		};
	}

	/**
	 * The launch spec is **recorded in `mctl.json` at create time**, so this is
	 * only ever reached for a server whose file predates that or was hand-written.
	 * The argfile path cannot be rebuilt from `dir` alone (it embeds the loader
	 * version), so the honest answer is the generated script, which needs nothing
	 * but its own name.
	 */
	launchSpec(): LaunchSpec {
		return { kind: "script", path: "run.sh", jvmArgsFile: "user_jvm_args.txt" };
	}

	/** Every `<mc>-<forge>` Maven version, oldest first as upstream returns them. */
	async #versions(): Promise<string[]> {
		return MavenVersions.parse(await fetchJson(VERSIONS_URL)).versions;
	}

	/** Forge versions published for one Minecraft version, oldest first. */
	async #buildsFor(minecraftVersion: string): Promise<string[]> {
		const builds: string[] = [];
		for (const composite of await this.#versions()) {
			const parts = splitComposite(composite);
			if (parts?.minecraft === minecraftVersion) builds.push(parts.forge);
		}
		if (builds.length === 0) {
			throw new VersionNotFoundError(
				this.id,
				minecraftVersion,
				"Forge publishes no builds for this Minecraft version",
			);
		}
		return builds;
	}

	/** Forge's promotion index, or `{}` when the file is unreachable. */
	async #promotions(): Promise<Record<string, string>> {
		try {
			return Promotions.parse(await fetchJson(PROMOTIONS_URL)).promos;
		} catch (err) {
			// A promotion is a *preference*; losing it costs the recommended-build
			// nicety, not the install. Falling back to the newest Maven build is
			// strictly better than failing the create.
			logger.warn(
				{ err: String(err) },
				"could not read Forge promotions; using the newest build",
			);
			return {};
		}
	}

	/**
	 * Which build to install when the caller named none: Forge's own
	 * *recommended*, then its *latest*, then the newest thing on Maven.
	 * Recommended is preferred because it is the build Forge tells mod authors to
	 * target, and a modded server that cannot load its mods is worse than an old
	 * one.
	 */
	async #preferredBuild(minecraftVersion: string): Promise<string> {
		const promos = await this.#promotions();
		const promoted =
			promos[`${minecraftVersion}-recommended`] ??
			promos[`${minecraftVersion}-latest`];
		const builds = await this.#buildsFor(minecraftVersion);
		if (promoted && builds.includes(promoted)) return promoted;
		return builds[builds.length - 1] as string;
	}
}

/** Split a `<minecraft>-<forge>` Maven version. */
function splitComposite(
	composite: string,
): { minecraft: string; forge: string } | undefined {
	// Only the *first* hyphen separates the two: Minecraft versions never contain
	// one, while Forge's do (`54.1.0-beta`), and some old entries carry a trailing
	// branch suffix that belongs to the Forge half.
	const at = composite.indexOf("-");
	if (at <= 0 || at === composite.length - 1) return undefined;
	return {
		minecraft: composite.slice(0, at),
		forge: composite.slice(at + 1),
	};
}

/** The launch spec a Forge install of this version will produce. */
function producedLaunch(
	minecraftVersion: string,
	composite: string,
): LaunchSpec {
	if (compareMinecraftVersions(minecraftVersion, ARGFILE_FROM) < 0) {
		// Pre-1.17 Forge installs a runnable universal jar named after the pair.
		return { kind: "jar", jar: `forge-${composite}.jar` };
	}
	return {
		kind: "argFile",
		files: [`libraries/net/minecraftforge/forge/${composite}/${argFileName()}`],
	};
}
