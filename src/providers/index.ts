/**
 * Provider wiring — the **one** place concrete providers are named.
 *
 * This module sits at the outer edge on purpose: core resolves providers through
 * the `ProviderRegistry` and must never import `providers/*` itself, or the
 * dependency arrow reverses (AGENTS.md § 3). Both front-ends call
 * {@link createProviderRegistry} at startup and hand the result to core.
 *
 * Adding a provider is one `import` plus one `register*` call here — nothing in
 * `core/` changes.
 */

import { ProviderRegistry } from "../core/registry/provider-registry.ts";
import { CloudflaredNetwork } from "./network/cloudflared.ts";
import { DirectNetwork } from "./network/direct.ts";
import { NgrokNetwork } from "./network/ngrok.ts";
import { PlayitNetwork } from "./network/playit.ts";
import { TailscaleNetwork } from "./network/tailscale.ts";
import { ForegroundRuntime } from "./runtime/foreground.ts";
import { TmuxRuntime } from "./runtime/tmux.ts";
import { FabricProvider } from "./server/fabric.ts";
import { ForgeProvider } from "./server/forge.ts";
import { NeoForgeProvider } from "./server/neoforge.ts";
import { PaperProvider } from "./server/paper.ts";
import { PurpurProvider } from "./server/purpur.ts";
import { QuiltProvider } from "./server/quilt.ts";
import { VanillaProvider } from "./server/vanilla.ts";
import { VelocityProvider } from "./server/velocity.ts";

export {
	ForegroundRuntime,
	SessionNotOwnedError,
} from "./runtime/foreground.ts";
export { TmuxRuntime, TmuxUnavailableError } from "./runtime/tmux.ts";
export { FabricProvider } from "./server/fabric.ts";
export { ForgeProvider } from "./server/forge.ts";
export { NeoForgeProvider } from "./server/neoforge.ts";
export { PaperProvider } from "./server/paper.ts";
export { PurpurProvider } from "./server/purpur.ts";
export { QuiltProvider } from "./server/quilt.ts";
export { VanillaProvider } from "./server/vanilla.ts";
export { VelocityProvider } from "./server/velocity.ts";
export { VersionNotFoundError } from "./server/mojang-meta.ts";
export { CloudflaredNetwork } from "./network/cloudflared.ts";
export { DirectNetwork } from "./network/direct.ts";
export { NgrokNetwork } from "./network/ngrok.ts";
export { PlayitNetwork } from "./network/playit.ts";
export { TailscaleNetwork } from "./network/tailscale.ts";
// `TunnelStartError` moved to `types/network.ts`: core reports it, and core
// may not import anything under `providers/`.
export { TunnelStartError } from "../types/network.ts";

/**
 * Build the registry of providers this build ships.
 *
 * A fresh instance per process rather than a module singleton: the two
 * front-ends and every test build their own, and a global registry would be
 * exactly the kind of hidden shared state the rest of MCTL avoids.
 *
 * Registration order is the order the UI offers kinds in, so the most commonly
 * wanted server type comes first.
 */
export function createProviderRegistry(): ProviderRegistry {
	return (
		new ProviderRegistry()
			.registerServer(new PaperProvider())
			.registerServer(new VanillaProvider())
			.registerServer(new FabricProvider())
			.registerServer(new ForgeProvider())
			.registerServer(new NeoForgeProvider())
			.registerServer(new QuiltProvider())
			.registerServer(new PurpurProvider())
			// Velocity is a proxy rather than a server, so it comes last: it is the
			// one kind a user picking "a Minecraft server" does not want.
			.registerServer(new VelocityProvider())
			.registerRuntime(new ForegroundRuntime())
			.registerRuntime(new TmuxRuntime())
			// `direct` first and always: it is the default profile and the fallback
			// every other network provider degrades to, so it must be registered
			// whatever else is or is not available on this machine.
			.registerNetwork(new DirectNetwork())
			.registerNetwork(new CloudflaredNetwork())
			.registerNetwork(new PlayitNetwork())
			.registerNetwork(new NgrokNetwork())
			.registerNetwork(new TailscaleNetwork())
	);
	// Phase 5: DockerRuntime.
}
