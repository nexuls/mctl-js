/**
 * useRecentEvents — a rolling buffer of the most recent events off the bus, for
 * the Dashboard's activity feed. The event log doubles as a recent-activity feed
 * (plan.md § Event System); this is its live UI projection.
 *
 * UI-layer hook: subscribes to the bus, holds only display state. No I/O.
 */

import { useEffect, useState } from "react";
import type { MctlEvent } from "../types/events.ts";
import { useEventBus } from "./use-event-bus.tsx";

/**
 * Keep the `limit` most-recent events (newest first). Both local and
 * cross-instance events arrive here, so the feed reflects activity from every
 * running `mctl` instance.
 */
export function useRecentEvents(limit = 20): MctlEvent[] {
  const bus = useEventBus();
  const [events, setEvents] = useState<MctlEvent[]>([]);

  useEffect(() => {
    return bus.subscribe((event) => {
      setEvents((prev) => [event, ...prev].slice(0, limit));
    });
  }, [bus, limit]);

  return events;
}
