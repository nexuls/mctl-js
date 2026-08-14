/**
 * useServerContent — one server's installed mods, plugins and datapacks as
 * render state, plus the enable/disable action the Content tab performs.
 *
 * UI-layer hook (AGENTS.md § 3): it calls `core/server/content.ts` and holds the
 * result as a **derived projection**, never as truth. Every round re-reads the
 * directories, so a jar dropped in by hand — or parked from another MCTL
 * instance, or by the CLI's `mctl content disable` — shows up here without
 * anything being told about it (architecture.md § Statelessness).
 *
 * **Why it polls, and why slowly.** `mods/` is written by the user and by
 * launchers, not by MCTL, so there is no `events.jsonl` entry behind a change and
 * nothing to subscribe to. But a round opens every archive in the directory, so
 * it runs at a fraction of the inspection tier's rate; a toggle refreshes
 * immediately rather than waiting for the tick.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	readServerContent,
	setContentEnabled,
	type ContentItem,
	type ServerContentListing,
} from "../core/server/content.ts";
import type { Server } from "../types/server.ts";
import { useMctl } from "./use-mctl.tsx";

/** How often the directories are re-read. */
const POLL_MS = 15_000;

/** Empty listing, used before the first round and for an unavailable server. */
const EMPTY: ServerContentListing = { id: "", sections: [] };

/** What {@link useServerContent} exposes. */
export interface ServerContentState {
	/** The listing; empty until the first round resolves. */
	listing: ServerContentListing;
	/** True until the first round resolves. */
	loading: boolean;
	/** Re-read now, without waiting for the next tick. */
	refresh: () => void;
	/**
	 * Enable or disable one item.
	 * @returns `null` on success, or the failure message — the same contract
	 *   `usePlayers.act` and `useConsole.send` use, so the page toasts one or the
	 *   other.
	 */
	toggle: (item: ContentItem, enabled: boolean) => Promise<string | null>;
}

/**
 * Live installed-content listing for one server.
 *
 * @param server the server view model, or `undefined` while it loads.
 * @param levelName the active world, for the datapack directory; from
 *   `server.properties` via the page's existing inspection.
 */
export function useServerContent(
	server: Server | undefined,
	levelName: string | undefined,
): ServerContentState {
	const [listing, setListing] = useState<ServerContentListing>(EMPTY);
	const [loading, setLoading] = useState(true);
	const [nonce, setNonce] = useState(0);

	// The registry answers "does this kind take mods at all?", which is a property
	// of the provider and not of the directory. It arrives with the core context,
	// so it is `undefined` for the first render or two — hence its presence in the
	// signature below: the round that ran without it must be redone, or the tab
	// would spend its life showing sections the kind cannot load.
	const providers = useMctl().context?.providers;

	// Keyed on what should restart the poll, not on the view model itself: the
	// page hands back a fresh `server` object every couple of seconds, and keying
	// on its identity would tear a round down before it could finish.
	const signature = `${server?.id ?? ""}|${server?.available ?? ""}|${levelName ?? ""}|${providers ? "1" : "0"}`;
	const latest = useRef({ server, levelName, providers });
	latest.current = { server, levelName, providers };

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `signature`/`nonce` by design; see above.
	useEffect(() => {
		const current = latest.current.server;
		if (!current) return;
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const round = async () => {
			try {
				const next = await readServerContent(
					current,
					latest.current.levelName ?? "world",
					latest.current.providers,
				);
				if (mounted) setListing(next);
			} catch {
				// `readServerContent` is written not to throw; if it ever does, the
				// previous listing stays on screen rather than blanking the tab.
			}
			if (!mounted) return;
			setLoading(false);
			// Self-chaining: a directory of a hundred jars must never overlap itself.
			timer = setTimeout(() => void round(), POLL_MS);
		};

		void round();
		return () => {
			mounted = false;
			if (timer) clearTimeout(timer);
		};
	}, [signature, nonce]);

	const refresh = useCallback(() => setNonce((value) => value + 1), []);

	const toggle = useCallback(
		async (item: ContentItem, enabled: boolean): Promise<string | null> => {
			if (!server) return "the server is not loaded yet";
			try {
				await setContentEnabled(server, item, enabled);
				refresh();
				return null;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		},
		[server, refresh],
	);

	return { listing, loading, refresh, toggle };
}
