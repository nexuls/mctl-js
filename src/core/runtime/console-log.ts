/**
 * Reading the shared console capture — the half of "show me the logs" that is
 * identical for every runtime.
 *
 * Core service; no UI, no provider imports. Runtime providers differ in how they
 * *capture* a server's output (a pipe for the foreground runtime, `pipe-pane`
 * for tmux) and not at all in how it is read back, so the reader lives here and
 * they share it.
 *
 * **Why a file and not the process's pipe.** The capture lives at
 * `~/.local/state/mctl/console/<id>.log`, outside the server directory and
 * outside any one process — so `mctl logs` in a second terminal sees the same
 * output as the TUI, and a reader that attaches late still sees what was printed
 * before it arrived. Minecraft's own rolling `logs/` inside the server directory
 * remains the historical record; this file is the current run.
 */

import { readTextIfExists } from "../../lib/fs.ts";
import type { LogOptions } from "../../types/provider.ts";

/** How often the follower re-checks the capture file for new bytes. */
const FOLLOW_POLL_MS = 200;

/**
 * Yield the captured console output, optionally following it as it grows.
 *
 * @param file the capture file; a missing one yields nothing rather than throwing
 *   (a server that has never started has no console).
 * @param options `tail` to limit the replay, `follow` to keep reading, `signal`
 *   to stop.
 */
export async function* tailConsoleLog(
	file: string,
	options: LogOptions = {},
): AsyncIterable<string> {
	const existing = (await readTextIfExists(file)) ?? "";
	let offset = existing.length;

	const lines = existing.split("\n");
	// A trailing "" from the final newline is not a line.
	if (lines.at(-1) === "") lines.pop();
	const initial =
		options.tail === undefined ? lines : lines.slice(-options.tail);
	for (const line of initial) yield line;

	if (!options.follow) return;

	let carry = "";
	while (!options.signal?.aborted) {
		await Bun.sleep(FOLLOW_POLL_MS);
		const text = (await readTextIfExists(file)) ?? "";
		if (text.length < offset) {
			// The file was truncated — a new run started. Resume from its beginning.
			offset = 0;
			carry = "";
		}
		if (text.length === offset) continue;
		const chunk = carry + text.slice(offset);
		offset = text.length;
		const parts = chunk.split("\n");
		// The last part may be a partial line; hold it until its newline arrives.
		carry = parts.pop() ?? "";
		for (const line of parts) yield line;
	}
}
