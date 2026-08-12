/**
 * VelocityProvider — Velocity, PaperMC's Minecraft **proxy**.
 *
 * A concrete provider over the shared `fill.ts` client. Two things make it
 * unlike every other kind MCTL installs, and both are visible in the UI:
 *
 *  - **Its versions are not Minecraft versions.** Velocity is versioned in its
 *    own right (`3.5.1`, `4.0.0`) and one build proxies many Minecraft versions,
 *    so `minecraftVersions()` here lists *Velocity* releases. A server created
 *    with `--mc 3.5.1` is therefore correct, not a mistake, and `mctl.json`'s
 *    `minecraftVersion` holds the proxy's version.
 *  - **It is not a Minecraft server.** It has no world, no `server.properties`
 *    (its config is `velocity.toml`, which it writes itself on first boot) and no
 *    players of its own — it forwards them. Inspection features that read a world
 *    or a roster will simply find nothing, which is the honest answer rather than
 *    an error.
 *
 * **`nogui` is deliberately not passed.** It exists to suppress Mojang's Swing
 * console; Velocity has none, and unknown arguments are not something to feed a
 * process that has its own argument parser. Hence the explicit empty list, which
 * `LaunchSpec` distinguishes from "unset ⇒ nogui".
 */

import { FillProvider } from "./fill.ts";

export class VelocityProvider extends FillProvider {
	readonly id = "velocity";
	readonly displayName = "Velocity";
	protected readonly project = "velocity";
	protected override readonly jarName = "velocity.jar";
	protected override readonly programArgs: string[] = [];
}
