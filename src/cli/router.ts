/**
 * One-shot CLI router: turn `argv` into a single command execution and an exit
 * code. This is the CLI's bridge to core — the peer of `hooks/` on the TUI side
 * (AGENTS.md § 3). Commands here must call the same core services the TUI does;
 * no command may hold domain logic the TUI lacks.
 *
 * UI-free (no OpenTUI). It prints plain text to stdout/stderr and returns an
 * exit code; `src/index.tsx` calls `process.exit` with it.
 *
 * Only `help` and `version` are wired today. Every other command is a known
 * placeholder that reports the roadmap phase it arrives in — an honest stub, not
 * a silent no-op. Real commands (`list`, `status`, `init`, …) land per phase in
 * `cli/commands/`.
 */

/** Commands recognised by name, with the roadmap phase that implements them. */
const PLANNED: Record<string, string> = {
  create: "Phase 2",
  start: "Phase 2",
  stop: "Phase 2",
  restart: "Phase 2",
  logs: "Phase 2",
  backup: "Phase 4",
  restore: "Phase 4",
  java: "Phase 2",
};

const HELP = `mctl — Minecraft server control (TUI + CLI)

Usage:
  mctl                 launch the interactive dashboard (TUI)
  mctl <command> [..]  run one command and exit (scriptable)

Commands (planned):
  init                 first-run setup (headless)
  list                 list servers and their probed state
  status <id>          detailed status for one server
  create <name>        create a new server
  start|stop|restart <id>
  logs <id> [-f]       stream a server's console
  backup|restore <id>

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

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
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

  const phase = PLANNED[command];
  if (phase) {
    console.error(`mctl: \`${command}\` is not implemented yet (${phase}).`);
    return 1;
  }

  console.error(`mctl: unknown command \`${command}\`. Run \`mctl --help\`.`);
  return 1;
}
