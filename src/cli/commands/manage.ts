/**
 * `mctl delete <id>` and `mctl edit <id>` — the remaining `ServerManager`
 * operations, as thin CLI bridges.
 *
 * **Deleting files requires saying so twice.** `--files` asks to erase the
 * server directory and `--yes` confirms it, because worlds are irreplaceable and
 * a script that typo'd a flag must not silently destroy one (AGENTS.md
 * § Secrets and user data). Without `--files`, delete only forgets the location
 * — the directory stays exactly where it is and can be re-discovered.
 */

import { cliContext, reportError } from "../context.ts";
import { boolFlag, intFlag, parseArgs, stringFlag, ArgError } from "../args.ts";
import { toJson, wantsJson, formatServerStatus } from "../format.ts";
import type { RuntimeKind } from "../../types/config.ts";

const DELETE_HELP = `mctl delete — remove a server

Usage:
  mctl delete <id> [flags]

By default this only removes the server from the registry; its directory and
worlds are left untouched and will be re-discovered if it lives under
servers_dir. Pass --files to erase the directory as well.

Flags:
  --files      also delete the server directory (IRREVERSIBLE)
  --yes        confirm --files without prompting
  --json       machine-readable output
  -h, --help   show this help`;

const EDIT_HELP = `mctl edit — change a server's settings

Usage:
  mctl edit <id> [flags]

Changes mctl.json in place. Changing kind or Minecraft version is an update
(re-install), not an edit, and is not supported yet.

Flags:
  --name <name>      display name
  --memory <size>    JVM heap, e.g. 4G
  --runtime <id>     runtime provider
  --network <name>   network profile
  --java <major>     pin a Java major version
  --no-java          clear the pin and resolve Java automatically again
  --json             machine-readable output
  -h, --help         show this help`;

/** Run `mctl delete`. */
export async function runDelete(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(DELETE_HELP);
		return 0;
	}
	try {
		const args = parseArgs(argv, { boolean: ["files", "yes", "json"] });
		const id = args.positionals[0];
		if (id === undefined) throw new ArgError("delete needs a server id");

		const deleteFiles = boolFlag(args, "files") === true;
		if (deleteFiles && boolFlag(args, "yes") !== true) {
			throw new ArgError(
				"--files erases the server directory and its worlds; pass --yes to confirm",
			);
		}

		const context = await cliContext();
		await context.servers.deleteServer(id, { deleteFiles });
		console.log(
			wantsJson(argv)
				? toJson({ id, deletedFiles: deleteFiles })
				: deleteFiles
					? `Deleted ${id} and its directory.`
					: `Removed ${id} from the registry (its files are untouched).`,
		);
		return 0;
	} catch (err) {
		return reportError(err);
	}
}

/** Run `mctl edit`. */
export async function runEdit(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(EDIT_HELP);
		return 0;
	}
	try {
		const args = parseArgs(argv, {
			valued: ["name", "memory", "runtime", "network", "java"],
			boolean: ["json", "java"],
		});
		const id = args.positionals[0];
		if (id === undefined) throw new ArgError("edit needs a server id");
		if (args.positionals.length > 1) {
			throw new ArgError(`unexpected argument "${args.positionals[1]}"`);
		}

		// `--java 21` pins, `--no-java` clears the pin, absent leaves it alone.
		const javaPin =
			boolFlag(args, "java") === false
				? null
				: (intFlag(args, "java") ?? undefined);

		const context = await cliContext();
		const server = await context.servers.editServer(id, {
			name: stringFlag(args, "name"),
			memory: stringFlag(args, "memory"),
			runtime: stringFlag(args, "runtime") as RuntimeKind | undefined,
			network: stringFlag(args, "network"),
			javaPin,
		});
		console.log(wantsJson(argv) ? toJson(server) : formatServerStatus(server));
		return 0;
	} catch (err) {
		return reportError(err);
	}
}
