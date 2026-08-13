/**
 * Local network address helpers.
 *
 * Leaf helper (`lib/`) — UI-free, provider-free, server-free. It reports what
 * this machine's interfaces say; it knows nothing about Minecraft ports or
 * tunnels. Anything to do with *exposing* a server (tunnels, DNS) belongs to a
 * network provider, not here.
 */

import { networkInterfaces } from "node:os";

/**
 * This machine's LAN IPv4 address — the one a player on the same network types
 * into their multiplayer screen — or `undefined` when there is no non-loopback
 * IPv4 interface (a container with only a loopback, an IPv6-only host).
 *
 * Interfaces are scanned in the order the OS reports them and the first
 * non-internal IPv4 wins. That is a heuristic, not a certainty: a host with both
 * Wi-Fi and a VPN has several plausible answers and the kernel's routing table
 * would be needed to pick the "right" one. Callers should present the result as
 * a suggested join address rather than as fact.
 */
export function lanAddress(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			// Node's types say `family` is the string "IPv4", but some releases
			// (and Bun, historically) report the number 4 — hence the widened
			// comparison rather than a plain equality against the typed value.
			const family = address.family as string | number;
			if ((family === "IPv4" || family === 4) && !address.internal) {
				return address.address;
			}
		}
	}
	return undefined;
}

/**
 * How long a discovered public address is reused before asking again. Home
 * connections do change address, but not on the timescale of a dashboard poll,
 * and the point of the cache is that a page refreshing every few seconds must
 * not become a few-second poll of somebody else's server.
 */
const PUBLIC_ADDRESS_TTL_MS = 10 * 60 * 1000;

/** How long to wait for the echo service before giving up. */
const PUBLIC_ADDRESS_TIMEOUT_MS = 2_500;

/**
 * Public-IP echo services, tried in order.
 *
 * Each returns the caller's address as a bare string with no JSON wrapper, which
 * is why these specific endpoints are used: parsing a one-line body needs no
 * schema and cannot half-succeed. A second host exists because the first one
 * being down must not turn "your public address" into a permanent blank.
 */
const PUBLIC_ADDRESS_SOURCES = [
	"https://api.ipify.org",
	"https://checkip.amazonaws.com",
];

let publicAddressCache: { value: string | undefined; at: number } | undefined;

/**
 * This machine's public IPv4 address as seen from the internet, or `undefined`
 * when it cannot be determined.
 *
 * **This necessarily involves an outside party.** A host cannot see its own
 * public address behind NAT — only a server on the far side of the NAT can
 * report it — so this asks an echo service, which learns this machine's IP in
 * the process. That is inherent to the question, but it is a network call the
 * caller should make deliberately: nothing in MCTL calls this on a timer, and
 * `direct` only asks when a profile has not turned it off.
 *
 * Never throws; a failure is `undefined`. Results (including failures) are
 * cached for ten minutes so a polling UI cannot turn into a request flood.
 */
export async function publicAddress(): Promise<string | undefined> {
	const now = Date.now();
	if (
		publicAddressCache &&
		now - publicAddressCache.at < PUBLIC_ADDRESS_TTL_MS
	) {
		return publicAddressCache.value;
	}

	for (const url of PUBLIC_ADDRESS_SOURCES) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(PUBLIC_ADDRESS_TIMEOUT_MS),
			});
			if (!response.ok) continue;
			const text = (await response.text()).trim();
			// Validated rather than trusted: an echo service that starts serving an
			// error page or a captive-portal redirect would otherwise be shown to the
			// user as their "public address".
			if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
				publicAddressCache = { value: text, at: now };
				return text;
			}
		} catch {
			// Timeout, DNS failure, offline machine — try the next source, then give up.
		}
	}
	publicAddressCache = { value: undefined, at: now };
	return undefined;
}

/** Drop the cached public address. Exists for tests; nothing in the app calls it. */
export function resetPublicAddressCache(): void {
	publicAddressCache = undefined;
}
