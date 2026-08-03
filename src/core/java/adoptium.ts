/**
 * Adoptium (Eclipse Temurin) JDK fetching — the one Java *vendor* MCTL installs
 * from, chosen because it publishes free, redistributable, permanently-archived
 * builds for every LTS on every platform MCTL targets.
 *
 * Core service — no UI, no argv, no provider imports. Depends on `lib/`
 * (http, download, shell, fs, logger).
 *
 * **Upstream shape.**
 *   GET https://api.adoptium.net/v3/assets/latest/<major>/hotspot
 *       ?architecture=<x64|aarch64|…>&image_type=jdk&os=<linux|mac|windows>&vendor=eclipse
 *   → an *array* of assets; each `binary.package` carries `{ link, checksum,
 *     name, size }` and `release_name` is the human version (`jdk-21.0.12+8`).
 *   The array is normally length 1 for a fully-specified query, but Adoptium
 *   does return several when a release has variants — the first is taken.
 *
 * **Extraction quirk.** Every Temurin archive contains exactly one top-level
 * directory (`jdk-21.0.12+8/`), so extraction uses `--strip-components=1` to land
 * `bin/`, `lib/`, `release` directly in the destination. Without it the managed
 * JDK would be one directory deeper than `detect.ts` looks.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { downloadFile, type DownloadProgress } from "../../lib/download.ts";
import { ensureDir } from "../../lib/fs.ts";
import { fetchJson } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { run, which } from "../../lib/shell.ts";
import type { JavaInstallation } from "../../types/java.ts";
import { clearJavaProbeCache, probeJava } from "./detect.ts";

const logger = log("java:adoptium");

const API_BASE = "https://api.adoptium.net/v3";

/** The vendor directory prefix under `$ROOT/java/`, e.g. `temurin-21`. */
const VENDOR = "temurin";

const AdoptiumAsset = z.looseObject({
  release_name: z.string().optional(),
  binary: z.looseObject({
    package: z.looseObject({
      name: z.string().optional(),
      link: z.url(),
      checksum: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
    }),
  }),
  version: z.looseObject({ semver: z.string().optional() }).optional(),
});
const AdoptiumAssets = z.array(AdoptiumAsset);

/** Thrown when Adoptium publishes no build matching this platform + major. */
export class JavaNotAvailableError extends Error {
  constructor(
    readonly major: number,
    detail: string,
  ) {
    super(`no Temurin JDK ${major} for this platform: ${detail}`);
    this.name = "JavaNotAvailableError";
  }
}

/** Thrown when the archive could not be unpacked (no `tar`, or a corrupt file). */
export class JavaExtractError extends Error {
  constructor(message: string) {
    super(`failed to extract JDK archive: ${message}`);
    this.name = "JavaExtractError";
  }
}

/** Map Node's `process.platform` onto Adoptium's `os` parameter. */
function adoptiumOs(): string {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "windows";
    default:
      return process.platform; // linux
  }
}

/** Map Node's `process.arch` onto Adoptium's `architecture` parameter. */
function adoptiumArch(): string {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "aarch64";
    case "arm":
      return "arm";
    case "ppc64":
      return "ppc64le";
    default:
      return process.arch;
  }
}

/** Where a managed JDK of a given major lives under `$ROOT/java/`. */
export function managedJavaHome(javaDir: string, major: number): string {
  return join(javaDir, `${VENDOR}-${major}`);
}

/** A resolved, downloadable Temurin build. */
export interface AdoptiumRelease {
  /** Java major version. */
  major: number;
  /** Upstream release name, e.g. `"jdk-21.0.12+8"`. */
  releaseName: string;
  /** Archive download URL. */
  url: string;
  /** Hex SHA-256 of the archive, when Adoptium publishes one (it always does). */
  sha256?: string;
  /** Archive size in bytes, for progress. */
  size?: number;
  /** Archive filename, used to pick the extraction mode. */
  filename: string;
}

