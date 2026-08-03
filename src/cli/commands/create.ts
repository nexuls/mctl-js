/**
 * `mctl create <name>` — create and install a new server headlessly.
 *
 * Thin CLI bridge to core: every decision (id derivation, version resolution,
 * Java resolution, staging, registration) belongs to `ServerManager`, so this
 * command and the TUI's create flow produce byte-identical servers.
 *
 * Progress is drawn as a one-line, carriage-return-updated status while stdout
 * is a TTY, and suppressed entirely when it is not — a `mctl create … | tee`
 * in a script should capture a clean log, not a thousand redraws.
 */

import { cliContext, reportError } from "../context.ts";
import { boolFlag, intFlag, parseArgs, stringFlag, ArgError } from "../args.ts";
import { toJson, wantsJson } from "../format.ts";
import { EventType } from "../../types/events.ts";
import type { Job } from "../../core/jobs/index.ts";
import type { RuntimeKind, ServerKind } from "../../types/config.ts";

const HELP = `mctl create — create a new server

Usage:
  mctl create <name> [flags]

Flags:
  --kind <id>        server kind (default: config defaults.kind)
  --mc <version>     Minecraft version (default: the kind's newest release)
  --loader <ver>     loader version, for kinds that have one
  --memory <size>    JVM heap, e.g. 4G (default: config defaults.memory)
  --runtime <id>     runtime provider (default: config defaults.runtime)
  --network <name>   network profile (default: config network.defaultProfile)
  --path <dir>       create the server here instead of <servers_dir>/<id>
  --id <id>          explicit id / directory name (default: derived from name)
  --java <major>     pin a Java major version instead of resolving one
  --no-java          skip Java resolution now; resolve it at first start
  --eula             accept the Minecraft EULA (https://www.minecraft.net/eula)
  --no-eula          do not accept it, overriding the configured default
  --json             machine-readable output (the created server's view model)
  -h, --help         show this help`;

/**
 * Run `mctl create`.
 * @param argv arguments after `create`.
 * @returns process exit code.
 */
export async function runCreate(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }

  try {
    const args = parseArgs(argv, {
      valued: ["kind", "mc", "loader", "memory", "runtime", "network", "path", "id", "java"],
      boolean: ["eula", "json", "java"],
    });
    const name = args.positionals[0];
    if (name === undefined) throw new ArgError("create needs a server name");
    if (args.positionals.length > 1) {
      throw new ArgError(
        `unexpected argument "${args.positionals[1]}" (quote names containing spaces)`,
      );
    }

    const context = await cliContext();
    const json = wantsJson(argv);
    // `--java 21` pins; `--no-java` skips. They are the same flag name because
    // they are the same decision: "do not resolve Java automatically". The
    // negation is checked first — `--no-java` stores the string "false", which
    // is not a version number and must not reach `intFlag`.
    const skipJava = boolFlag(args, "java") === false;
    const javaPin = skipJava ? undefined : intFlag(args, "java");

    const started = await context.servers.createServer({
      name,
      id: stringFlag(args, "id"),
      kind: stringFlag(args, "kind") as ServerKind | undefined,
      minecraftVersion: stringFlag(args, "mc"),
      loaderVersion: stringFlag(args, "loader"),
      memory: stringFlag(args, "memory"),
      runtime: stringFlag(args, "runtime") as RuntimeKind | undefined,
      network: stringFlag(args, "network"),
      path: stringFlag(args, "path"),
      eula: boolFlag(args, "eula"),
      javaPin,
      skipJava,
    });

    const stopProgress = json ? undefined : followProgress(context.bus, started.job.id);
    try {
      const server = await started.result;
      stopProgress?.();
      console.log(
        json
          ? toJson(server)
          : `Created ${server.id} (${server.kind} ${server.minecraftVersion}) at ${server.path}`,
      );
      return 0;
    } catch (err) {
      stopProgress?.();
      throw err;
    }
  } catch (err) {
    return reportError(err);
  }
}

/**
 * Render this job's progress on one rewritten line while stdout is a TTY.
 * @returns a function that stops rendering and clears the line.
 */
function followProgress(
  bus: { subscribe: (listener: (event: { type: string; payload?: unknown }) => void) => () => void },
  jobId: string,
): () => void {
  if (!process.stdout.isTTY) return () => {};

  const unsubscribe = bus.subscribe((event) => {
    if (event.type !== EventType.JobProgress) return;
    const job = event.payload as Job;
    if (job.id !== jobId) return;
    const percent =
      job.fraction === undefined ? "" : ` ${Math.round(job.fraction * 100)}%`;
    const detail = job.message ? ` — ${job.message}` : "";
    // \r rewrites in place; the trailing spaces erase a previously longer line.
    process.stdout.write(`\r${job.step ?? job.title}${percent}${detail}          `);
  });

  return () => {
    unsubscribe();
    process.stdout.write("\r\x1b[2K"); // carriage return + erase whole line
  };
}
