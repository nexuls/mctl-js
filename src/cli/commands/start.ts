/**
 * `mctl start <id>` — start a server, and `mctl stop` / `mctl restart`.
 *
 * Thin CLI bridge to core: `RuntimeManager` owns provider resolution, Java
 * resolution, the per-server lock, and the state event. This file only decides
 * what a *terminal* should do afterwards.
 *
 * **Why `start` blocks under the foreground runtime.** Foreground ties the
 * server's lifetime to the MCTL process (plan.md § Runtime) — returning to the
 * shell would kill the server it just started. So the command stays attached,
 * streams the console, and turns Ctrl-C into a graceful stop. That is honest
 * rather than convenient; a server that outlives the terminal is what the tmux
 * runtime is for (Phase 3), and the command says so.
 */

import { cliContext, reportError } from "../context.ts";
import { boolFlag, intFlag, parseArgs, ArgError } from "../args.ts";
import { toJson, wantsJson } from "../format.ts";
import { getServer } from "../../core/server/discover.ts";
import type { MctlContext } from "../../core/context.ts";

const START_HELP = `mctl start — start a server

Usage:
  mctl start <id> [flags]

Flags:
  --quiet          do not stream the console (still attaches; see below)
  --no-java        fail instead of downloading a JDK when none is suitable
  --json           machine-readable output (the session descriptor)
  -h, --help       show this help

Note: servers whose runtime is "foreground" are children of this process, so
this command stays attached until the server stops. Ctrl-C stops it gracefully.`;

const STOP_HELP = `mctl stop — stop a running server

Usage:
  mctl stop <id> [flags]

Flags:
  --timeout <ms>   grace period before escalating to SIGKILL (default 60000)
  --json           machine-readable output
  -h, --help       show this help`;

const RESTART_HELP = `mctl restart — stop then start a server

Usage:
  mctl restart <id> [flags]

Flags:
  --timeout <ms>   grace period before escalating to SIGKILL (default 60000)
  --json           machine-readable output
  -h, --help       show this help`;

/** Read the single `<id>` positional a lifecycle command takes. */
function requireId(positionals: string[], command: string): string {
  const id = positionals[0];
  if (id === undefined) throw new ArgError(`${command} needs a server id`);
  if (positionals.length > 1) {
    throw new ArgError(`unexpected argument "${positionals[1]}"`);
  }
  return id;
}

/** Run `mctl start`. */
export async function runStart(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(START_HELP);
    return 0;
  }
  try {
    const args = parseArgs(argv, { boolean: ["quiet", "json", "java"] });
    const id = requireId(args.positionals, "start");
    const context = await cliContext();

    const session = await context.runtime.start(id, {
      autoInstallJava: boolFlag(args, "java") !== false,
    });

    if (wantsJson(argv)) {
      console.log(toJson(session));
    } else {
      console.error(
        `Started ${id} (pid ${session.pid}${session.port ? `, port ${session.port}` : ""})`,
      );
    }

    const server = await getServer(id, context.paths.serversDir);
    // Only a foreground server depends on this process staying alive. A detached
    // runtime (Phase 3) can simply return, and this check is what makes that
    // work without touching the command.
    if (server?.runtime !== "foreground") return 0;

    return attach(context, id, boolFlag(args, "quiet") === true);
  } catch (err) {
    return reportError(err);
  }
}

/** Run `mctl stop`. */
export async function runStop(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(STOP_HELP);
    return 0;
  }
  try {
    const args = parseArgs(argv, { valued: ["timeout"], boolean: ["json"] });
    const id = requireId(args.positionals, "stop");
    const context = await cliContext();
    await context.runtime.stop(id, { timeoutMs: intFlag(args, "timeout") });
    console.log(wantsJson(argv) ? toJson({ id, state: "stopped" }) : `Stopped ${id}`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

/** Run `mctl restart`. */
export async function runRestart(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(RESTART_HELP);
    return 0;
  }
  try {
    const args = parseArgs(argv, { valued: ["timeout"], boolean: ["json", "quiet"] });
    const id = requireId(args.positionals, "restart");
    const context = await cliContext();
    const session = await context.runtime.restart(id, {
      timeoutMs: intFlag(args, "timeout"),
    });
    if (wantsJson(argv)) {
      console.log(toJson(session));
    } else {
      console.error(`Restarted ${id} (pid ${session.pid})`);
    }
    const server = await getServer(id, context.paths.serversDir);
    if (server?.runtime !== "foreground") return 0;
    return attach(context, id, boolFlag(args, "quiet") === true);
  } catch (err) {
    return reportError(err);
  }
}

/**
 * Stay attached to a foreground server: stream its console until it stops, and
 * translate Ctrl-C into a graceful shutdown.
 *
 * Two things run concurrently — the log stream and a liveness poll — because the
 * capture file gives no end-of-stream signal: the server may sit idle for hours
 * between lines, so "no more output" cannot mean "it exited".
 */
async function attach(
  context: MctlContext,
  id: string,
  quiet: boolean,
): Promise<number> {
  const controller = new AbortController();
  let interrupted = false;

  const onInterrupt = () => {
    if (interrupted) return; // a second Ctrl-C during shutdown: let it fall through
    interrupted = true;
    console.error(`\nStopping ${id}…`);
    void context.runtime.stop(id).catch((err) => {
      console.error(`mctl: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const streaming = (async () => {
    if (quiet) return;
    // `tail: 0` — the "Started …" line was already printed and the descriptor is
    // fresh, so replaying the capture from its beginning would duplicate nothing
    // useful; new lines are what the user is here for.
    const lines = await context.runtime.logs(id, {
      follow: true,
      tail: 0,
      signal: controller.signal,
    });
    for await (const line of lines) {
      if (controller.signal.aborted) break;
      console.log(line);
    }
  })();

  try {
    // Poll rather than await a process handle: the same code must work when the
    // server was started by this process and when a later `mctl start` reattaches.
    while ((await context.runtime.status(id)) === "running") {
      await Bun.sleep(500);
    }
  } finally {
    controller.abort();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    await streaming.catch(() => {});
  }

  console.error(`${id} stopped.`);
  return 0;
}
