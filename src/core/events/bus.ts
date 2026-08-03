/**
 * EventBus — the in-process event tier (plan.md § Event System). A thin, typed
 * wrapper over EventEmitter3 that core services, providers, hooks, and CLI
 * commands use to emit and subscribe to {@link MctlEvent}s.
 *
 * Local only. Cross-instance delivery is the `events.jsonl` tier
 * (`core/events/log.ts`), which re-emits remote lines onto *this* bus — so a
 * subscriber handles a local event and a remote event identically. Publishing an
 * event to both tiers at once is `publish()` in `log.ts`; `emit()` here is
 * local-only (used for events derived from a file watch, which were already
 * logged by whichever instance caused them).
 *
 * No I/O, no domain knowledge — it only moves envelopes.
 */

import EventEmitter from "eventemitter3";
import type { MctlEvent } from "../../types/events.ts";

/** A subscriber to bus events. */
export type EventListener = (event: MctlEvent) => void;

/** The single channel every event travels on; subscribers filter by `type`. */
const CHANNEL = "event";

/**
 * A process-local publish/subscribe hub for {@link MctlEvent}s. One bus is
 * created per run in `renderApp()` / the CLI entry and shared by everything that
 * needs to react to state changes.
 */
export class EventBus {
	private readonly ee = new EventEmitter();

	/**
	 * Emit an event to all local subscribers. Does **not** write to `events.jsonl`
	 * — use `publish()` (`log.ts`) for a state change other instances must see.
	 */
	emit(event: MctlEvent): void {
		this.ee.emit(CHANNEL, event);
	}

	/**
	 * Subscribe to every event. Returns an unsubscribe function; call it on
	 * teardown (React effect cleanup, CLI command exit) to avoid leaks.
	 */
	subscribe(listener: EventListener): () => void {
		this.ee.on(CHANNEL, listener);
		return () => this.ee.off(CHANNEL, listener);
	}

	/** Drop all subscribers. Called during event-system teardown. */
	clear(): void {
		this.ee.removeAllListeners(CHANNEL);
	}
}
