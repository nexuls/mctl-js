/**
 * Types for Java discovery, requirements, and resolution (plan.md § Java
 * Manager). No I/O and no UI — detection, selection, and Adoptium downloads
 * live in `core/java/`.
 *
 * The domain fact these encode: **a Minecraft server declares a Java version
 * range, not a version.** Mojang's per-version JSON gives a single
 * `javaVersion.majorVersion` (a floor in practice); PaperMC's v3 API gives an
 * explicit minimum and sometimes a maximum. MCTL turns those into a
 * {@link JavaRequirement} and picks the best JDK it has (or can fetch) inside it.
 */

import { z } from "zod";

/**
 * The Java major-version window a server kind declares. `min` is required
 * because every source we consult states at least a floor; `max` is present only
 * when upstream declares an upper bound (PaperMC does for some versions).
 *
 * A `null` requirement from a provider means *upstream said nothing* — that is
 * the one case where MCTL must ask the user and then pin the answer, never
 * guess (plan.md § Java Manager, "Fallback").
 */
export interface JavaRequirement {
  /** Lowest acceptable Java major version. */
  min: number;
  /** Highest acceptable Java major version, when upstream declares one. */
  max?: number;
  /** Upstream's recommended major, when it names one. */
  recommended?: number;
}

/**
 * The LTS majors MCTL is willing to select and to fetch, newest first. Used both
 * as the preference order and as the implicit ceiling when a requirement has no
 * `max`: *unbounded* is not the same as *"tested on the newest JDK in existence"*,
 * so an open-ended requirement resolves to the newest LTS we know how to install,
 * not to whatever happens to be on the machine.
 */
export const LTS_MAJORS = [25, 21, 17, 11, 8] as const;

/** Where a discovered JDK came from — shown in `mctl java list`. */
export const JavaSource = z.enum([
  /** Installed by MCTL under `$ROOT/java/<vendor>-<major>/`. */
  "managed",
  /** Found via `$JAVA_HOME`. */
  "javaHome",
  /** Found as `java` on `$PATH`. */
  "path",
  /** Found by scanning a well-known system location (e.g. `/usr/lib/jvm`). */
  "system",
]);
export type JavaSource = z.infer<typeof JavaSource>;

/** One Java installation MCTL can launch a server with. */
export interface JavaInstallation {
  /** Major version, e.g. `21`. */
  major: number;
  /** Full version string as the JVM reports it, e.g. `"21.0.12"`. */
  version: string;
  /** Absolute path to the `java` executable. */
  javaPath: string;
  /** Absolute path to the JDK/JRE home (the parent of `bin/`). */
  home: string;
  /** Where this installation was discovered. */
  source: JavaSource;
  /** Vendor string when the release metadata names one, e.g. `"Temurin"`. */
  vendor?: string;
}

/**
 * The outcome of resolving a server's Java: which installation to launch with,
 * and why. `requirement` is `undefined` when no upstream source declared one —
 * in that case `installation` comes from an explicit user pin.
 */
export interface JavaResolution {
  /** The JDK to launch with. */
  installation: JavaInstallation;
  /** The declared requirement this satisfies, when upstream declared one. */
  requirement?: JavaRequirement;
  /** True when the choice came from `mctl.json`'s explicit `{ pinned }`. */
  pinned: boolean;
}
