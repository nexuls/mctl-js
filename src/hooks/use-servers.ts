/**
 * useServers / useServer — adapt the core server-discovery read path to render
 * state, and keep it live via the event bus.
 *
 * These hooks embody statelessness in the UI (architecture.md § Statelessness):
 * they hold **no** authoritative server set. On mount, and on every relevant
 * event (registry change, a server's state change, config change), they *re-run*
 * the core `listServers`/`getServer` read path, which re-reads the registry,
 * re-parses each `mctl.json`, and re-probes liveness. What React holds is a
 * derived projection of disk, invalidated by events — never a cache treated as
 * truth.
 *
 * UI-layer hooks: they call core services (`loadConfig`, `listServers`) and the
 * bus; they never touch the filesystem or a provider directly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadConfig, resolveRootPaths } from "../core/config/index.ts";
import { listServers, getServer } from "../core/server/discover.ts";
import type { Server } from "../types/server.ts";
import { useEventBus } from "./use-event-bus.tsx";

/** Event types that invalidate the derived server projection. */
const INVALIDATING = new Set([
	"RegistryChanged",
	"ServerStateChanged",
	"ServerUnavailable",
	"ConfigChanged",
]);

/** The reactive result of a server read. */
export interface ServersResult<T> {
	/** The current derived data. */
	data: T;
	/** True until the first read resolves. */
	loading: boolean;
	/** A message when the read failed (e.g. config unreadable), else undefined. */
	error?: string;
	/** Force an immediate re-read. */
	refresh: () => void;
}

/** Resolve `config.servers_dir` for the current config. */
async function serversDir(): Promise<string> {
	return resolveRootPaths(await loadConfig()).serversDir;
}

/**
 * The live list of all servers, re-derived from disk on mount and whenever a
 * relevant event fires. Sorted by id (the read path sorts).
 */
export function useServers(): ServersResult<Server[]> {
	const bus = useEventBus();
	const [data, setData] = useState<Server[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const mounted = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const servers = await listServers(await serversDir());
			if (!mounted.current) return;
			setData(servers);
			setError(undefined);
		} catch (err) {
			if (!mounted.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const unsubscribe = bus.subscribe((event) => {
			if (INVALIDATING.has(event.type)) void refresh();
		});
		return () => {
			mounted.current = false;
			unsubscribe();
		};
	}, [bus, refresh]);

	return { data, loading, error, refresh: () => void refresh() };
}

/**
 * The live view model for one server by id, re-derived like {@link useServers}.
 * `data` is `undefined` when the id is unknown.
 */
export function useServer(id: string): ServersResult<Server | undefined> {
	const bus = useEventBus();
	const [data, setData] = useState<Server | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const mounted = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const server = await getServer(id, await serversDir());
			if (!mounted.current) return;
			setData(server);
			setError(undefined);
		} catch (err) {
			if (!mounted.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const unsubscribe = bus.subscribe((event) => {
			if (INVALIDATING.has(event.type)) void refresh();
		});
		return () => {
			mounted.current = false;
			unsubscribe();
		};
	}, [bus, refresh]);

	return { data, loading, error, refresh: () => void refresh() };
}
