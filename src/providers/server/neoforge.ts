/**
 * NeoForgeProvider — NeoForge, the community fork of Forge.
 *
 * A concrete provider: `lib/`, `types/`, the shared `mojang-meta.ts` client and
 * the two-function `forge-common.ts`; it imports no other provider — notably not
 * `ForgeProvider`, which it resembles only superficially.
 *
 * **Upstream shape — one Reposilite endpoint.**
 *
 *  - `GET https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge`
 *      → `{ versions: [...] }`, **oldest first**.
 *  - Installer jar:
 *      `https://maven.neoforged.net/releases/net/neoforged/neoforge/<v>/neoforge-<v>-installer.jar`
 *
 * **The version string encodes the Minecraft version, and the encoding changed.**
 * NeoForge publishes no mapping table; the Minecraft version is derived from its
 * own version number, in one of two schemes (both verified against the live
 * list):
 *
 * | NeoForge | Minecraft | Scheme |
 * |---|---|---|
 * | `21.1.248` | `1.21.1`  | three parts: `1.<major>.<minor>`, a `0` minor dropped (`21.0.x` → `1.21`) |
 * | `26.1.2.95` | `26.1.2` | four parts: Minecraft's own calendar version, a `0` patch dropped (`26.2.0.59` → `26.2`) |
 *
 * The four-part scheme arrived when Minecraft moved to calendar versioning at
 * 26.1. Suffixes (`-beta`, `-alpha.1+snapshot-7`) are stripped before parsing and
 * mark the build as unstable.
 *
 * **Not covered: Minecraft 1.20.1.** NeoForge's first release for it was
 * published under the *`net/neoforged/forge`* artefact with a Forge-style
 * version, and a second code path for one legacy version is not worth its bugs —
 * `mctl create --kind forge --mc 1.20.1` is the answer there.
 *
 * Like Forge, 1.17+ installs ship no runnable jar: the installer generates
 * `libraries/net/neoforged/neoforge/<version>/unix_args.txt`, and every NeoForge
 * version is 1.20.2 or later, so the launch spec is **always** an argfile. It is
 * verified after installation by `core/server/install.ts`, which falls back to
 * the generated `run.sh` if that path ever moves.
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
import { argFileName } from "./forge-common.ts";

const logger = log("provider:neoforge");

const MAVEN_BASE = "https://maven.neoforged.net";
const VERSIONS_URL = `${MAVEN_BASE}/api/maven/versions/releases/net/neoforged/neoforge`;

/** Reposilite's version listing for one artefact. */
const MavenVersions = z.looseObject({ versions: z.array(z.string().min(1)) });

/** A NeoForge build, with the Minecraft version decoded out of its name. */
interface NeoBuild {
	/** Full version string as published, suffix included. */
	version: string;
	/** Minecraft version it targets. */
	minecraft: string;
	/** False for `-beta` / `-alpha` builds. */
	stable: boolean;
}

/**
 * Decode a NeoForge version into the Minecraft version it targets.
 *
 * Returns `undefined` for anything that does not parse — the live list contains
 * April Fools' oddities like `0.25w14craftmine.3-beta`, and one unparseable
 * entry must not break the version listing.
 */
export function decodeNeoVersion(version: string): NeoBuild | undefined {
	// `-beta`, `-alpha.1+snapshot-7`: everything from the first `-` is a channel
	// marker, not part of the numbering.
	const suffix = version.indexOf("-");
	const core = suffix === -1 ? version : version.slice(0, suffix);
	const parts = core.split(".");
	if (parts.some((part) => !/^\d+$/.test(part))) return undefined;

	const numbers = parts.map((part) => Number.parseInt(part, 10));
	let minecraft: string;
	if (numbers.length === 3) {
		// Pre-calendar: `21.1.248` → Minecraft 1.21.1, `21.0.x` → 1.21.
		const [major, minor] = numbers as [number, number, number];
		minecraft = minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
	} else if (numbers.length === 4) {
		// Calendar (Minecraft 26.1+): `26.1.2.95` → 26.1.2, `26.2.0.59` → 26.2.
		const [year, month, patch] = numbers as [number, number, number, number];
		minecraft = patch === 0 ? `${year}.${month}` : `${year}.${month}.${patch}`;
	} else {
		return undefined;
	}
	return { version, minecraft, stable: suffix === -1 };
}

