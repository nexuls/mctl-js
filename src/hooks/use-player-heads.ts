/**
 * usePlayerHeads — the real skin face for each player on screen.
 *
 * UI-layer hook (AGENTS.md § 3): it calls `core/skins/` and holds the result as
 * a derived projection. The page never fetches anything itself.
 *
 * **Every head is optional and late.** A card renders immediately with the
 * deterministic built-in face `skinFor` picks, and swaps to the player's real
 * head if and when one arrives. That ordering is deliberate: a skin lookup is
 * three sequential HTTP requests in the worst case, and a grid that waited for
 * them would be blank for seconds on a server full of offline-mode players.
 *
 * **Each player is looked up once per session.** The roster is re-read every
 * five seconds and the resolver's own cache would absorb the repeats, but going
 * back to disk sixty times a minute for a face that cannot change is waste; the
 * `attempted` ref is what stops it. Lookups are also **capped and staggered** —
 * {@link MAX_CONCURRENT} at a time out of at most {@link MAX_LOOKUPS} players —
 * because a public server's roster runs to hundreds of names and firing them all
 * at once is how a source starts refusing MCTL's requests.
 */

import { useEffect, useRef, useState } from "react";
import { resolveHeadSkin } from "../core/skins/index.ts";
import type { PlayerProfile } from "../core/server/players.ts";
import type { HeadSkin } from "../types/skin.ts";

/** How many skin lookups may be in flight at once. */
const MAX_CONCURRENT = 4;

/**
 * The most players whose heads are fetched. Matches the spirit of the detail-read
 * cap in `core/server/players.ts`: a card past this point still gets a built-in
 * face, which is what it would have had anyway before this hook existed.
 */
const MAX_LOOKUPS = 64;

/**
 * Resolve real head faces for `players`, keyed by {@link PlayerProfile.key}.
 *
 * @param players the roster in display order — the head of the list is fetched
 *   first, so the players the user is looking at resolve first.
 * @param enabled set `false` to look nothing up (the tab is not visible, or the
 *   heads are not being drawn at this terminal width).
 */
export function usePlayerHeads(
	players: PlayerProfile[],
	enabled = true,
): Map<string, HeadSkin> {
	const [heads, setHeads] = useState<Map<string, HeadSkin>>(new Map());
	/** Keys already looked up this session, hit or miss. */
	const attempted = useRef(new Set<string>());
	const active = useRef(0);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Keyed on the *keys*, not the array: the roster is rebuilt on every poll, so
	// its identity changes constantly while its membership rarely does. Same rule
	// the Players tab follows for its selection.
	const signature = players
		.slice(0, MAX_LOOKUPS)
		.map((player) => player.key)
		.join("|");

	const latest = useRef(players);
	latest.current = players;

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `signature` by design; see above.
	useEffect(() => {
		if (!enabled) return;

		const pending = latest.current
			.slice(0, MAX_LOOKUPS)
			.filter((player) => !attempted.current.has(player.key));
		if (pending.length === 0) return;

		let cancelled = false;
		const queue = [...pending];

		const pump = async (): Promise<void> => {
			while (!cancelled) {
				const player = queue.shift();
				if (!player) return;
				attempted.current.add(player.key);
				const skin = await resolveHeadSkin({
					name: player.name,
					uuid: player.uuid,
				});
				if (cancelled || !mounted.current) return;
				// A miss records nothing: the card keeps its built-in face, and
				// `attempted` is what stops the next poll from asking again.
				if (skin) {
					setHeads((previous) => {
						const next = new Map(previous);
						next.set(player.key, skin);
						return next;
					});
				}
			}
		};

		const workers = Math.min(MAX_CONCURRENT - active.current, queue.length);
		for (let i = 0; i < workers; i += 1) {
			active.current += 1;
			void pump().finally(() => {
				active.current -= 1;
			});
		}

		return () => {
			cancelled = true;
		};
	}, [signature, enabled]);

	return heads;
}
