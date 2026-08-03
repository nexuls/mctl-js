/**
 * Configuration service: load, validate, write, and first-run detection for
 * `config.json` and `secrets.json`.
 *
 * No UI, no argv, no providers. Depends only on `lib/` (paths, fs, logger) and
 * the Zod schemas in `types/config.ts`. This is the single place that turns the
 * on-disk config into a validated, typed object — every front-end and core
 * service goes through it rather than reading the files directly.
 *
 * Contract (AGENTS.md):
 *  - **Zod at the boundary** — nothing off disk is trusted; a malformed file is
 *    a typed error, not a silent default.
 *  - **`secrets.json` is `0600`** — written with that mode and the mode is
 *    verified after writing; env vars (`MCTL_*`) override its values.
 *  - **First run in CLI mode does not silently create config** — callers detect
 *    absence via {@link configExists} and steer the user to `mctl init`.
 */

import { stat } from "node:fs/promises";
import {
	configFile,
	secretsFile,
	configDir,
	apiCacheDir,
	runtimeDir,
	logsDir,
	rootPaths,
	type RootPaths,
} from "../../lib/paths.ts";
import {
	pathExists,
	readJsonIfExists,
	writeJsonAtomic,
	ensureDir,
} from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { Config, Secrets } from "../../types/config.ts";

const logger = log("config");

/** `MCTL_*` env vars that are settings, not secrets — excluded from overrides. */
const RESERVED_ENV = new Set([
	"MCTL_LOG_LEVEL",
	"MCTL_ICONS",
	"MCTL_NERD_FONT",
]);

/** Thrown when a config-dependent action runs before first-run setup exists. */
export class ConfigNotFoundError extends Error {
	constructor() {
		super(
			`No config found at ${configFile()}. Run \`mctl init\` (or the setup wizard) first.`,
		);
		this.name = "ConfigNotFoundError";
	}
}

/** Thrown when a config/secrets file exists but fails schema validation. */
export class ConfigValidationError extends Error {
	constructor(
		readonly file: string,
		readonly issues: string,
	) {
		super(`Invalid config at ${file}:\n${issues}`);
		this.name = "ConfigValidationError";
	}
}

/**
 * Whether first-run setup has completed. True iff `config.json` exists; its
 * absence is the sole first-run trigger (plan.md § First-Run Setup Wizard).
 */
export async function configExists(): Promise<boolean> {
	return pathExists(configFile());
}

/**
 * Load and validate `config.json`.
 * @throws {ConfigNotFoundError} when the file is absent (first run).
 * @throws {ConfigValidationError} when present but malformed.
 */
export async function loadConfig(): Promise<Config> {
	const raw = await readJsonIfExists(configFile());
	if (raw === undefined) throw new ConfigNotFoundError();
	const parsed = Config.safeParse(raw);
	if (!parsed.success) {
		throw new ConfigValidationError(configFile(), formatIssues(parsed.error));
	}
	return parsed.data;
}

/**
 * Load `secrets.json` (empty when absent) and overlay `MCTL_*` env overrides.
 * A secret key is UPPER_SNAKE and its env override is `MCTL_<KEY>` — e.g. the
 * key `CLOUDFLARE_TOKEN` is overridden by `MCTL_CLOUDFLARE_TOKEN`. Reserved
 * settings vars (see {@link RESERVED_ENV}) are never treated as secrets.
 *
 * @throws {ConfigValidationError} when the file exists but is not `{string: string}`.
 */
export async function loadSecrets(): Promise<Secrets> {
	const raw = (await readJsonIfExists(secretsFile())) ?? {};
	const parsed = Secrets.safeParse(raw);
	if (!parsed.success) {
		throw new ConfigValidationError(secretsFile(), formatIssues(parsed.error));
	}
	const merged: Secrets = { ...parsed.data };
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (!name.startsWith("MCTL_") || RESERVED_ENV.has(name)) continue;
		merged[name.slice("MCTL_".length)] = value;
	}
	return merged;
}

/**
 * Validate and atomically write `config.json`. Parsing here applies schema
 * defaults, so a partial object from the wizard becomes a complete file.
 */
export async function writeConfig(config: unknown): Promise<Config> {
	const parsed = Config.safeParse(config);
	if (!parsed.success) {
		throw new ConfigValidationError(configFile(), formatIssues(parsed.error));
	}
	await writeJsonAtomic(configFile(), parsed.data);
	logger.info({ file: configFile() }, "wrote config");
	return parsed.data;
}

/**
 * Atomically write `secrets.json` with mode `0600`, then verify the mode landed
 * — a secrets file readable by other users is a security defect, so we fail
 * loudly rather than trust the write. Values are never logged.
 */
export async function writeSecrets(secrets: Secrets): Promise<void> {
	const parsed = Secrets.safeParse(secrets);
	if (!parsed.success) {
		throw new ConfigValidationError(secretsFile(), formatIssues(parsed.error));
	}
	await writeJsonAtomic(secretsFile(), parsed.data, { mode: 0o600 });
	const mode = (await stat(secretsFile())).mode & 0o777;
	if (mode !== 0o600) {
		throw new Error(
			`secrets.json has mode ${mode.toString(8)}, expected 600 — refusing to continue`,
		);
	}
	logger.info({ file: secretsFile() }, "wrote secrets (0600, values redacted)");
}

/**
 * Resolve the concrete data-path set for a loaded config, honouring
 * `servers_dir` / `backups_dir` overrides. Convenience over
 * {@link rootPaths} so callers don't re-thread the override fields.
 */
export function resolveRootPaths(config: Config): RootPaths {
	return rootPaths(config.root, {
		serversDir: config.servers_dir,
		backupsDir: config.backups_dir,
	});
}

/**
 * Create MCTL's full directory tree for a given config: the fixed XDG dirs and
 * the relocatable data dirs under `$ROOT`. Idempotent — safe to run on every
 * launch, not just first run. Does **not** write any files.
 */
export async function ensureDirTree(config: Config): Promise<void> {
	const paths = resolveRootPaths(config);
	await Promise.all([
		ensureDir(configDir()),
		ensureDir(apiCacheDir()),
		ensureDir(runtimeDir()),
		ensureDir(logsDir()),
		ensureDir(paths.serversDir),
		ensureDir(paths.backupsDir),
		ensureDir(paths.javaDir),
		ensureDir(paths.stagingDir), // creates downloadsDir as its parent
	]);
	logger.debug({ root: paths.root }, "ensured directory tree");
}

/** Flatten a ZodError into a readable multi-line string for error messages. */
function formatIssues(error: import("zod").ZodError): string {
	return error.issues
		.map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("\n");
}
