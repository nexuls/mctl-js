/**
 * `mctl logs <id>` — print a server's captured console output, and
 * `mctl exec <id> <command…>` — send one line to its console.
 *
 * Thin CLI bridges to `RuntimeManager`. Both work against the *shared* capture
 * file, so `mctl logs -f survival` in one terminal shows what a TUI in another
 * terminal is showing — no IPC, same file (architecture.md § Statelessness).
 */

import { cliContext, reportError } from "../context.ts";
import { boolFlag, intFlag, parseArgs, ArgError } from "../args.ts";

const LOGS_HELP = `mctl logs — stream a server's console output

Usage:
  mctl logs <id> [flags]

Flags:
  -f, --follow      keep streaming as new output arrives
  -n, --lines <n>   show only the last n lines first (default: all)
  -h, --help        show this help`;

const EXEC_HELP = `mctl exec — send a command to a running server's console

Usage:
  mctl exec <id> <command...>

Example:
  mctl exec survival say Server restarting in 5 minutes

Note: under the foreground runtime a server's stdin is reachable only from the
mctl process that started it; from another terminal this reports that clearly
rather than silently dropping the command.`;

/** Run `mctl logs`. */
export async function runLogs(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(LOGS_HELP);
		return 0;
	}
	try {
		const args = parseArgs(argv, {
			valued: ["lines"],
			boolean: ["follow"],
			aliases: { f: "follow", n: "lines" },
		});
		const id = args.positionals[0];
		if (id === undefined) throw new ArgError("logs needs a server id");

		const context = await cliContext();
		const controller = new AbortController();
		// Ctrl-C ends the stream rather than killing the process mid-write, so a
		// piped `mctl logs -f … | grep` sees a clean end.
		const onInterrupt = () => controller.abort();
		process.on("SIGINT", onInterrupt);

		try {
			const lines = await context.runtime.logs(id, {
				follow: boolFlag(args, "follow") === true,
				tail: intFlag(args, "lines"),
				signal: controller.signal,
			});
			for await (const line of lines) {
				if (controller.signal.aborted) break;
				console.log(line);
			}
		} finally {
			process.off("SIGINT", onInterrupt);
		}
		return 0;
	} catch (err) {
		return reportError(err);
	}
}

/** Run `mctl exec`. */
export async function runExec(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(EXEC_HELP);
		return 0;
	}
	try {
		const [id, ...rest] = argv;
		if (id === undefined) throw new ArgError("exec needs a server id");
		if (rest.length === 0) throw new ArgError("exec needs a command to send");

		// No flag parsing on the command itself: a Minecraft console command may
		// legitimately start with a hyphen, and re-quoting it would be a trap.
		const context = await cliContext();
		await context.runtime.exec(id, rest.join(" "));
		return 0;
	} catch (err) {
		return reportError(err);
	}
}
