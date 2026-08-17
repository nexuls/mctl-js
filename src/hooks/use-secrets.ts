/**
 * useSecrets — the Settings page's bridge to `core/config/secrets.ts`.
 *
 * UI-layer hook (AGENTS.md § 3). It holds the *summaries* (which keys exist, how
 * long, from where) and performs the two writes; the value being typed lives in
 * the page's own field state and is handed straight to `store`.
 *
 * **A secret is never part of the settings draft.** The draft is serialized for
 * dirty-checking and written into `config.json` on Save — a token has no business
 * anywhere near either. Stores happen immediately, like the theme and icon
 * pickers, and the field is cleared afterwards so the value does not sit on
 * screen.
 */

import { useCallback, useEffect, useState } from "react";
import {
	listSecrets,
	setSecret,
	unsetSecret,
	type SecretSummary,
} from "../core/config/secrets.ts";
import { useMctl } from "./use-mctl.tsx";

/** What {@link useSecrets} exposes. */
export interface UseSecrets {
	/** Every secret MCTL can see, values omitted. */
	secrets: SecretSummary[];
	/** True until the first read resolves. */
	loading: boolean;
	/** Store one secret. Resolves `null` on success, or the failure message. */
	store: (key: string, value: string) => Promise<string | null>;
	/** Remove one. Resolves `null`, or the failure message. */
	remove: (key: string) => Promise<string | null>;
}

/**
 * Read which secrets are set, and write them.
 *
 * There is no poll: `secrets.json` is only ever changed by a user, and both
 * writes here refresh the list themselves. A second instance's change shows up
 * on the next visit to the page — which is the honest cost of not watching a
 * file that holds credentials.
 */
export function useSecrets(): UseSecrets {
	const { context } = useMctl();
	const [secrets, setSecrets] = useState<SecretSummary[]>([]);
	const [loading, setLoading] = useState(true);

	// Network providers claim their own prefix (`NGROK_*`); `cloudflare` is added
	// for the DNS client, which is core's rather than a provider's.
	const consumers = [
		...(context?.providers.networkIds() ?? []),
		"cloudflare",
	].join(",");

	const refresh = useCallback(async () => {
		const found = await listSecrets(consumers.split(",")).catch(
			(): SecretSummary[] => [],
		);
		setSecrets(found);
		setLoading(false);
	}, [consumers]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const store = useCallback(
		async (key: string, value: string): Promise<string | null> => {
			try {
				await setSecret(key, value);
				await refresh();
				return null;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		},
		[refresh],
	);

	const remove = useCallback(
		async (key: string): Promise<string | null> => {
			try {
				await unsetSecret(key);
				await refresh();
				return null;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		},
		[refresh],
	);

	return { secrets, loading, store, remove };
}
