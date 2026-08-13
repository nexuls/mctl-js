/**
 * useNetworkOverview / useNetworkStatus — adapt `core/network/` to render state.
 *
 * UI-layer hooks (AGENTS.md § 3): they call `NetworkManager` through the shared
 * context and hold the result as a **derived projection**, never as truth. Every
 * value is re-derived from the tunnel descriptor plus a liveness probe on the
 * next tick, so two instances watching the same server agree without talking to
 * each other.
 *
 * **Why polled and not event-driven.** A tunnel agent can die at any moment with
 * no filesystem write and no event — that is exactly the case the status needs
 * to catch — so there is nothing to subscribe to. The poll is self-chaining
 * rather than a `setInterval`, because a readiness round spawns `tailscale
 * status` and a fixed interval would overlap rounds on a slow machine.
 *
 * Readiness is polled far more slowly than status: whether `cloudflared` is on
 * `$PATH` changes when the user installs it, not several times a minute, and
 * each round is a handful of `$PATH` walks plus a subprocess.
 */

import { useEffect, useRef, useState } from "react";
import type {
	ProfileSummary,
	ProviderReadiness,
} from "../core/network/index.ts";
import type { NetStatus } from "../types/network.ts";
import type { Server } from "../types/server.ts";
import { useMctl } from "./use-mctl.tsx";

/** How often a server's networking state is re-derived. */
const STATUS_INTERVAL_MS = 5_000;

/** How often provider readiness is re-checked. */
const READINESS_INTERVAL_MS = 30_000;

/** What {@link useNetworkOverview} exposes. */
export interface NetworkOverview {
	/** Every registered provider and whether it can be used right now. */
	providers: ProviderReadiness[];
	/** Every configured profile. */
	profiles: ProfileSummary[];
	/** True until the first round resolves. */
	loading: boolean;
	/** Set when the core context could not be built. */
	error?: string;
}

/** Provider readiness and the configured profiles, for the Network page. */
export function useNetworkOverview(): NetworkOverview {
	const { context, error } = useMctl();
	const [providers, setProviders] = useState<ProviderReadiness[]>([]);
	const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!context) return;
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const round = async () => {
			// `profiles()` is synchronous and cheap (it reads the loaded config), so
			// it is refreshed alongside readiness rather than on its own cadence.
			setProfiles(context.network.profiles());
			const next = await context.network.readiness().catch(() => []);
			if (!mounted) return;
			setProviders(next);
			setLoading(false);
			timer = setTimeout(() => void round(), READINESS_INTERVAL_MS);
		};
		void round();

		return () => {
			mounted = false;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [context]);

	return { providers, profiles, loading, error };
}

/**
 * One server's live networking state.
 *
 * @param server the server to watch, or `undefined` while it is still loading.
 */
export function useNetworkStatus(server: Server | undefined): {
	status?: NetStatus;
	loading: boolean;
} {
	const { context } = useMctl();
	const [status, setStatus] = useState<NetStatus | undefined>();
	const [loading, setLoading] = useState(true);

	// Keyed on the facts that change what the answer is, not on the object: the
	// server list rebuilds its view models on every refresh, so keying on identity
	// would restart the poll several times a second and never finish a round.
	const key = server
		? `${server.id}:${server.state}:${server.network}:${server.session?.port ?? ""}`
		: "";

	// The server is read through a ref so the effect can use the latest view model
	// without re-subscribing to it — `key` is what decides when a new poll is
	// warranted. Same shape as `use-server-insights`.
	const latest = useRef(server);
	latest.current = server;

	// `key` stands in for `server` on purpose (see above): keying the effect on the
	// object itself restarts the poll on every list refresh, so no round completes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Necessary
	useEffect(() => {
		if (!context || !latest.current) return;
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const round = async () => {
			const current = latest.current;
			if (!current) return;
			const next = await context.network.status(current).catch(() => undefined);
			if (!mounted) return;
			setStatus(next);
			setLoading(false);
			timer = setTimeout(() => void round(), STATUS_INTERVAL_MS);
		};
		void round();

		return () => {
			mounted = false;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [context, key]);

	return { status, loading };
}
