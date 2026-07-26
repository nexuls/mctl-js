/**
 * Event system barrel + lifecycle. Wires the in-process {@link EventBus}, the
 * `events.jsonl` tail, and the hard-state watchers into one unit a front-end
 * starts once and stops on teardown.
 *
 * A running instance calls {@link startEventSystem} early (in `renderApp()` or a
 * long-lived CLI command), shares the returned `bus` with hooks/commands, and
 * calls `stop()` before exit. A one-shot CLI command that only reads and appends
 * can skip the tail/watchers entirely and use {@link publish} against a bare bus.
 */

export { EventBus, type EventListener } from "./bus.ts";
export { publish, startTail } from "./log.ts";
export { startWatchers } from "./watch.ts";
export { INSTANCE_ID } from "./instance.ts";

import { EventBus } from "./bus.ts";
import { startTail } from "./log.ts";
import { startWatchers } from "./watch.ts";
import { log } from "../../lib/logger.ts";

const logger = log("events");

/** A running event system: the shared bus and a single teardown function. */
export interface EventSystem {
  /** The in-process bus every hook/command subscribes to. */
  bus: EventBus;
  /** Stop the tail and watchers and drop all subscribers. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Start the full event system: create the bus, begin tailing `events.jsonl`, and
 * attach the hard-state watchers. Cross-instance events (from the tail) and local
 * file-change events (from the watchers) both land on the returned `bus`.
 *
 * Never throws for a missing directory — the tail and watchers ensure their
 * paths first. Call `stop()` before process exit.
 */
export async function startEventSystem(): Promise<EventSystem> {
  const bus = new EventBus();
  const stopTail = await startTail(bus);
  const stopWatchers = await startWatchers(bus);
  logger.debug("event system started (tail + watchers)");

  let stopped = false;
  return {
    bus,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      stopTail();
      stopWatchers();
      bus.clear();
      logger.debug("event system stopped");
    },
  };
}
