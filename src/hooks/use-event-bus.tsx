/**
 * useEventBus — makes the process-wide {@link EventBus} available to the React
 * tree. `renderApp()` starts the event system (bus + `events.jsonl` tail + file
 * watchers) and injects the bus here; hooks subscribe to react to local and
 * cross-instance state changes uniformly.
 *
 * UI-layer adapter — it only hands out the bus created by core. No I/O here.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { EventBus } from "../core/events/index.ts";

const EventBusContext = createContext<EventBus | undefined>(undefined);

/** Props for {@link EventBusProvider}. */
interface EventBusProviderProps {
	/** The bus created by `startEventSystem()` in `renderApp()`. */
	bus: EventBus;
	children: ReactNode;
}

/** Provide the shared event bus to the tree. */
export function EventBusProvider({ bus, children }: EventBusProviderProps) {
	return (
		<EventBusContext.Provider value={bus}>{children}</EventBusContext.Provider>
	);
}

/** Access the shared event bus. Throws if used outside an {@link EventBusProvider}. */
export function useEventBus(): EventBus {
	const ctx = useContext(EventBusContext);
	if (!ctx)
		throw new Error("useEventBus must be used within an EventBusProvider");
	return ctx;
}