export class NeoForgeProvider implements ServerProvider {
	readonly id = "neoforge";
	readonly displayName = "NeoForge";

	/** Every Minecraft version NeoForge builds for, newest first. */
	async minecraftVersions(): Promise<VersionInfo[]> {
		const seen = new Set<string>();
		for (const build of await this.#builds()) seen.add(build.minecraft);
		// Upstream is oldest-first and every NeoForge target is a Minecraft release.
		return [...seen].reverse().map((id) => ({ id, type: "release" as const }));
	}

	/** NeoForge builds for one Minecraft version, newest first. */
	async loaderVersions(minecraftVersion: string): Promise<LoaderVersion[]> {
		const builds = await this.#buildsFor(minecraftVersion);
		return builds
			.map((build) => ({ version: build.version, stable: build.stable }))
			.reverse();
	}

	/**
	 * Minecraft's own requirement — NeoForge declares none, and runs inside the
	 * Minecraft server (plan.md § Java Manager).
	 */
	async javaRequirement(
		minecraftVersion: string,
	): Promise<JavaRequirement | null> {
		return mojangJavaRequirement(minecraftVersion, this.id);
	}

	/** Download the installer and run `--installServer` in the staging directory. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		const builds = await this.#buildsFor(request.minecraftVersion);
		const chosen = request.loaderVersion
			? builds.find((b) => b.version === request.loaderVersion)
			: // Newest stable, else newest at all: a Minecraft version whose NeoForge
				// support is still in beta has nothing else to offer.
				([...builds].reverse().find((b) => b.stable) ??
				builds[builds.length - 1]);
		if (!chosen) {
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				`NeoForge ${request.loaderVersion} is not published for this Minecraft version`,
			);
		}

		logger.info(
			{ minecraftVersion: request.minecraftVersion, neoforge: chosen.version },
			"resolved NeoForge build",
		);
		const jar = `neoforge-${chosen.version}-installer.jar`;
		return {
			kind: "installer",
			url: `${MAVEN_BASE}/releases/net/neoforged/neoforge/${chosen.version}/${jar}`,
			dest: "neoforge-installer.jar",
			args: ["--installServer"],
			produces: {
				kind: "argFile",
				files: [
					`libraries/net/neoforged/neoforge/${chosen.version}/${argFileName()}`,
				],
			},
			cleanup: ["neoforge-installer.jar", "neoforge-installer.jar.log"],
		};
	}

	/**
	 * Recorded in `mctl.json` at create time, so this is reached only for a server
	 * whose file predates that. The argfile path embeds the NeoForge version and
	 * cannot be rebuilt from `dir` alone, so the fallback is the generated script.
	 */
	launchSpec(): LaunchSpec {
		return { kind: "script", path: "run.sh", jvmArgsFile: "user_jvm_args.txt" };
	}

	/** Every decodable build, oldest first as upstream returns them. */
	async #builds(): Promise<NeoBuild[]> {
		const { versions } = MavenVersions.parse(await fetchJson(VERSIONS_URL));
		const builds: NeoBuild[] = [];
		for (const version of versions) {
			const build = decodeNeoVersion(version);
			if (build) builds.push(build);
		}
		return builds;
	}

	/** Builds targeting one Minecraft version, oldest first. */
	async #buildsFor(minecraftVersion: string): Promise<NeoBuild[]> {
		const builds = (await this.#builds()).filter(
			(build) => build.minecraft === minecraftVersion,
		);
		if (builds.length === 0) {
			throw new VersionNotFoundError(
				this.id,
				minecraftVersion,
				"NeoForge publishes no builds for this Minecraft version" +
					(minecraftVersion === "1.20.1"
						? " (its 1.20.1 builds are published as Forge — use --kind forge)"
						: ""),
			);
		}
		return builds;
	}
}
