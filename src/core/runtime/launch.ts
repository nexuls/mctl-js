/**
 * Turn a {@link LaunchSpec} into the argv a runtime spawns, and say which files
 * that launch depends on.
 *
 * Core service, and **pure** — no I/O, no UI, no provider imports. It exists as
 * its own module because every runtime provider needs exactly this translation:
 * duplicating it in `foreground.ts` and `tmux.ts` is how the two would drift
 * apart on, say, whether `nogui` comes before or after the argfiles.
 *
 * **Why `nogui` is always last.** Minecraft's server main class parses it as a
 * program argument; anything after the `-jar`/`@argfile` portion of the command
 * line belongs to the program rather than to the JVM, and a `nogui` placed among
 * the JVM flags is silently swallowed as an unrecognised option.
 */

import { join } from "node:path";
import type { LaunchSpec } from "../../types/install.ts";

/** The program to spawn and its arguments, ready for `Bun.spawn`. */
export interface LaunchCommand {
	/** Executable path — the resolved `java`, or a shell for a `script` spec. */
	command: string;
	/** Arguments, in order. */
	args: string[];
}

/** The program argument that stops a server opening Mojang's Swing console. */
const NOGUI = "nogui";

/**
 * Build the command line for a launch spec.
 *
 * @param spec what to launch, from `mctl.json` or `ServerProvider.launchSpec`.
 * @param javaPath absolute path to the resolved `java` executable.
 * @param jvmArgs heap flags and friends, placed before the launch target.
 *
 * The returned paths are all **relative**, because every runtime spawns with
 * `cwd` set to the server directory — a Minecraft server resolves `world/`,
 * `server.properties` and its own `logs/` against the working directory, so
 * launching from anywhere else quietly creates a second world tree.
 */
export function launchCommand(
	spec: LaunchSpec,
	javaPath: string,
	jvmArgs: string[],
): LaunchCommand {
	switch (spec.kind) {
		case "jar":
			return { command: javaPath, args: [...jvmArgs, "-jar", spec.jar, NOGUI] };
		case "argFile":
			// `@file` is a JVM feature (JDK 9+): the file's contents are spliced into
			// the command line at that position. Forge's argfile carries the module
			// path and main class, so it must come *after* the heap flags and before
			// the program arguments.
			return {
				command: javaPath,
				args: [...jvmArgs, ...spec.files.map((file) => `@${file}`), NOGUI],
			};
		case "script":
			// The script sets up its own JVM invocation and reads heap flags from a
			// file (see `jvmArgsFile`), so `jvmArgs` are deliberately not passed here —
			// `writeScriptJvmArgs` puts them where the script will look.
			return { command: "sh", args: [spec.path, NOGUI] };
		default: {
			// Exhaustiveness guard: a new launch spec must be handled here or the
			// build fails, rather than a server failing to start at runtime.
			const never: never = spec;
			throw new Error(`unsupported launch spec: ${JSON.stringify(never)}`);
		}
	}
}

/**
 * Absolute paths a launch spec needs to already exist, so a caller can check
 * them and report *which file is missing* instead of letting the JVM fail with
 * "Error: Unable to access jarfile" or, worse, an argfile-driven start that
 * re-runs an installer.
 *
 * @param spec the launch spec.
 * @param dir the server directory the spec's relative paths resolve against.
 */
export function launchInputs(spec: LaunchSpec, dir: string): string[] {
	switch (spec.kind) {
		case "jar":
			return [join(dir, spec.jar)];
		case "argFile":
			return spec.files.map((file) => join(dir, file));
		case "script":
			return [join(dir, spec.path)];
	}
}
