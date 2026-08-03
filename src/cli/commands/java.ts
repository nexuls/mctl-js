/**
 * `mctl java list | install <major>` — inspect and manage the JDKs MCTL can
 * launch servers with.
 *
 * Thin CLI bridge to `core/java/`. It works **without** config for `list`, since
 * "what Java do I have?" is a reasonable question before `mctl init` has ever
 * run; `install` needs config because it has to know where `$ROOT/java` is.
 */

import { loadConfig, resolveRootPaths } from "../../core/config/index.ts";
import { installJava, listJava } from "../../core/java/index.ts";
import { formatBytes } from "../../lib/format.ts";
import { boolFlag, parseArgs, ArgError } from "../args.ts";
import { reportError } from "../context.ts";
import { toJson, wantsJson } from "../format.ts";

const HELP = `mctl java — inspect and install Java runtimes

Usage:
  mctl java list [--json]
  mctl java install <major> [--json]

Commands:
  list                 every Java MCTL can see, newest first
  install <major>      download that Temurin LTS into <root>/java

Flags:
  --json       machine-readable output
  -h, --help   show this help`;

/**
 * Run `mctl java`.
 * @param argv arguments after `java`.
 */
export async function runJava(argv: string[]): Promise<number> {
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		return argv.length === 0 ? 1 : 0;
	}

	const [subcommand, ...rest] = argv;
	try {
		if (subcommand === "list") return await javaList(rest);
		if (subcommand === "install") return await javaInstall(rest);
		throw new ArgError(`unknown java subcommand \`${subcommand}\``);
	} catch (err) {
		return reportError(err);
	}
}

/** `mctl java list` — detection only; works before first run. */
async function javaList(argv: string[]): Promise<number> {
	parseArgs(argv, { boolean: ["json"] });

	// Config is optional here: without it we simply cannot look inside
	// `$ROOT/java`, which is a smaller answer, not an error.
	let javaDir: string | undefined;
	try {
		javaDir = resolveRootPaths(await loadConfig()).javaDir;
	} catch {
		javaDir = undefined;
	}

	const installations = await listJava(javaDir);
	if (wantsJson(argv)) {
		console.log(toJson(installations));
		return 0;
	}
	if (installations.length === 0) {
		console.log(
			"No Java found. `mctl java install 21` fetches one, or MCTL will fetch it on demand.",
		);
		return 0;
	}
	const rows = installations.map((java) => [
		String(java.major),
		java.version,
		java.source,
		java.vendor ?? "—",
		java.home,
	]);
	const headers = ["MAJOR", "VERSION", "SOURCE", "VENDOR", "HOME"];
	const widths = headers.map((h, col) =>
		Math.max(h.length, ...rows.map((r) => (r[col] ?? "").length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	console.log([line(headers), ...rows.map(line)].join("\n"));
	return 0;
}

/** `mctl java install <major>` — fetch a Temurin JDK into the data root. */
async function javaInstall(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const raw = args.positionals[0];
	if (raw === undefined)
		throw new ArgError("java install needs a major version");
	const major = Number.parseInt(raw, 10);
	if (!Number.isInteger(major) || major <= 0) {
		throw new ArgError(`"${raw}" is not a Java major version`);
	}

	const paths = resolveRootPaths(await loadConfig());
	const json = boolFlag(args, "json") === true;
	const tty = process.stdout.isTTY && !json;

	const installed = await installJava(major, paths, {
		onProgress: (progress) => {
			if (!tty) return;
			const percent =
				progress.fraction === undefined
					? ""
					: ` ${Math.round(progress.fraction * 100)}%`;
			process.stdout.write(
				`\rDownloading JDK ${major}${percent} — ${formatBytes(progress.received)}   `,
			);
		},
	});
	if (tty) process.stdout.write("\r\x1b[2K");

	console.log(
		json
			? toJson(installed)
			: `Installed Java ${installed.major} (${installed.version}) at ${installed.home}`,
	);
	return 0;
}
