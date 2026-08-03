/**
 * Shared setup and error reporting for the CLI commands that mutate or run
 * servers. The read-only commands (`list`, `status`) need only `loadConfig`;
 * everything from `create` onwards needs the whole object graph, and building it
 * in one place is what keeps a command a *bridge* rather than a second
 * implementation (AGENTS.md § 3).
 *
 * UI-free of OpenTUI; prints plain text and returns exit codes.
 */

import { ConfigNotFoundError } from "../core/config/index.ts";
import { createContext, type MctlContext } from "../core/context.ts";
import { createProviderRegistry } from "../providers/index.ts";
import { ArgError } from "./args.ts";

/**
 * Build the core context for a one-shot command.
 *
 * The bus is local-only (no tail, no watchers): a command that exits in a second
 * has nothing to gain from watching for other instances' changes, but `publish`
 * still appends to `events.jsonl`, so an open TUI reflects the change at once.
 * That asymmetry is the statelessness model working as intended.
 *
 * @throws {ConfigNotFoundError} when there is no config yet.
 */
export async function cliContext(): Promise<MctlContext> {
	return createContext(createProviderRegistry());
}

/**
 * Print a failure in the CLI's voice and return a non-zero exit code.
 *
 * `ConfigNotFoundError` is special-cased to steer a first-run user to
 * `mctl init` rather than showing them a path that does not exist. Everything
 * else prints its message; the typed errors thrown by core
 * (`ServerOperationError`, `UnknownProviderError`, `JavaNotResolvedError`,
 * `ResourceBusyError`, `ChecksumError`) are all written to be read by a user, so
 * there is nothing to translate.
 */
export function reportError(err: unknown): number {
	if (err instanceof ConfigNotFoundError) {
		console.error(
			"mctl: no config yet. Run `mctl init` (or launch `mctl` for the setup wizard).",
		);
		return 1;
	}
	if (err instanceof ArgError) {
		console.error(`mctl: ${err.message}`);
		return 2; // usage error, distinct from an operation that legitimately failed
	}
	console.error(`mctl: ${err instanceof Error ? err.message : String(err)}`);
	return 1;
}
