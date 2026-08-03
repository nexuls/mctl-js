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
import { ForegroundRuntime } from "./runtime/foreground.ts";
import { PaperProvider } from "./server/paper.ts";
import { VanillaProvider } from "./server/vanilla.ts";

export { ForegroundRuntime, SessionNotOwnedError } from "./runtime/foreground.ts";
export { PaperProvider } from "./server/paper.ts";
export { VanillaProvider, VersionNotFoundError } from "./server/vanilla.ts";

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
  return new ProviderRegistry()
    .registerServer(new PaperProvider())
    .registerServer(new VanillaProvider())
    .registerRuntime(new ForegroundRuntime());
  // Phase 3: Fabric, Quilt, Forge, NeoForge, Purpur, Velocity; TmuxRuntime.
}