/**
 * Resolve the latest Temurin build of `major` for the current OS/architecture.
 * @throws {JavaNotAvailableError} when Adoptium lists nothing for this platform.
 */
export async function resolveTemurin(major: number): Promise<AdoptiumRelease> {
  const url =
    `${API_BASE}/assets/latest/${major}/hotspot` +
    `?architecture=${adoptiumArch()}&image_type=jdk&os=${adoptiumOs()}&vendor=eclipse`;

  let assets: z.infer<typeof AdoptiumAssets>;
  try {
    assets = AdoptiumAssets.parse(await fetchJson(url));
  } catch (err) {
    throw new JavaNotAvailableError(major, String(err));
  }
  const asset = assets[0];
  if (!asset) {
    throw new JavaNotAvailableError(
      major,
      `Adoptium lists no ${adoptiumOs()}/${adoptiumArch()} build`,
    );
  }

  const pkg = asset.binary.package;
  return {
    major,
    releaseName: asset.release_name ?? `jdk-${major}`,
    url: pkg.link,
    sha256: pkg.checksum,
    size: pkg.size,
    filename: pkg.name ?? pkg.link.split("/").pop() ?? `jdk-${major}.tar.gz`,
  };
}

/** Progress callback shared by download and extraction phases. */
export interface InstallJavaOptions {
  /** Called during the download phase. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Abort the download. */
  signal?: AbortSignal;
}

/**
 * Download and install a Temurin JDK into `<javaDir>/temurin-<major>/`.
 *
 * The archive is fetched into `downloadsDir`, verified against Adoptium's
 * SHA-256, then extracted into a fresh destination directory. An existing
 * managed JDK of the same major is replaced — this is MCTL's own directory
 * under `$ROOT/java/`, never a user's server data, so replacing it is safe
 * (AGENTS.md's "never delete inside a server directory" is about server dirs).
 *
 * @returns the installed JDK, probed for its real version.
 * @throws {JavaNotAvailableError} when no build exists for this platform.
 * @throws {JavaExtractError} when `tar` is missing or the archive is unusable.
 */
export async function installTemurin(
  major: number,
  javaDir: string,
  downloadsDir: string,
  options: InstallJavaOptions = {},
): Promise<JavaInstallation> {
  const release = await resolveTemurin(major);
  const archive = join(downloadsDir, release.filename);

  logger.info({ major, release: release.releaseName }, "downloading JDK");
  await downloadFile(release.url, archive, {
    sha256: release.sha256,
    size: release.size,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  const home = managedJavaHome(javaDir, major);
  // A previous half-extracted install would otherwise merge with the new one.
  await rm(home, { recursive: true, force: true });
  await ensureDir(home);

  const tar = await which(process.platform === "win32" ? "tar.exe" : "tar");
  if (!tar) {
    throw new JavaExtractError(
      "`tar` was not found on PATH (needed to unpack the JDK archive)",
    );
  }
  // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz and .zip with
  // `-xf`, so one invocation covers every platform Adoptium ships for.
  const extract = await run(
    tar,
    ["-xf", archive, "-C", home, "--strip-components=1"],
    { timeoutMs: 10 * 60_000 },
  );
  if (extract.code !== 0) {
    throw new JavaExtractError(extract.stderr.trim() || `tar exited ${extract.code}`);
  }

  // The archive is disposable once unpacked; leaving ~200 MB in downloads/ for
  // every JDK install would quietly grow the data root.
  await rm(archive, { force: true });

  // The probe cache is keyed by executable path, and that path did not exist a
  // moment ago (or held the previous install) — drop it so the new JDK is seen.
  clearJavaProbeCache();
  const installed = await probeJava(
    join(home, "bin", process.platform === "win32" ? "java.exe" : "java"),
    "managed",
  );
  if (!installed) {
    throw new JavaExtractError(
      `extracted archive at ${home} does not contain a working java executable`,
    );
  }
  logger.info({ major, home, version: installed.version }, "installed JDK");
  return installed;
}
