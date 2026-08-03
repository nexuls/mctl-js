/**
 * `mctl list` — list every server and its live-probed state (plan.md § Dual
 * Interface). A transient instance: it reads hard state, probes liveness, prints,
 * and exits. The same `Server` view models power the TUI Dashboard.
 *
 * Thin CLI bridge to core (AGENTS.md § 3): it loads config, resolves
 * `servers_dir`, and calls the shared `listServers` read path. No domain logic
 * lives here that the TUI lacks.
 */

import {
	loadConfig,
	resolveRootPaths,
	ConfigNotFoundError,
} from "../../core/config/index.ts";
import { listServers } from "../../core/server/discover.ts";
import { wantsJson, toJson, formatServerTable } from "../format.ts";

const HELP = `mctl list — list servers and their probed state

Usage:
  mctl list [--json]

Flags:
  --json       machine-readable output (the raw view models)
  -h, --help   show this help`;

/**
 * Run `mctl list`.
 * @param argv arguments after `list`.
 * @returns process exit code.
 */
export async function runList(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		return 0;
	}

	let serversDir: string;
	try {
		serversDir = resolveRootPaths(await loadConfig()).serversDir;
	} catch (err) {
		return reportConfigError(err);
	}

	const servers = await listServers(serversDir);
	console.log(wantsJson(argv) ? toJson(servers) : formatServerTable(servers));
	return 0;
}

/** Print a config-load failure and return exit 1, steering first-run users to init. */
export function reportConfigError(err: unknown): number {
	if (err instanceof ConfigNotFoundError) {
		console.error(
			"mctl: no config yet. Run `mctl init` (or launch `mctl` for the setup wizard).",
		);
	} else {
		console.error(`mctl: ${err instanceof Error ? err.message : String(err)}`);
	}
	return 1;
}
