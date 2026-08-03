/**
 * useConsole — a live tail of one server's console output, plus a way to send
 * commands to it.
 *
 * UI-layer hook: it drives `RuntimeManager.logs()` / `.exec()` and holds the
 * resulting lines as render state. The lines are a *derived projection* of the
 * shared capture file (`~/.local/state/mctl/console/<id>.log`), not authoritative
 * state — closing and reopening the page re-reads them from disk, and a `mctl
 * logs -f` in another terminal shows exactly the same stream.
 *
 * The buffer is capped at {@link MAX_LINES}: a server left running overnight
 * produces far more output than a terminal can scroll through, and an unbounded
 * array would grow until the process died.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMctl } from "./use-mctl.tsx";

/** How many console lines to keep in memory. Older lines fall off the top. */
const MAX_LINES = 2000;

/** What {@link useConsole} exposes. */
export interface ConsoleState {
  /** The captured lines, oldest first, capped at {@link MAX_LINES}. */
  lines: string[];
  /** A message when the stream could not be opened. */
  error?: string;
  /**
   * Send one line to the server's console.
   * @returns `null` on success, or the failure message (e.g. the server is not
   *   running, or this instance does not own a foreground session).
   */
  send: (command: string) => Promise<string | null>;
}

/**
 * Follow a server's console.
 *
 * @param id server id; an empty id yields an idle hook (no stream opened).
 */
export function useConsole(id: string): ConsoleState {
  const { context } = useMctl();
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  // Batched between paints: a starting server emits hundreds of lines in a
  // second, and one `setState` per line would re-render the page just as often.
  const pending = useRef<string[]>([]);

  useEffect(() => {
    if (!context || id === "") return;
    setLines([]);
    pending.current = [];
    const controller = new AbortController();

    const flush = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((previous) => [...previous, ...batch].slice(-MAX_LINES));
    }, 100);

    void (async () => {
      try {
        const stream = await context.runtime.logs(id, {
          follow: true,
          signal: controller.signal,
        });
        for await (const line of stream) {
          if (controller.signal.aborted) break;
          pending.current.push(line);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      controller.abort();
      clearInterval(flush);
    };
  }, [context, id]);

  const send = useCallback(
    async (command: string): Promise<string | null> => {
      if (!context) return "core services are not ready yet";
      try {
        await context.runtime.exec(id, command);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [context, id],
  );

  return { lines, error, send };
}
