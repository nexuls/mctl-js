/**
 * Version listing — the read path behind every "which version?" picker.
 *
 * Core service (AGENTS.md § 3): it resolves a kind through the
 * {@link ProviderRegistry} and asks that provider what upstream publishes. No
 * UI, no argv, no concrete provider import. Both front-ends use it — the TUI's
 * create form and Settings through `hooks/use-server-versions.ts`, the CLI
 * through `mctl versions` — so neither holds knowledge the other lacks.
 *
 * Nothing is cached here. The HTTP layer (`lib/http.ts`) already ETag-caches
 * every upstream manifest into `~/.cache/mctl/api/`, so a second call inside the
 * TTL window costs one conditional GET and no parsing of a stale copy — a cache
 * in this module would be a second, dumber copy of that, and a mutable one at
 * that (architecture.md § the four load-bearing constraints).
 *
 * **The filtering functions are pure and exported** so the channel rules are
 * testable without a network, and so a front-end never re-implements them: a
 * picker that hides snapshots and a `--channel` flag must agree on what a
 * snapshot is.
 */

import type { VersionInfo } from "../../types/install.ts";
import type { ProviderRegistry } from "../registry/provider-registry.ts";

/** The release channel of a published version. See {@link VersionInfo.type}. */
export type VersionChannel = VersionInfo["type"];

/**
 * Every channel, in the order a UI should offer them: most stable first, so the
 * checkbox row reads release → snapshot → beta → alpha and a version list sorts
 * the same way whichever provider produced it.
 */
export const VERSION_CHANNELS: readonly VersionChannel[] = [
	"release",
	"snapshot",
	"beta",
	"alpha",
	"other",
];

/**
 * Human labels for the channels. Plural because they name a *set* of versions —
 * these are checkbox captions ("Snapshots"), not adjectives on one version.
 */
export const CHANNEL_LABELS: Record<VersionChannel, string> = {
	release: "Releases",
	snapshot: "Snapshots",
	beta: "Betas",
	alpha: "Alphas",
	other: "Other",
};

/**
 * The channels shown when the user has expressed no preference: stable releases
 * only. Everything else is opt-in, because Mojang's manifest alone carries ~900
 * versions of which ~120 are releases, and a picker that opens on a snapshot
 * from last Tuesday is a picker that installs one by accident.
 */
export const DEFAULT_CHANNELS: readonly VersionChannel[] = ["release"];

/**
 * Every version the given kind can install, newest first (the provider's own
 * order, which is upstream's).
 *
 * @param providers the registry the front-end built at startup.
 * @param kind the `kind` recorded in `mctl.json` — a server provider id.
 * @throws {UnknownProviderError} when this build has no such kind.
 * @throws {HttpError} when upstream is unreachable and nothing is cached.
 */
export async function listMinecraftVersions(
	providers: ProviderRegistry,
	kind: string,
): Promise<VersionInfo[]> {
	return providers.server(kind).minecraftVersions();
}

/**
 * Which channels actually occur in a version list, in {@link VERSION_CHANNELS}
 * order.
 *
 * Pure. A picker builds its filter row from this rather than from the full
 * vocabulary, because the answer is provider-specific and not knowable up front:
 * Mojang publishes all four channels, Fabric only two, and Purpur exactly one —
 * offering a "Betas" checkbox that can only ever hide nothing is noise.
 */
export function availableChannels(
	versions: readonly VersionInfo[],
): VersionChannel[] {
	const present = new Set(versions.map((v) => v.type));
	return VERSION_CHANNELS.filter((channel) => present.has(channel));
}

/**
 * Keep only the versions whose channel is in `channels`, preserving order.
 *
 * Pure. An empty `channels` yields an empty list rather than everything: the
 * caller unchecked every box, and silently showing all of them would contradict
 * what the boxes say.
 */
export function filterVersions(
	versions: readonly VersionInfo[],
	channels: Iterable<VersionChannel>,
): VersionInfo[] {
	const wanted = new Set(channels);
	return versions.filter((v) => wanted.has(v.type));
}
