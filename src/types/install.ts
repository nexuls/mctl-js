/**
 * Types describing **how a server is installed and how it is launched** — the
 * two things that differ genuinely between server kinds and which therefore must
 * not hide inside a single `install()` branch (plan.md § Design Principles #4).
 *
 * No I/O, no UI, no provider imports: this module only *describes* shapes. The
 * concrete strategies are produced by `ServerProvider.resolveInstall()` in
 * `providers/server/` and executed by `core/server/install.ts`.
 *
 * **Scope note.** Phase 2 ships only the `directJar` strategy (Vanilla, Paper)
 * and the `jar` launch spec. The unions are deliberately tagged so Phase 3's
 * `loaderJar` (Fabric/Quilt), `installer` (Forge/NeoForge → `argFile`/`script`)
 * and `buildFromSource` (Spigot) are additive — every consumer already switches
 * on `kind` and will fail to compile rather than silently mishandle a new member.
 * See plan.md § Server Installation for the full target union.
 */

/**
 * One published Minecraft (or server-kind) version a provider can install.
 * A flat view model — the UI picks from these and never sees provider types.
 */
export interface VersionInfo {
  /** Version id as the upstream API spells it, e.g. `"1.21.4"`. */
  id: string;
  /** Release channel. `other` covers upstream values we don't model (old betas). */
  type: "release" | "snapshot" | "other";
  /** ISO-8601 publish time, when upstream reports one. */
  releaseTime?: string;
}

/** A loader build (Fabric/Forge/…) for a given Minecraft version. Phase 3. */
export interface LoaderVersion {
  /** Loader version string. */
  version: string;
  /** Whether upstream marks this build stable/recommended. */
  stable: boolean;
}

/** What the caller wants installed; handed to `ServerProvider.resolveInstall()`. */
export interface InstallRequest {
  /** Target Minecraft version. */
  minecraftVersion: string;
  /** Loader version, for kinds that have one. Absent ⇒ provider picks latest. */
  loaderVersion?: string;
  /**
   * Directory the install writes into. During a create this is the **staging**
   * directory, not the final server directory — the tree is moved into place
   * only after the whole install succeeds.
   */
  dir: string;
}

/**
 * How to obtain a server's runnable files.
 *
 * Members are added per roadmap phase; each carries only what its executor needs
 * so the executor never has to consult the provider again mid-install.
 */
export type InstallStrategy = {
  /**
   * Download exactly one directly-runnable jar. Vanilla, Paper, Purpur and
   * Velocity all publish such a jar, so nothing has to be executed at install
   * time — the download *is* the install.
   */
  kind: "directJar";
  /** Absolute URL of the jar. */
  url: string;
  /** Hex SHA-256 digest, when upstream publishes one (PaperMC does). */
  sha256?: string;
  /**
   * Hex SHA-1 digest, when upstream publishes one instead (Mojang's piston-meta
   * publishes SHA-1 only). Checked when `sha256` is absent.
   */
  sha1?: string;
  /** Destination path *relative to* {@link InstallRequest.dir}, e.g. `"server.jar"`. */
  dest: string;
  /** Expected size in bytes, when known — lets the UI show a real progress bar. */
  size?: number;
};

/**
 * How to launch an installed server. Phase 2 needs only `jar`; Forge/NeoForge's
 * `argFile` and the generated-`run.sh` `script` form arrive in Phase 3 (plan.md
 * § Server Installation).
 */
export type LaunchSpec = {
  /** `java <jvmArgs> -jar <jar> nogui` — the classic runnable-jar launch. */
  kind: "jar";
  /** Jar path relative to the server directory, e.g. `"server.jar"`. */
  jar: string;
};
