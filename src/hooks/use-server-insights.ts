/**
 * useServerInsights / useServerInsight — adapt the core inspection read path
 * (`core/server/inspect.ts`) to render state, polled while the page is mounted.
 *
 * UI-layer hooks (AGENTS.md § 3): they call a core service and hold the result
 * as a **derived projection**, never as truth. Nothing here is authoritative —
 * every value is re-read from disk and re-probed on the next tick, so two
 * instances watching the same server converge without talking
 * (architecture.md § Statelessness).
 *
 * **Why a timer and not just the event bus.** CPU load, player counts, and
 * uptime change continuously with no filesystem event behind them, so unlike
 * `useServers` there is nothing to subscribe to; the only honest options are to
 * poll or to show nothing. The poll is self-chaining rather than a bare
 * `setInterval`: an inspection round takes ~250 ms (the CPU sample spans two
 * procfs readings), and a fixed interval would overlap rounds on a slow machine.
 *
 * **Two cadences, because the two tiers cost wildly different amounts.** The
 * cheap tier (properties, rosters, process sample, list ping) runs every few
 * seconds; the directory walk runs a couple of times a minute, since a world's
 * size does not meaningfully change in between and the walk is thousands of
 * syscalls.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
	inspectServer,
	measureSize,
	type ServerInsight,
	type ServerSize,
} from "../core/server/inspect.ts";
import type { Server } from "../types/server.ts";

/** How often the cheap tier re-inspects every server. */
const DEFAULT_INTERVAL_MS = 4_000;

/** How often the expensive directory walk is repeated. */
const DEFAULT_SIZE_INTERVAL_MS = 60_000;

/** Options for {@link useServerInsights}. */
export interface InsightOptions {
	/** Cheap-tier poll period in ms. */
	intervalMs?: number;
	/** Expensive-tier (directory walk) period in ms. */
	sizeIntervalMs?: number;
	/** Set false to skip the directory walk entirely. */
	sizes?: boolean;
}

/** What the insight hooks expose. */
export interface InsightsResult {
	/** Inspection per server id; a server missing from the map is not measured yet. */
	insights: Record<string, ServerInsight>;
	/** On-disk footprint per server id, from the slow tier. */
	sizes: Record<string, ServerSize>;
	/** True until the first inspection round resolves. */
	loading: boolean;
}

/**
 * A signature that changes only when something worth re-inspecting changed.
 *
 * `useServers` hands back a **new array of new objects on every refresh**, so an
 * effect keyed on the array identity would tear down and restart the poll
 * several times a second and never complete a round. Keying on the ids, states
 * and pids restarts the poll exactly when a server appears, disappears, starts,
 * or stops.
 */
function signatureOf(servers: Server[]): string {
	return servers
		.map((s) => `${s.id}:${s.state}:${s.session?.pid ?? ""}`)
		.join("|");
}

/**
 * Live inspection for a set of servers.
 *
 * @param servers the current server list (from `useServers`).
 */
export function useServerInsights(
	servers: Server[],
	options: InsightOptions = {},
): InsightsResult {
	const {
		intervalMs = DEFAULT_INTERVAL_MS,
		sizeIntervalMs = DEFAULT_SIZE_INTERVAL_MS,
		sizes: measureSizes = true,
	} = options;

	const [insights, setInsights] = useState<Record<string, ServerInsight>>({});
	const [sizes, setSizes] = useState<Record<string, ServerSize>>({});
	const [loading, setLoading] = useState(true);
	const signature = signatureOf(servers);

	// The effects below are keyed on the signature, but need the current server
	// objects to do the work — a ref keeps them out of the dependency list.
	const latest = useRef(servers);
	latest.current = servers;

	// biome-ignore lint/correctness/useExhaustiveDependencies: Necessary
	useEffect(() => {
		if (latest.current.length === 0) {
			setLoading(false);
			return;
		}
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const round = async () => {
			const results = await Promise.all(
				latest.current.map(async (server) => {
					try {
						return await inspectServer(server);
					} catch {
						// inspectServer is written not to throw; if it ever does, one bad
						// server must still not blank the whole table.
						return undefined;
					}
				}),
			);
			if (!mounted) return;
			setInsights((previous) => {
				const next: Record<string, ServerInsight> = {};
				for (const insight of results) if (insight) next[insight.id] = insight;
				// Keep a previous reading for a server that failed this round rather
				// than flickering its cells to "—" and back.
				for (const [id, insight] of Object.entries(previous)) {
					if (!next[id] && latest.current.some((s) => s.id === id)) {
						next[id] = insight;
					}
				}
				return next;
			});
			setLoading(false);
			// Self-chaining: the next round is scheduled only once this one landed.
			if (mounted) timer = setTimeout(() => void round(), intervalMs);
		};

		void round();
		return () => {
			mounted = false;
			if (timer) clearTimeout(timer);
		};
	}, [signature, intervalMs]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Necessary
	useEffect(() => {
		if (!measureSizes || latest.current.length === 0) return;
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const round = async () => {
			// Sequential on purpose: two concurrent walks of different worlds thrash
			// the disk queue and finish no sooner than one after the other.
			for (const server of latest.current) {
				if (!mounted) return;
				try {
					const size = await measureSize(server);
					if (size && mounted) {
						setSizes((previous) => ({ ...previous, [server.id]: size }));
					}
				} catch {
					// A vanished directory mid-walk: leave the previous figure.
				}
			}
			if (mounted) timer = setTimeout(() => void round(), sizeIntervalMs);
		};

		void round();
		return () => {
			mounted = false;
			if (timer) clearTimeout(timer);
		};
	}, [signature, sizeIntervalMs, measureSizes]);

	return { insights, sizes, loading };
}

/** What {@link useServerInsight} exposes for a single server. */
export interface InsightResult {
	/** The inspection, once the first round resolves. */
	insight?: ServerInsight;
	/** The on-disk footprint, once the slow tier resolves. */
	size?: ServerSize;
	/** True until the first inspection round resolves. */
	loading: boolean;
}

/**
 * Live inspection for one server — the detail page's view. Polls faster than the
 * list, since a page showing a CPU figure at 4-second granularity reads as
 * frozen.
 */
export function useServerInsight(
	server: Server | undefined,
	options: InsightOptions = {},
): InsightResult {
	const list = useMemo(() => (server ? [server] : []), [server]);
	const { insights, sizes, loading } = useServerInsights(list, {
		intervalMs: 2_000,
		...options,
	});
	return {
		insight: server ? insights[server.id] : undefined,
		size: server ? sizes[server.id] : undefined,
		loading,
	};
}
