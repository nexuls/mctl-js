/**
 * The cross-instance event log tier: append to `events.jsonl` and tail it
 * (plan.md § Event System, architecture.md § Statelessness). This is what keeps
 * multiple `mctl` instances consistent with **no IPC, no daemon, no leader** —
 * every instance appends its state changes as one JSON line and tails the log to
 * pick up everyone else's.
 *
 * Core service — no UI, no providers. Depends only on `lib/` (paths, fs, logger),
 * the Zod schema in `types/events.ts`, the process {@link INSTANCE_ID}, and the
 * {@link EventBus} it feeds.
 *
 * **`publish` = append + emit local.** A state-changing action calls `publish`,
 * which writes the line (so other instances see it) *and* emits it on the local
 * bus (so this instance reacts immediately). The tail then skips lines whose
 * `instance` is our own, so we never double-process our own events.
 */

import { open, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { eventsLogFile } from "../../lib/paths.ts";
import { appendLine, ensureDir } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { MctlEvent, type EventType } from "../../types/events.ts";
import { INSTANCE_ID } from "./instance.ts";
import type { EventBus } from "./bus.ts";

const logger = log("events");

/** How often the tail re-checks the log, as a fallback for missed watch events. */
const POLL_MS = 1000;

/**
 * Publish a state change: append it to `events.jsonl` (for other instances) and
 * emit it on the local bus (for this one). The envelope's `id`, `ts`, `instance`,
 * and `v` are filled in here; callers pass only `type` and `payload`.
 *
 * Secrets must be redacted *before* calling this — the payload is written to disk
 * verbatim (AGENTS.md § Secrets).
 */
export async function publish(
  bus: EventBus,
  type: EventType,
  payload?: unknown,
): Promise<void> {
  const event: MctlEvent = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    instance: INSTANCE_ID,
    type,
    payload,
  };
  // Emit locally first so the originating instance reacts without waiting on the
  // disk write; then persist for everyone else. A failed append still leaves the
  // local UI consistent.
  bus.emit(event);
  await appendLine(eventsLogFile(), JSON.stringify(event));
}

/** The current byte length of the log, or 0 when it does not exist yet. */
async function currentSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Read `[from, to)` bytes of `file` as UTF-8. */
async function readRange(
  file: string,
  from: number,
  to: number,
): Promise<string> {
  const fh = await open(file, "r");
  try {
    const length = to - from;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Start tailing `events.jsonl` from its current end, re-emitting each *remote*
 * line (an event from another instance) onto the local bus. History before the
 * start point is not replayed — the log doubles as a recent-activity feed, but
 * the tail's job is live sync, not backfill.
 *
 * Robustness: an `fs.watch` gives immediacy, and a {@link POLL_MS} timer covers
 * platforms/editors where a watch misses an append or the file is rotated
 * (truncation is detected by the size shrinking, and the offset resets).
 *
 * @returns a stop function that closes the watcher and clears the timer.
 */
export async function startTail(bus: EventBus): Promise<() => void> {
  const file = eventsLogFile();
  await ensureDir(dirname(file));
  // Ensure the file exists so `fs.watch` can attach to it directly.
  await (await open(file, "a")).close();

  let offset = await currentSize(file);
  let buffer = "";
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return; // serialize; a watch + poll can fire together
    draining = true;
    try {
      const size = await currentSize(file);
      if (size < offset) {
        // The log was truncated/rotated — restart from the top.
        offset = 0;
        buffer = "";
      }
      if (size > offset) {
        buffer += await readRange(file, offset, size);
        offset = size;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          emitRemoteLine(bus, line);
          nl = buffer.indexOf("\n");
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "event log tail read failed");
    } finally {
      draining = false;
    }
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(file, () => void drain());
  } catch (err) {
    // Non-fatal: the poll below still delivers cross-instance events.
    logger.debug(
      { err: String(err) },
      "fs.watch on events.jsonl unavailable; polling only",
    );
  }
  const timer = setInterval(() => void drain(), POLL_MS);

  return () => {
    watcher?.close();
    clearInterval(timer);
  };
}

/** Parse one log line and, if it is another instance's event, emit it locally. */
function emitRemoteLine(bus: EventBus, line: string): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    logger.warn("skipping malformed event log line");
    return;
  }
  const parsed = MctlEvent.safeParse(raw);
  if (!parsed.success) {
    logger.warn("skipping event log line that failed validation");
    return;
  }
  // Our own events were already emitted locally by `publish` — skip them so we
  // don't double-process.
  if (parsed.data.instance === INSTANCE_ID) return;
  bus.emit(parsed.data);
}
