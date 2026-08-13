/**
 * One-shot CLI router: turn `argv` into a single command execution and an exit
 * code. This is the CLI's bridge to core — the peer of `hooks/` on the TUI side
 * (AGENTS.md § 3). Commands here must call the same core services the TUI does;
 * no command may hold domain logic the TUI lacks.
 *
 * UI-free (no OpenTUI). It prints plain text to stdout/stderr and returns an
 * exit code; `src/index.tsx` calls `process.exit` with it.
 *
 * Commands that do not exist yet are honest stubs reporting the roadmap phase
 * they arrive in — never a silent no-op. Real commands land per phase in
 * `cli/commands/`.
 */

/** Commands recognised by name, with the roadmap phase that implements them. */
const PLANNED: Record<string, string> = {
	backup: "Phase 4",
	restore: "Phase 4",
};

const HELP = `mctl — Minecraft server control (TUI + CLI)

Usage:
  mctl                 launch the interactive dashboard (TUI)
  mctl <command> [..]  run one command and exit (scriptable)

Commands:
  init                 first-run setup (headless)
  list                 list servers and their probed state
  status <id>          detailed status for one server
  create <name>        create and install a new server
  edit <id>            change a server's settings
  delete <id>          remove a server (--files to erase its directory)
  start|stop|restart <id>
  logs <id> [-f]       stream a server's console
  exec <id> <cmd...>   send a command to a running server's console
  java list|install    inspect or install Java runtimes
  network [up|down]    join addresses, tunnels, and DNS

Planned:
  backup|restore <id>  (Phase 4)

Flags:
  -h, --help           show this help
  -v, --version        show version

Add --json to a command for machine-readable output.`;

/** Read the package version without bundling it into every module. */
async function version(): Promise<string> {
	const pkg = (await import("../../package.json", { with: { type: "json" } }))
		.default as { version?: string };
	return pkg.version ?? "0.0.0";
}

/**
 * Execute one CLI invocation.
 * @param argv arguments after the program name (`process.argv.slice(2)`).
 * @returns the process exit code.
 */
export async function runCli(argv: string[]): Promise<number> {
	const command = argv[0];

	if (
		command === undefined ||
		command === "-h" ||
		command === "--help" ||
		command === "help"
	) {
		console.log(HELP);
		return 0;
	}

	if (command === "-v" || command === "--version" || command === "version") {
		console.log(await version());
		return 0;
	}

	// Real commands are lazy-imported so a `--help`/`--version` invocation stays
	// cheap and the module graph for each command loads only when it runs.
	if (command === "init") {
		const { runInit } = await import("./commands/init.ts");
		return runInit(argv.slice(1));
	}

	if (command === "list") {
		const { runList } = await import("./commands/list.ts");
		return runList(argv.slice(1));
	}

	if (command === "status") {
		const { runStatus } = await import("./commands/status.ts");
		return runStatus(argv.slice(1));
	}

	if (command === "create") {
		const { runCreate } = await import("./commands/create.ts");
		return runCreate(argv.slice(1));
	}

	if (command === "edit" || command === "delete") {
		const { runEdit, runDelete } = await import("./commands/manage.ts");
		return command === "edit"
			? runEdit(argv.slice(1))
			: runDelete(argv.slice(1));
	}

	if (command === "start" || command === "stop" || command === "restart") {
		const { runStart, runStop, runRestart } = await import(
			"./commands/start.ts"
		);
		if (command === "start") return runStart(argv.slice(1));
		if (command === "stop") return runStop(argv.slice(1));
		return runRestart(argv.slice(1));
	}

	if (command === "logs" || command === "exec") {
		const { runLogs, runExec } = await import("./commands/logs.ts");
		return command === "logs" ? runLogs(argv.slice(1)) : runExec(argv.slice(1));
	}

	if (command === "network") {
		const { runNetwork } = await import("./commands/network.ts");
		return runNetwork(argv.slice(1));
	}

	if (command === "java") {
		const { runJava } = await import("./commands/java.ts");
		return runJava(argv.slice(1));
	}

	const phase = PLANNED[command];
	if (phase) {
		console.error(`mctl: \`${command}\` is not implemented yet (${phase}).`);
		return 1;
	}

	console.error(`mctl: unknown command \`${command}\`. Run \`mctl --help\`.`);
	return 1;
}
