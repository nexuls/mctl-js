/**
 * usePlayers — one server's player roster as render state, plus the moderation
 * actions the Players tab performs.
 *
 * UI-layer hook (AGENTS.md § 3): it calls `core/server/players.ts` and
 * `core/server/player-admin.ts` and holds the result as a **derived projection**,
 * never as truth. Every poll re-reads disk, so a ban issued from another MCTL
 * instance — or typed straight into the server console — shows up here without
 * anything being told about it (architecture.md § Statelessness).
 *
 * **Why it polls rather than subscribing.** The roster files are rewritten by
 * the *server*, not by MCTL, so there is no `events.jsonl` entry and no MCTL
 * watcher behind them; and who is online changes with no filesystem event at
 * all. Polling is the only honest option, and the poll is self-chaining so a
 * slow round on a large world never overlaps its successor.
 *
 * The online sample is **passed in** from the page's existing
 * `useServerInsight` rather than re-pinged here: one list ping per poll is
 * enough, and two would double the socket traffic to say the same thing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	readPlayers,
	type PlayerProfile,
	type PlayerRoster,
} from "../core/server/players.ts";
import {
	runPlayerAction,
	type PlayerActionId,
} from "../core/server/player-admin.ts";
import type { ServerInsight } from "../core/server/inspect.ts";
import type { Server } from "../types/server.ts";
import { useMctl } from "./use-mctl.tsx";

/** How often the roster is re-read. */
const POLL_MS = 5_000;

/** An empty roster, used before the first round and for an unavailable server. */
const EMPTY: PlayerRoster = {
	players: [],
	bannedIps: [],
	onlineUnnamed: 0,
	detailsTruncated: false,
};

/** What {@link usePlayers} exposes. */
export interface PlayersState {
	/** The composed roster; empty until the first round resolves. */
	roster: PlayerRoster;
	/** True until the first round resolves. */
	loading: boolean;
	/** Re-read now, without waiting for the next tick. */
	refresh: () => void;
	/**
	 * Perform an action on a player.
	 * @returns `null` on success, or the failure message — the same contract
	 *   `useConsole.send` uses, so the page toasts one or the other.
	 */
	act: (
		action: PlayerActionId,
		player: PlayerProfile,
		argument?: string,
	) => Promise<string | null>;
}

/**
 * Live player roster for one server.
 *
 * @param server the server view model, or `undefined` while it loads.
 * @param insight the current inspection, for the live online sample and the
 *   world name the `stats/` and `playerdata/` directories live under.
 */
export function usePlayers(
	server: Server | undefined,
	insight: ServerInsight | undefined,
): PlayersState {
	const { context } = useMctl();
	const [roster, setRoster] = useState<PlayerRoster>(EMPTY);
	const [loading, setLoading] = useState(true);
	const [nonce, setNonce] = useState(0);

	// The poll is keyed on what should restart it, not on the objects themselves:
	// `useServerInsight` hands back a new object every two seconds, and keying on
	// its identity would tear the poll down before a round could finish.
	const online = insight?.status?.sample ?? [];
	const signature = [
		server?.id ?? "",
		server?.state ?? "",
		insight?.status?.playersOnline ?? -1,
		online.map((player) => player.name).join(","),
	].join("|");

	const latest = useRef({ server, insight });
	latest.current = { server, insight };

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `signature`/`nonce` by design; see above.
	useEffect(() => {
		const current = latest.current.server;
		if (!current) return;
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const round = async () => {
			const status = latest.current.insight?.status;
			try {
				const next = await readPlayers(current, {
					online: status?.sample,
					onlineCount: status?.playersOnline,
					levelName: latest.current.insight?.properties?.levelName,
				});
				if (mounted) setRoster(next);
			} catch {
				// `readPlayers` is written not to throw; if it ever does, the previous
				// roster stays on screen rather than blanking the tab.
			}
			if (!mounted) return;
			setLoading(false);
			timer = setTimeout(() => void round(), POLL_MS);
		};

		void round();
		return () => {
			mounted = false;
			if (timer) clearTimeout(timer);
		};
	}, [signature, nonce]);

	const refresh = useCallback(() => setNonce((value) => value + 1), []);

	const act = useCallback(
		async (
			action: PlayerActionId,
			player: PlayerProfile,
			argument?: string,
		): Promise<string | null> => {
			if (!context || !server) return "core services are not ready yet";
			try {
				await runPlayerAction(context, server.id, action, player, argument);
				// The server rewrites its rosters a moment after the command lands, so
				// the immediate re-read would still show the old state; the next poll
				// picks it up either way, and this just shortens the wait.
				refresh();
				return null;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		},
		[context, server, refresh],
	);

	return { roster, loading, refresh, act };
}
