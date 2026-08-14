/**
 * useServerVersions — the TUI's bridge to the version list a server kind can
 * install, plus the channel filter the user drives from a row of checkboxes.
 *
 * UI-layer hook (AGENTS.md § 3): it calls `core/server/versions.ts` and never
 * touches a provider or the network itself. Its CLI peer is `mctl versions`,
 * over the same core functions — the filtering rules live there precisely so the
 * two cannot disagree about what a "snapshot" is.
 *
 * **Loading is never blocking.** A version list is one or two HTTP round trips
 * (ETag-cached, but still a request), and a form that will not render until
 * Mojang answers is a form that is unusable offline. So the hook reports
 * `loading` / `error` as data and the field renders a picker that is simply
 * empty until the answer arrives — the caller's existing value always survives.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
	availableChannels,
	DEFAULT_CHANNELS,
	filterVersions,
	listMinecraftVersions,
	type VersionChannel,
} from "../core/server/versions.ts";
import type { VersionInfo } from "../types/install.ts";
import { useMctl } from "./use-mctl.tsx";

/** What {@link useServerVersions} exposes. */
export interface ServerVersionsState {
	/** The versions to offer, newest first — `all` filtered by {@link shown}. */
	versions: VersionInfo[];
	/** Everything upstream publishes for this kind, unfiltered. */
	all: VersionInfo[];
	/** The channels that actually occur in `all`, most stable first. */
	channels: VersionChannel[];
	/** The channels currently being shown. */
	shown: ReadonlySet<VersionChannel>;
	/** Show or hide one channel. */
	toggle: (channel: VersionChannel) => void;
	/** True while a fetch for the current kind is in flight. */
	loading: boolean;
	/** Why the list could not be fetched (offline, upstream down, unknown kind). */
	error?: string;
}

/**
 * Fetch the versions a kind can install, re-fetching when the kind changes.
 *
 * @param kind a server provider id (`"paper"`, `"fabric"`, …). `undefined` while
 * the form has not resolved one yet, which yields an empty, non-loading state.
 */
export function useServerVersions(
	kind: string | undefined,
): ServerVersionsState {
	const { context } = useMctl();
	const [all, setAll] = useState<VersionInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [shown, setShown] = useState<ReadonlySet<VersionChannel>>(
		() => new Set(DEFAULT_CHANNELS),
	);

	// Lists already fetched during this page's life, keyed by kind. A derived
	// projection of upstream metadata, not of MCTL state, so it is none of the
	// business of the statelessness rule — and it exists because switching the
	// Kind select back and forth otherwise blanks the version picker for a round
	// trip each time, which reads as the field flickering.
	const cache = useRef(new Map<string, VersionInfo[]>());

	useEffect(() => {
		if (!context || kind === undefined) return;

		const cached = cache.current.get(kind);
		if (cached) {
			setAll(cached);
			setError(undefined);
			setLoading(false);
			return;
		}

		// A kind switched while a fetch is in flight must not have the previous
		// kind's answer land on top of it.
		let current = true;
		setLoading(true);
		setError(undefined);
		listMinecraftVersions(context.providers, kind)
			.then((versions) => {
				cache.current.set(kind, versions);
				if (!current) return;
				setAll(versions);
				setLoading(false);
			})
			.catch((err: unknown) => {
				if (!current) return;
				setAll([]);
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [context, kind]);

	const channels = useMemo(() => availableChannels(all), [all]);
	const versions = useMemo(() => filterVersions(all, shown), [all, shown]);

	const toggle = (channel: VersionChannel) => {
		setShown((previous) => {
			const next = new Set(previous);
			if (!next.delete(channel)) next.add(channel);
			return next;
		});
	};

	return { versions, all, channels, shown, toggle, loading, error };
}
