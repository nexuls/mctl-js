/**
 * Java discovery — find every JDK on this machine that MCTL could launch a
 * server with, and report each one's real major version.
 *
 * Core service — no UI, no argv, no provider imports. Depends on `lib/`
 * (shell, fs, paths, logger) and the types in `types/java.ts`.
 *
 * **Why every candidate is probed by running it.** Directory names lie: a folder
 * called `java-17-openjdk` may be a symlink to 21, `$JAVA_HOME` may point at a
 * JRE that was upgraded in place, and `java` on `$PATH` is frequently a wrapper.
 * The only trustworthy answer comes from the JVM itself, so each candidate is
 * asked with:
 *
 *     java -XshowSettings:properties -version
 *
 * which prints `java.version`, `java.vendor` and `java.home` to **stderr** on
 * every JDK from 8 onwards. (`-version` alone is not enough: its banner format
 * has changed across releases, and it does not report `java.home`.)
 *
 * Probes are cheap but not free (~50-150 ms each), so results are memoized per
 * executable path for the lifetime of the process. That is a *derived* cache of
 * an external fact, not authoritative MCTL state — it holds nothing about
 * servers and is rebuilt on the next launch (architecture.md § Statelessness).
 */

import { join } from "node:path";
import { readDirIfExists, pathExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { run, which } from "../../lib/shell.ts";
import type { JavaInstallation, JavaSource } from "../../types/java.ts";

const logger = log("java:detect");

/** How long a single `java -version` probe may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Well-known system locations that hold one directory per JDK. Checked in
 * addition to `$PATH` and `$JAVA_HOME` so a distro-packaged JDK that is not the
 * default `java` is still offered.
 */
const SYSTEM_JDK_DIRS =
  process.platform === "darwin"
    ? ["/Library/Java/JavaVirtualMachines", "/opt/homebrew/opt"]
    : ["/usr/lib/jvm", "/usr/lib64/jvm", "/opt/java"];

/** Probe results keyed by executable path; see the module note on memoization. */
const probeCache = new Map<string, JavaInstallation | undefined>();

/** The `java` executable inside a JDK home, honouring Windows' `.exe`. */
function javaBinary(home: string): string {
  return join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
}

/**
 * Parse a Java version string into its major number.
 *
 * Two eras, both still in the wild:
 *  - **Java 8 and older** report `1.8.0_412` — the major is the *second*
 *    component (8), not the first.
 *  - **Java 9+** report `21.0.12` — the major is the first component.
 */
export function majorOf(version: string): number | undefined {
  const parts = version.trim().split(".");
  const first = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isInteger(first)) return undefined;
  if (first === 1) {
    const second = Number.parseInt(parts[1] ?? "", 10);
    return Number.isInteger(second) ? second : undefined;
  }
  return first;
}

/** Pull `key = value` out of `-XshowSettings:properties` output. */
function property(output: string, key: string): string | undefined {
  // Lines look like `    java.version = 21.0.12` (leading whitespace varies).
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m").exec(output);
  return match?.[1]?.trim();
}

/**
 * Ask one `java` executable what it is. Returns `undefined` when the path is not
 * a working JVM (missing, not executable, or it failed to answer) — a broken
 * candidate is skipped, never fatal, because it is usually just a dangling
 * symlink in `/usr/lib/jvm`.
 *
 * @param javaPath absolute path to a `java` executable.
 * @param source how this candidate was found, recorded on the result.
 */
export async function probeJava(
  javaPath: string,
  source: JavaSource,
): Promise<JavaInstallation | undefined> {
  // `has` rather than a truthiness check: a *failed* probe is memoized as
  // `undefined` and must not be retried on every subsequent lookup.
  if (probeCache.has(javaPath)) return probeCache.get(javaPath);

  let result: JavaInstallation | undefined;
  try {
    const { code, stdout, stderr } = await run(
      javaPath,
      ["-XshowSettings:properties", "-version"],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    // The properties dump goes to stderr on every JDK; stdout is joined in
    // anyway so a future JVM that moves it does not silently break detection.
    const output = `${stderr}\n${stdout}`;
    const version = property(output, "java\\.version");
    const home = property(output, "java\\.home");
    const major = version ? majorOf(version) : undefined;
    if (code === 0 && version && home && major !== undefined) {
      result = {
        major,
        version,
        javaPath,
        home,
        source,
        vendor: property(output, "java\\.vendor"),
      };
    } else {
      logger.debug({ javaPath, code }, "candidate did not report a usable version");
    }
  } catch (err) {
    logger.debug({ javaPath, err: String(err) }, "java probe failed");
  }

  probeCache.set(javaPath, result);
  return result;
}

/**
 * Discover every usable Java installation, newest major first.
 *
 * Sources, in the order they are collected (which is also the precedence order
 * when two entries share a `java.home` — the first one collected wins, so an
 * MCTL-managed JDK is reported as `managed` rather than as a `system` duplicate):
 *
 *  1. `managed`  — `<javaDir>/<vendor>-<major>/`, installed by MCTL itself.
 *  2. `javaHome` — `$JAVA_HOME`.
 *  3. `path`     — `java` on `$PATH`.
 *  4. `system`   — one directory per JDK under the platform's usual locations.
 *
 * @param javaDir `$ROOT/java` from the loaded config; omit to skip managed JDKs
 *   (a caller with no config yet, e.g. `mctl java list` before `mctl init`).
 */
export async function detectJavaInstallations(
  javaDir?: string,
): Promise<JavaInstallation[]> {
  const candidates: Array<{ javaPath: string; source: JavaSource }> = [];

  if (javaDir) {
    for (const name of await readDirIfExists(javaDir)) {
      candidates.push({ javaPath: javaBinary(join(javaDir, name)), source: "managed" });
    }
  }

  const javaHome = process.env.JAVA_HOME;
  if (javaHome) candidates.push({ javaPath: javaBinary(javaHome), source: "javaHome" });

  const onPath = await which(process.platform === "win32" ? "java.exe" : "java");
  if (onPath) candidates.push({ javaPath: onPath, source: "path" });

  for (const dir of SYSTEM_JDK_DIRS) {
    for (const name of await readDirIfExists(dir)) {
      const home = join(dir, name);
      // macOS bundles wrap the JDK one level deeper.
      const bundled = join(home, "Contents", "Home");
      candidates.push({
        javaPath: javaBinary((await pathExists(bundled)) ? bundled : home),
        source: "system",
      });
    }
  }

  const byHome = new Map<string, JavaInstallation>();
  for (const candidate of candidates) {
    const found = await probeJava(candidate.javaPath, candidate.source);
    if (!found) continue;
    // First writer wins, so the precedence order above holds.
    if (!byHome.has(found.home)) byHome.set(found.home, found);
  }

  const installations = [...byHome.values()].sort((a, b) => b.major - a.major);
  logger.debug(
    { count: installations.length, majors: installations.map((i) => i.major) },
    "detected java installations",
  );
  return installations;
}

/** Drop the memoized probe results — used by tests and after a JDK install. */
export function clearJavaProbeCache(): void {
  probeCache.clear();
}
