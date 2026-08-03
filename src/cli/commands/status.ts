/**
 * `mctl status <id>` — detailed, live-probed status for one server (plan.md §
 * Dual Interface). A transient instance: read hard state, probe, print, exit.
 *
 * Thin CLI bridge to core: loads config, resolves `servers_dir`, and calls the
 * shared `getServer` read path — the same view model the TUI Server page renders.
 */

import { loadConfig, resolveRootPaths } from "../../core/config/index.ts";
import { getServer } from "../../core/server/discover.ts";
import { wantsJson, toJson, formatServerStatus } from "../format.ts";
import { reportConfigError } from "./list.ts";

const HELP = `mctl status — detailed status for one server

Usage:
  mctl status <id> [--json]

Flags:
  --json       machine-readable output (the raw view model)
  -h, --help   show this help`;

/**
 * Run `mctl status <id>`.
 * @param argv arguments after `status` (first non-flag is the server id).
 * @returns process exit code (2 when the id is missing or unknown).
 */
export async function runStatus(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		return 0;
	}

	const id = argv.find((a) => !a.startsWith("-"));
	if (id === undefined) {
		console.error("mctl: status needs a server id. Usage: `mctl status <id>`.");
		return 2;
	}

	let serversDir: string;
	try {
		serversDir = resolveRootPaths(await loadConfig()).serversDir;
	} catch (err) {
		return reportConfigError(err);
	}

	const server = await getServer(id, serversDir);
	if (!server) {
		console.error(`mctl: no server with id \`${id}\`. Run \`mctl list\`.`);
		return 2;
	}

	console.log(wantsJson(argv) ? toJson(server) : formatServerStatus(server));
	return 0;
}
