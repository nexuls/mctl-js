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
