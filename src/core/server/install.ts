/**
 * Install execution — turn an {@link InstallStrategy} (what a `ServerProvider`
 * decided) into files on disk, reporting progress as it goes.
 *
 * Core service — no UI, no argv, **no provider imports**: it receives the
 * strategy as data, which is the whole point of modelling installs as an
 * explicit union. Adding Fabric or Forge in Phase 3 adds a `case` here and
 * changes nothing else.
 *
 * **Staging.** Callers execute into `$ROOT/downloads/staging/<uuid>/` and move
 * the finished tree into place only on success (plan.md § Server Installation).
 * That is why nothing here writes to a final server directory or consults the
 * registry — a failed install must leave no half-built server behind, and the
 * cheapest way to guarantee that is for this module to be unaware of where the
 * files will eventually live.
 */

import { join } from "node:path";
import { formatBytes } from "../../lib/format.ts";
import { downloadFile } from "../../lib/download.ts";
import { ensureDir } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import type { InstallStrategy } from "../../types/install.ts";
import type { JobContext } from "../jobs/index.ts";

const logger = log("install");

/**
 * Execute an install strategy into `dir`.
 *
 * @param strategy what to install, from `ServerProvider.resolveInstall()`.
 * @param dir directory to install into — during a create this is the staging
 *   directory, never the final server directory.
 * @param job optional job handle; progress is reported through it when present.
 * @throws {DownloadError} / {@link ChecksumError} when the artefact cannot be
 *   fetched or does not match its published digest.
 */
export async function executeInstall(
  strategy: InstallStrategy,
  dir: string,
  job?: JobContext,
): Promise<void> {
  await ensureDir(dir);

  switch (strategy.kind) {
    case "directJar": {
      const dest = join(dir, strategy.dest);
      job?.step("Downloading", 0);
      logger.info({ url: strategy.url, dest }, "downloading server jar");
      await downloadFile(strategy.url, dest, {
        sha256: strategy.sha256,
        sha1: strategy.sha1,
        size: strategy.size,
        signal: job?.signal,
        onProgress: (progress) => {
          job?.progress(
            progress.fraction,
            progress.total
              ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
              : formatBytes(progress.received),
          );
        },
      });
      // The digest check inside `downloadFile` *is* the verification step; there
      // is nothing further to run for a directly-runnable jar.
      job?.step("Verifying", 1);
      return;
    }
    default: {
      // Exhaustiveness guard: a Phase-3 strategy added to the union without a
      // case here fails to compile rather than silently installing nothing.
      const never: never = strategy.kind;
      throw new Error(`unsupported install strategy: ${String(never)}`);
    }
  }
}

/** The text Mojang's server writes and re-reads to record EULA acceptance. */
const EULA_CONTENTS = `# Accepted through MCTL (https://www.minecraft.net/eula)
eula=true
`;

/**
 * Write `eula.txt` accepting the Minecraft EULA into a freshly installed server.
 *
 * **Why MCTL writes a second file into a server directory.** The rule is that
 * `mctl.json` is the only file MCTL *owns and rewrites*. `eula.txt` is the
 * server's own file, written **once at create time and only when the user
 * explicitly accepted** (`config.defaults.eula` or `--eula`); MCTL never reads,
 * rewrites, or deletes it afterwards. Without it a fresh server exits on its
 * first launch with "You need to agree to the EULA", which would make an
 * opted-in create useless.
 */
export async function writeEulaAcceptance(dir: string): Promise<void> {
  await Bun.write(join(dir, "eula.txt"), EULA_CONTENTS);
  logger.info({ dir }, "wrote eula.txt (user accepted)");
}
