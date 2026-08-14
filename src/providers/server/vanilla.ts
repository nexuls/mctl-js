/**
 * VanillaProvider — Mojang's official server jar.
 *
 * A concrete provider: it may depend on `lib/`, on the interfaces in `types/`,
 * and on the shared upstream client `mojang-meta.ts`, but never on another
 * provider or on anything from `app/`, `cli/`, or `hooks/` (AGENTS.md § 3).
 *
 * The Mojang endpoints, their quirks, and the Java-requirement rule all live in
 * `mojang-meta.ts`, because four other providers need them too — a Fabric server
 * runs Minecraft's own jar and therefore needs Minecraft's own Java version.
 *
 * One quirk still worth stating here: **`downloads.server` is absent for old
 * versions.** Mojang only began publishing a server jar at 1.2.5, so anything
 * older resolves to an error rather than a broken install.
 */

import type {
	InstallRequest,
	InstallStrategy,
	LaunchSpec,
	LoaderVersion,
	VersionInfo,
} from "../../types/install.ts";
import type { JavaRequirement } from "../../types/java.ts";
import type { ServerProvider } from "../../types/provider.ts";
import {
	mojangJavaRequirement,
	mojangVersionPackage,
	mojangVersions,
	VersionNotFoundError,
} from "./mojang-meta.ts";

export { VersionNotFoundError } from "./mojang-meta.ts";

export class VanillaProvider implements ServerProvider {
	readonly id = "vanilla";
	readonly displayName = "Vanilla";
	readonly description = "Mojang's official server — no plugins, no mods";
	// Mojang's server loads no third-party code at all; a datapack is data the
	// game itself reads, which is why it is the one thing it does take.
	readonly content = { mods: false, plugins: false, datapacks: true };

	/** Every Minecraft version Mojang publishes, newest first. */
	async minecraftVersions(): Promise<VersionInfo[]> {
		return mojangVersions();
	}

	/** Vanilla has no loader. Not an error — an empty list is the honest answer. */
	async loaderVersions(): Promise<LoaderVersion[]> {
		return [];
	}

	/** `javaVersion.majorVersion` from the per-version package JSON, as a `min`. */
	async javaRequirement(
		minecraftVersion: string,
	): Promise<JavaRequirement | null> {
		return mojangJavaRequirement(minecraftVersion, this.id);
	}

	/** One runnable jar, verified by the SHA-1 Mojang publishes alongside it. */
	async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
		const pkg = await mojangVersionPackage(request.minecraftVersion, this.id);
		const server = pkg.downloads.server;
		if (!server) {
			// Versions before 1.2.5 have a client but no published server jar.
			throw new VersionNotFoundError(
				this.id,
				request.minecraftVersion,
				"Mojang publishes no server jar for this version",
			);
		}
		return {
			kind: "directJar",
			url: server.url,
			sha1: server.sha1,
			size: server.size,
			dest: "server.jar",
		};
	}

	/** `java -jar server.jar nogui`. */
	launchSpec(): LaunchSpec {
		return { kind: "jar", jar: "server.jar" };
	}
}
