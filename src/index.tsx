/**
 * MCTL entry point. Single responsibility: dispatch on argv.
 *
 *   mctl                → mount the OpenTUI dashboard (interactive)
 *   mctl <command> …    → run one command, print, exit (scriptable)
 *
 * Both paths are thin front-ends over the same core services (plan.md § Dual
 * Interface). The two subsystems are loaded lazily so the CLI path never pays to
 * import OpenTUI and the TUI path never loads the CLI router.
 */

const argv = process.argv.slice(2);

if (argv.length === 0) {
  const { renderApp } = await import("./app/App.tsx");
  await renderApp();
} else {
  const { runCli } = await import("./cli/router.ts");
  process.exit(await runCli(argv));
}
