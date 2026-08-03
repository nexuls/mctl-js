/**
 * Process leaf helpers: run a command and collect its output, or locate a binary
 * on `$PATH`.
 *
 * Leaf helper (`lib/`) — UI-free, provider-free, server-free. It knows nothing
 * about Minecraft, Java, or runtimes; it spawns and reports. Long-lived,
 * *supervised* processes (a server, a tunnel) are **not** this module's job —
 * those belong to a runtime/network provider, which needs the handle itself.
 *
 * Everything here is short-lived and fully buffered, which is only safe because
 * the callers (`java -version`, `tar -xzf`) produce a few kilobytes at most.
 */

import { log } from "./logger.ts";

const logger = log("shell");

/** The result of running a command to completion. */
export interface RunResult {
  /** Process exit code (`null` when killed by a signal). */
  code: number | null;
  /** Captured stdout, decoded as UTF-8. */
  stdout: string;
  /**
   * Captured stderr, decoded as UTF-8. Not an error channel by itself — `java
   * -version` famously writes its version banner here on JDK 8.
   */
  stderr: string;
}

/** Options for {@link run}. */
export interface RunOptions {
  /** Working directory for the child. */
  cwd?: string;
  /** Extra environment variables, merged over `process.env`. */
  env?: Record<string, string>;
  /** Kill the child and reject after this many ms. */
  timeoutMs?: number;
  /** Text piped to the child's stdin, which is then closed. */
  stdin?: string;
}

/** Thrown when a command could not be spawned or exceeded its timeout. */
export class CommandError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(`${command}: ${message}`);
    this.name = "CommandError";
  }
}

/**
 * Run a command to completion and return its exit code and output. A non-zero
 * exit is **not** an exception — many callers care about the code (`which`-style
 * probes) — but a failure to spawn or a timeout is.
 *
 * @throws {CommandError} when the binary cannot be spawned or the timeout fires.
 */
export async function run(
  command: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  let child: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">;
  try {
    child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new CommandError(command, `failed to spawn: ${String(err)}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
  }

  try {
    // Drain both pipes concurrently with the exit wait: a child that fills its
    // stdout pipe blocks forever if we only await `exited` first.
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) {
      throw new CommandError(command, `timed out after ${options.timeoutMs}ms`);
    }
    logger.debug({ command, args, code }, "ran command");
    return { code, stdout, stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Absolute path of `binary` on `$PATH`, or `undefined` when it is not there.
 * Resolved by walking `$PATH` directly rather than shelling out to `which`,
 * which is itself not guaranteed to exist.
 *
 * On Windows, `PATHEXT` suffixes are tried; elsewhere the bare name is used.
 */
export async function which(binary: string): Promise<string | undefined> {
  const path = process.env.PATH;
  if (!path) return undefined;
  const separator = process.platform === "win32" ? ";" : ":";
  const candidates =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .map((ext) => `${binary}${ext.toLowerCase()}`)
      : [binary];

  for (const dir of path.split(separator)) {
    if (dir === "") continue;
    for (const name of candidates) {
      const candidate = `${dir}/${name}`;
      // `Bun.file().exists()` does not tell us about the execute bit, but a
      // non-executable file on PATH is pathological and the spawn would surface
      // it anyway with a clearer error than a bespoke permission check.
      if (await Bun.file(candidate).exists()) return candidate;
    }
  }
  return undefined;
}
