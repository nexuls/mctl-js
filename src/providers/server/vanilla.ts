/**
 * VanillaProvider — Mojang's official server jar.
 *
 * A concrete provider: it may depend on `lib/` and on the interfaces in
 * `types/`, but it must never import another provider or anything from `app/`,
 * `cli/`, or `hooks/` (AGENTS.md § 3).
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
 * Two quirks worth knowing:
 *  - **`downloads.server` is absent for old versions.** Mojang only began
 *     publishing a server jar at 1.2.5; anything older resolves to an error
 *     rather than a broken install.
 *  - **`javaVersion` is a floor, not a range.** Mojang states the runtime it
 *     ships, with no upper bound, so this provider reports `{ min }` only and
 *     lets `core/java/` apply MCTL's own LTS ceiling.
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

const logger = log("provider:vanilla");

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

export class VanillaProvider implements ServerProvider {
  readonly id = "vanilla";
  readonly displayName = "Vanilla";

  /**
   * Every Minecraft version Mojang publishes. The manifest is already sorted
   * newest-first and that order is preserved — it is the order the launcher
   * itself shows.
   */
  async minecraftVersions(): Promise<VersionInfo[]> {
    const manifest = VersionManifest.parse(await fetchJson(VERSION_MANIFEST_URL));
    return manifest.versions.map((v) => ({
      id: v.id,
      type: channelOf(v.type),
      releaseTime: v.releaseTime,
    }));
  }

  /** Vanilla has no loader. Not an error — an empty list is the honest answer. */
  async loaderVersions(): Promise<LoaderVersion[]> {
    return [];
  }

  /**
   * `javaVersion.majorVersion` from the per-version package JSON, as a `min`.
   * Returns `null` for versions predating that field (roughly pre-1.17), which
   * is what makes MCTL prompt for a pin rather than assume Java 8.
   */
  async javaRequirement(minecraftVersion: string): Promise<JavaRequirement | null> {
    const pkg = await this.#versionPackage(minecraftVersion);
    const major = pkg.javaVersion?.majorVersion;
    if (major === undefined) {
      logger.info(
        { minecraftVersion },
        "no javaVersion in package JSON; caller must pin",
      );
      return null;
    }
    // No `max`: Mojang declares the runtime it ships, never an upper bound.
    return { min: major, recommended: major };
  }

  /** One runnable jar, verified by the SHA-1 Mojang publishes alongside it. */
  async resolveInstall(request: InstallRequest): Promise<InstallStrategy> {
    const pkg = await this.#versionPackage(request.minecraftVersion);
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

  /**
   * Fetch and validate a version's package JSON, resolving the manifest first.
   * Both requests go through `lib/http.ts`, so the manifest is fetched at most
   * once per TTL window no matter how many versions are inspected.
   */
  async #versionPackage(version: string): Promise<z.infer<typeof VersionPackage>> {
    const manifest = VersionManifest.parse(await fetchJson(VERSION_MANIFEST_URL));
    const entry = manifest.versions.find((v) => v.id === version);
    if (!entry) {
      throw new VersionNotFoundError(this.id, version, "unknown Minecraft version");
    }
    return VersionPackage.parse(await fetchJson(entry.url));
  }
}
