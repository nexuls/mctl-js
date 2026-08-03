/**
 * `mctl init` — headless first-run setup. The scriptable equivalent of the TUI
 * setup wizard (plan.md § First-Run Setup Wizard / § Dual Interface): it accepts
 * the same fields as flags and writes the identical `config.json` + empty `0600`
 * `secrets.json` + data directory tree.
 *
 * UI-free (no OpenTUI import — the CLI path must never load the TUI). Flags left
 * unset fall back to the config schema's own defaults, so `mctl init` with no
 * arguments writes a complete default config rooted at `~/.mctl`. Validation is
 * the schema's job: an out-of-range value (bad kind, relative root) surfaces as a
 * typed `ConfigValidationError` message rather than being silently coerced.
 */

import {
	configExists,
	ensureDirTree,
	resolveRootPaths,
	writeConfig,
	writeSecrets,
} from "../../core/config/index.ts";
import { configFile, defaultRoot } from "../../lib/paths.ts";
import { CONFIG_VERSION } from "../../types/config.ts";

const USAGE = `mctl init — write the initial configuration (headless setup)

Usage:
  mctl init [flags]

Paths:
  --root <path>            data root (default: ~/.mctl); permanent after setup
  --servers-dir <path>     override the default <root>/servers
  --backups-dir <path>     override the default <root>/backups

Defaults for new servers:
  --mc <version>           default Minecraft version (default: latest at create)
  --kind <kind>            server kind (e.g. vanilla)
  --memory <heap>          JVM heap, e.g. 2G
  --runtime <name>         foreground | tmux | docker
  --eula                   auto-accept the Minecraft EULA on create

Backups & network:
  --backup                 enable automatic backups
  --backup-provider <id>   backup provider (e.g. filesystem)
  --compression <fmt>      tar.zst | tar.gz | zip
  --network <profile>      default network profile (e.g. direct)

Other:
  --theme <id>             active theme id (default: terminal)
  --force                  overwrite an existing config
  --json                   print the result as JSON
  -h, --help               show this help`;

/** Long flags that take a value; everything else is a boolean switch. */
const VALUE_FLAGS = new Set([
	"root",
	"servers-dir",
	"backups-dir",
	"mc",
	"kind",
	"memory",
	"runtime",
	"backup-provider",
	"compression",
	"network",
	"theme",
]);

/** Boolean switches. */
const BOOL_FLAGS = new Set(["eula", "backup", "force", "json", "help"]);

/** Parsed `init` arguments: string options and boolean switches. */
interface InitArgs {
	values: Record<string, string>;
	flags: Record<string, boolean>;
}

/**
 * Parse `--key value`, `--key=value`, and boolean `--flag` (plus `-h`). Throws on
 * an unknown flag or a value flag missing its argument, so a typo fails loudly
 * rather than being silently ignored.
 */
function parseArgs(argv: string[]): InitArgs {
	const values: Record<string, string> = {};
	const flags: Record<string, boolean> = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h") {
			flags.help = true;
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`unexpected argument \`${arg}\``);
		}
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		const name = eq >= 0 ? body.slice(0, eq) : body;

		if (VALUE_FLAGS.has(name)) {
			if (eq >= 0) {
				values[name] = body.slice(eq + 1);
			} else {
				const value = argv[++i];
				if (value === undefined) throw new Error(`\`--${name}\` needs a value`);
				values[name] = value;
			}
		} else if (BOOL_FLAGS.has(name)) {
			flags[name] = true;
		} else {
			throw new Error(`unknown flag \`--${name}\``);
		}
	}

	return { values, flags };
}

/**
 * Build the (unparsed) config object from CLI args. Only fields the user
 * actually supplied are set; `writeConfig` fills the rest from the schema
 * defaults, so the output matches what the wizard would write for the same
 * choices.
 */
function buildConfig(args: InitArgs): unknown {
	const { values, flags } = args;

	const defaults: Record<string, unknown> = {};
	if (values.mc) defaults.minecraftVersion = values.mc;
	if (values.kind) defaults.kind = values.kind;
	if (values.memory) defaults.memory = values.memory;
	if (values.runtime) defaults.runtime = values.runtime;
	if (flags.eula) defaults.eula = true;

	const backup: Record<string, unknown> = {};
	if (flags.backup) backup.enabled = true;
	if (values["backup-provider"]) backup.provider = values["backup-provider"];
	if (values.compression) backup.compression = values.compression;

	const config: Record<string, unknown> = {
		configVersion: CONFIG_VERSION,
		root: values.root ?? defaultRoot(),
	};
	if (values["servers-dir"]) config.servers_dir = values["servers-dir"];
	if (values["backups-dir"]) config.backups_dir = values["backups-dir"];
	if (values.theme) config.theme = values.theme;
	if (Object.keys(defaults).length > 0) config.defaults = defaults;
	if (Object.keys(backup).length > 0) config.backup = backup;
	if (values.network) config.network = { defaultProfile: values.network };

	return config;
}

/**
 * Run `mctl init`.
 * @param argv arguments after `init`.
 * @returns the process exit code.
 */
export async function runInit(argv: string[]): Promise<number> {
	let args: InitArgs;
	try {
		args = parseArgs(argv);
	} catch (err) {
		console.error(`mctl init: ${err instanceof Error ? err.message : err}`);
		console.error("Run `mctl init --help`.");
		return 1;
	}

	if (args.flags.help) {
		console.log(USAGE);
		return 0;
	}

	// Refuse to clobber an existing setup unless explicitly forced — config is
	// permanent-ish (the data root can't move) and overwriting it silently would
	// be a footgun.
	if ((await configExists()) && !args.flags.force) {
		console.error(
			`mctl init: config already exists at ${configFile()}. Use --force to overwrite.`,
		);
		return 1;
	}

	try {
		const config = await writeConfig(buildConfig(args));
		await writeSecrets({});
		await ensureDirTree(config);
		const paths = resolveRootPaths(config);

		if (args.flags.json) {
			console.log(
				JSON.stringify({ configFile: configFile(), config, paths }, null, 2),
			);
			return 0;
		}

		console.log(`Initialised MCTL.`);
		console.log(`  config     ${configFile()}`);
		console.log(`  data root  ${paths.root}`);
		console.log(`  servers    ${paths.serversDir}`);
		console.log(`  backups    ${paths.backupsDir}`);
		console.log(
			`  defaults   ${config.defaults.kind} · MC ${config.defaults.minecraftVersion ?? "latest"} · ${config.defaults.memory} · ${config.defaults.runtime}`,
		);
		console.log(
			`  backups    ${config.backup.enabled ? `on · ${config.backup.provider} · ${config.backup.compression}` : "off (manual only)"}`,
		);
		console.log(`\nRun \`mctl\` to open the dashboard.`);
		return 0;
	} catch (err) {
		console.error(`mctl init: ${err instanceof Error ? err.message : err}`);
		return 1;
	}
}
