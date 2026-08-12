/**
 * Install execution — turn an {@link InstallStrategy} (what a `ServerProvider`
 * decided) into files on disk, reporting progress as it goes.
 *
 * Core service — no UI, no argv, **no provider imports**: it receives the
 * strategy as data, which is the whole point of modelling installs as an
 * explicit union. Adding a server kind adds a `case` here at most, and usually
 * not even that.
 *
 * **Staging.** Callers execute into `$ROOT/downloads/staging/<uuid>/` and move
 * the finished tree into place only on success (plan.md § Server Installation).
 * That is why nothing here writes to a final server directory or consults the
 * registry — a failed install must leave no half-built server behind, and the
 * cheapest way to guarantee that is for this module to be unaware of where the
 * files will eventually live.
 */

import { createHash } from "node:crypto";
import { copyFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { formatBytes } from "../../lib/format.ts";
import { downloadFile } from "../../lib/download.ts";
import { ensureDir, pathExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { run } from "../../lib/shell.ts";
import type { InstallStrategy, LaunchSpec } from "../../types/install.ts";
import type { JobContext } from "../jobs/index.ts";

const logger = log("install");

/** How long an installer may run before it is treated as wedged. */
const INSTALLER_TIMEOUT_MS = 15 * 60_000;

/** The script Forge-family installers generate on platforms MCTL runs a shell on. */
const GENERATED_SCRIPT = "run.sh";

/** Where Forge's `run.sh` reads its heap flags from. */
const GENERATED_JVM_ARGS = "user_jvm_args.txt";

/** Thrown when an installer jar exits non-zero or produces nothing runnable. */
export class InstallerFailedError extends Error {
	constructor(
		readonly jar: string,
		message: string,
	) {
		super(`installer ${jar} failed: ${message}`);
		this.name = "InstallerFailedError";
	}
}

/** Extra inputs an install may need beyond the strategy itself. */
export interface ExecuteInstallOptions {
	/**
	 * Absolute path to a `java` executable. **Required for the `installer`
	 * strategy** — Forge, NeoForge and Quilt distribute a program, not a server —
	 * and unused by every other strategy.
	 */
	javaPath?: string;
	/**
	 * A directory outside staging in which interrupted downloads are kept so a
	 * retried install continues them instead of starting over.
	 *
	 * This has to be *outside* staging to work at all: a staging directory is
	 * per-attempt and is deleted in every outcome, success or failure, which is
	 * exactly what makes a failed create leave nothing behind — and also what
	 * would throw away 90% of a downloaded installer. Artefacts land here, are
	 * verified here, and are moved into the install directory only once complete.
	 * Omitted ⇒ downloads go straight to staging and a failure restarts them.
	 */
	resumeDir?: string;
	/** Job handle; progress is reported through it when present. */
	job?: JobContext;
}

/** What an install produced that the caller could not have known in advance. */
export interface InstallOutcome {
	/**
	 * The launch spec to record in `mctl.json`, when the installed layout is not
	 * derivable from the server kind alone. Absent for `directJar`/`loaderJar`
	 * kinds, whose provider always answers `server.jar`.
	 */
	launch?: LaunchSpec;
}

/**
 * Execute an install strategy into `dir`.
 *
 * @param strategy what to install, from `ServerProvider.resolveInstall()`.
 * @param dir directory to install into — during a create this is the staging
 *   directory, never the final server directory.
 * @param options java path (installers only) and the job to report through.
 * @throws {DownloadError} / {@link ChecksumError} when the artefact cannot be
 *   fetched or does not match its published digest.
 * @throws {InstallerFailedError} when an installer jar fails or leaves nothing
 *   runnable behind.
 */
export async function executeInstall(
	strategy: InstallStrategy,
	dir: string,
	options: ExecuteInstallOptions = {},
): Promise<InstallOutcome> {
	const job = options.job;
	await ensureDir(dir);

	switch (strategy.kind) {
		case "directJar":
		case "loaderJar": {
			const dest = join(dir, strategy.dest);
			job?.step("Downloading", 0);
			logger.info(
				{ url: strategy.url, dest, kind: strategy.kind },
				"downloading server jar",
			);
			await download(strategy.url, dest, strategy, options);
			// The digest check inside `downloadFile` *is* the verification step; there
			// is nothing further to run for a directly-runnable jar.
			job?.step("Verifying", 1);
			return {};
		}

		case "installer": {
			const jar = join(dir, strategy.dest);
			job?.step("Downloading", 0);
			logger.info({ url: strategy.url, dest: jar }, "downloading installer");
			await download(strategy.url, jar, strategy, options);

			const javaPath = options.javaPath;
			if (!javaPath) {
				// A programming error rather than a user one: the caller resolves Java
				// before the download precisely so this cannot happen after 60 MB.
				throw new InstallerFailedError(
					strategy.dest,
					"no Java executable was supplied to run it with",
				);
			}

			job?.step("Installing", undefined);
			job?.progress(undefined, "running installer (this takes a few minutes)");
			logger.info({ jar, args: strategy.args }, "running installer");
			// The installer is run with `cwd` = the install directory because every one
			// of these installers writes its output tree relative to the cwd, not
			// relative to the jar. It also downloads Minecraft's own libraries, which
			// is why the timeout is generous.
			const result = await run(
				javaPath,
				["-jar", strategy.dest, ...strategy.args],
				{
					cwd: dir,
					timeoutMs: INSTALLER_TIMEOUT_MS,
				},
			);
			if (result.code !== 0) {
				throw new InstallerFailedError(
					strategy.dest,
					`exit code ${result.code}: ${lastLines(result.stderr || result.stdout)}`,
				);
			}

			job?.step("Verifying", undefined);
			const launch = await resolveProduced(
				strategy.produces,
				dir,
				strategy.dest,
			);

			// Only now is the installer discarded: keeping it until the output has been
			// verified means a failed verification can be diagnosed by re-running it.
			for (const path of strategy.cleanup) {
				await rm(join(dir, path), { force: true, recursive: true });
			}
			logger.info({ dir, launch }, "installer finished");
			return { launch };
		}

		default: {
			// Exhaustiveness guard: a strategy added to the union without a case here
			// fails to compile rather than silently installing nothing.
			const never: never = strategy;
			throw new Error(`unsupported install strategy: ${JSON.stringify(never)}`);
		}
	}
}

/**
 * Download one artefact, wiring the strategy's digests and the job's progress.
 *
 * With a `resumeDir` the bytes land there first — keyed by the artefact's URL so
 * an unrelated download can never be mistaken for a prefix of this one — and are
 * moved into place once verified. See {@link ExecuteInstallOptions.resumeDir}.
 */
async function download(
	url: string,
	dest: string,
	strategy: Extract<InstallStrategy, { url: string }>,
	options: ExecuteInstallOptions,
): Promise<void> {
	const job = options.job;
	const target = options.resumeDir
		? join(options.resumeDir, resumeName(url, dest))
		: dest;
	if (options.resumeDir) await ensureDir(options.resumeDir);

	await downloadFile(url, target, {
		resume: options.resumeDir !== undefined,
		sha256: strategy.sha256,
		sha1: "sha1" in strategy ? strategy.sha1 : undefined,
		md5: "md5" in strategy ? strategy.md5 : undefined,
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

	if (target !== dest) {
		// Verified, so it is now safe to put in the install directory. `rename`
		// within `$ROOT` is atomic; a create on another drive falls back to a copy,
		// which is fine because the source is complete and stays put on failure.
		await ensureDir(dirname(dest));
		try {
			await rename(target, dest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			await copyFile(target, dest);
			await rm(target, { force: true });
		}
	}
}

/**
 * A stable filename for a resumable artefact.
 *
 * Keyed by the **URL**, not by the destination name: two server kinds both
 * install a `server.jar`, and resuming one against the other's partial bytes
 * would produce a file that fails its digest check for reasons nobody could
 * diagnose. The readable suffix is kept so the directory can be understood by a
 * human deleting things from it.
 */
function resumeName(url: string, dest: string): string {
	const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return `${digest}-${basename(dest)}`;
}

/**
 * Confirm the installer produced what the provider said it would, and fall back
 * to the generated launch script when it did not.
 *
 * The provider predicts the argfile path from the version numbers, which is
 * reliable *today* and is exactly the kind of upstream detail that moves. Rather
 * than trust the prediction blindly (an `argFile` naming a missing file starts
 * nothing and reports an unhelpful JVM error), the produced tree is checked and
 * the installer's own `run.sh` is used if the prediction missed. An install with
 * neither is a failure here — at create time, where it can still be reported —
 * rather than at the user's first Start.
 */
async function resolveProduced(
	produces: LaunchSpec,
	dir: string,
	installerJar: string,
): Promise<LaunchSpec> {
	const missing: string[] = [];
	for (const path of pathsOf(produces)) {
		if (!(await pathExists(join(dir, path)))) missing.push(path);
	}
	if (missing.length === 0) return produces;

	if (await pathExists(join(dir, GENERATED_SCRIPT))) {
		logger.warn(
			{ dir, missing },
			"installer did not produce the expected launch files; falling back to run.sh",
		);
		return {
			kind: "script",
			path: GENERATED_SCRIPT,
			jvmArgsFile: (await pathExists(join(dir, GENERATED_JVM_ARGS)))
				? GENERATED_JVM_ARGS
				: undefined,
		};
	}
	throw new InstallerFailedError(
		installerJar,
		`it produced neither ${missing.join(", ")} nor ${GENERATED_SCRIPT}`,
	);
}

/** The files a launch spec depends on, relative to the install directory. */
function pathsOf(spec: LaunchSpec): string[] {
	switch (spec.kind) {
		case "jar":
			return [spec.jar];
		case "argFile":
			return spec.files;
		case "script":
			return [spec.path];
	}
}

/** The tail of an installer's output, for an error message that fits a terminal. */
function lastLines(text: string, count = 5): string {
	const lines = text.trimEnd().split("\n");
	return lines.slice(-count).join("; ") || "no output";
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
